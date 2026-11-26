/**
 * Camera mapping, part 2: reading the coded sequence back from video frames.
 *
 * Frames are pushed in time order as they arrive (greyscale, one byte per picture pixel), so a phone
 * never has to hold the whole film in memory:
 *
 * 1. Timing. Every frame is boiled down to one number (the sum of 8×8-cell maxima, which rises when
 *    lights come on and ignores most of the background). The preamble's on/off code is slid along
 *    that signal; the best match gives the sequence's start on the phone's clock. Only a rough guess
 *    (from the server clock) is needed beforehand.
 * 2. Slots. Each frame is assigned to the slot it shows; frames near a slot change (blurred or caught
 *    half-way by the rolling shutter) are skipped.
 * 3. Spots. Per pass, the reference frame minus the background frame shows where that pass's lights
 *    are. Pixels that rise clearly are grouped into connected spots. From then on only those pixels
 *    are kept from each bit frame.
 * 4. Codes, pixel by pixel. Each spot pixel compares every bit frame with its inverse, relative to
 *    its own on/off swing. A spot that is one light reads one code (from its summed pixels, as
 *    before). A spot that is several lights touching shows a different code in each part, so each
 *    code's pixels become a light of their own, checked again on their sums. A reflection on the
 *    floor or rail mixes several lights' codes, so its pixels read no clear code and it is ignored.
 * 5. Checks. A light is kept only if all its bits are clear, its parity is right and its code is in
 *    use. Codes have even parity, so any two differ in at least two bits: one bit whose two frames
 *    showed no difference at all (the lights missed that change) can be restored from the parity,
 *    while two lights mixed together always leave at least two bits unclear.
 */
import { decodeWord, PREAMBLE_SLOTS, slotLevels, type MappingPlan } from './sequence.js';

export interface DecoderOptions {
  width: number;
  height: number;
  /** Best guess (frame clock, ms) of when the first slot starts. */
  startGuessMs: number;
  /** How far the true start may be from the guess, ms. */
  searchMs?: number;
  /** Smallest bit margin (0..1) to accept a code. */
  minMargin?: number;
  /** Smallest brightness rise (0..255) for a spot. */
  minRise?: number;
  /** Largest spot in picture pixels; bigger ones are glare, not a few lights. */
  maxBlobArea?: number;
}

export interface Detection {
  pixel: number;
  /** Weighted centre in picture pixels. */
  x: number;
  y: number;
  /** Summed brightness rise over the light's pixels. */
  strength: number;
  /** Weakest bit margin, 0..1. */
  margin: number;
  area: number;
  pass: number;
}

export interface DecodeStats {
  frames: number;
  framesUsed: number;
  syncScore: number;
  offsetMs: number;
  /** Bright spots examined (all passes). */
  blobs: number;
  /** Lights read (after duplicates). */
  decoded: number;
  /** Spots that were two or more lights touching, each read on its own. */
  split: number;
  /** Lights read with one bit restored from the parity (the lights missed that change). */
  repaired: number;
  /** Dim spots with no readable code: reflections and glints, ignored. */
  faint: number;
  /** Brighter spots with no readable code (lights blurred together, reflections). */
  unclear: number;
  badParity: number;
  badCode: number;
  /** Spots too big to be lights (glare). */
  tooBig: number;
  duplicates: number;
  missingSlots: number;
}

export interface DecodeResult {
  ok: boolean;
  error?: string;
  /** Start of the first slot on the frame clock (ms), as found from the preamble. */
  startMs: number | null;
  detections: Detection[];
  stats: DecodeStats;
  /** A small greyscale picture of the first pass's reference frame, for showing the result. */
  thumbnail?: { width: number; height: number; data: Uint8Array; /** Decoder pixels per thumbnail pixel. */ scale: number };
}

/** A pass's bright spots: their pixels, grouped by spot, with each pixel's reference brightness. */
export interface Spots {
  /** Picture index of each spot pixel; spot s owns px[start[s]] .. px[start[s + 1] - 1]. */
  px: Int32Array;
  start: Int32Array;
  on: Float32Array;
  off: Float32Array;
  /** The rise threshold used. */
  thr: number;
  /** Spots dropped for being too big. */
  tooBig: number;
  /** Specks smaller than a light, left out. */
  specks: number;
  /** Pixels showing one code needed to read that part of a spot as a light of its own. */
  minPart: number;
}

interface PassState {
  off: Float32Array | null; offN: number;
  on: Float32Array | null; onN: number;
  spots: Spots | null;
  /** Per slot index: the spot pixels' values in each frame. */
  samples: Map<number, Uint8Array[]>;
}

interface Found extends Detection { peak: number; repaired: boolean }

const CELL = 8;

export class MappingDecoder {
  readonly w: number;
  readonly h: number;
  private readonly hold: number;
  private readonly search: number;
  private readonly levels: number[];
  private readonly opts: Required<Omit<DecoderOptions, 'width' | 'height' | 'startGuessMs' | 'searchMs'>>;
  private signal: { t: number; s: number }[] = [];
  private pending: { t: number; lum: Uint8Array }[] = [];
  private start: number | null = null;
  private syncScore = 0;
  private passes: PassState[];
  private frames = 0;
  private used = 0;
  private lastT = -Infinity;
  private thumb: DecodeResult['thumbnail'];
  private failed: string | null = null;

  constructor(readonly plan: MappingPlan, private readonly o: DecoderOptions) {
    this.w = o.width; this.h = o.height;
    this.hold = plan.params.holdMs;
    this.search = o.searchMs ?? 800;
    this.levels = slotLevels(plan);
    // A spot may hold a few touching lights (each read on its own), so the limit is generous: 1/600 of the picture.
    this.opts = { minMargin: o.minMargin ?? 0.3, minRise: o.minRise ?? 18, maxBlobArea: o.maxBlobArea ?? Math.max(240, (o.width * o.height) / 600) };
    this.passes = plan.passes.map(() => ({ off: null, offN: 0, on: null, onN: 0, spots: null, samples: new Map() }));
  }

  get synced() { return this.start !== null; }
  get startMs() { return this.start; }

  /** Add a frame (t in ms on the frame clock). The decoder keeps the array; don't reuse it. */
  push(t: number, lum: Uint8Array) {
    if (lum.length !== this.w * this.h) throw new Error('frame size does not match');
    if (t <= this.lastT) return; // out of order or repeated
    this.lastT = t;
    this.frames++;
    const preambleEnd = this.o.startGuessMs + PREAMBLE_SLOTS * this.hold;
    if (this.start === null) {
      if (t <= preambleEnd + this.search + this.hold) this.signal.push({ t, s: cellSignal(lum, this.w, this.h) });
      if (t >= preambleEnd - this.search - this.hold) this.pending.push({ t, lum });
      if (t >= preambleEnd + this.search + 2 * this.hold) this.sync();
      return;
    }
    this.take(t, lum);
  }

  /** Find the start from the preamble, then process the frames held back meanwhile. */
  private sync() {
    const found = findStart(this.signal, this.levels, this.hold, this.o.startGuessMs, this.search);
    this.syncScore = found.score;
    if (found.score < 0.5) this.failed = 'the lights’ flashing wasn’t clear in the picture (are they in view, and is streaming on?)';
    this.start = found.start;
    const pend = this.pending;
    this.pending = [];
    for (const f of pend) this.take(f.t, f.lum);
  }

  private take(t: number, lum: Uint8Array) {
    const rel = t - this.start!;
    const slot = Math.floor(rel / this.hold);
    if (slot < PREAMBLE_SLOTS || slot >= this.plan.slots.length) return;
    const phase = rel - slot * this.hold;
    const s = this.plan.slots[slot]!;
    // Skip frames near a change: blur, rolling shutter and timing error live there.
    const guard = s.kind === 'ref-on' || s.kind === 'ref-off' ? 0.3 * this.hold : 0.24 * this.hold;
    if (phase < guard || phase > this.hold - guard) return;
    if (s.pass === undefined) return;
    const ps = this.passes[s.pass]!;
    this.used++;
    if (s.kind === 'ref-off' || s.kind === 'ref-on') {
      const key = s.kind === 'ref-off' ? 'off' : 'on';
      const acc = ps[key] ?? (ps[key] = new Float32Array(lum.length));
      for (let i = 0; i < lum.length; i++) acc[i]! += lum[i]!;
      if (key === 'off') ps.offN++; else { ps.onN++; if (!this.thumb && s.pass === 0) this.thumb = thumbnail(lum, this.w, this.h); }
      return;
    }
    if (!ps.spots) this.findSpots(ps);
    const px = ps.spots!.px;
    const v = new Uint8Array(px.length);
    for (let k = 0; k < px.length; k++) v[k] = lum[px[k]!]!;
    let list = ps.samples.get(slot);
    if (!list) ps.samples.set(slot, (list = []));
    list.push(v);
  }

  private findSpots(ps: PassState) {
    if (!ps.on || !ps.off || !ps.onN || !ps.offN) { ps.spots = emptySpots(); return; }
    const on = ps.on, off = ps.off;
    for (let i = 0; i < on.length; i++) { on[i]! /= ps.onN; off[i]! /= ps.offN; }
    ps.spots = findSpots(on, off, this.w, this.h, this.opts.minRise, this.opts.maxBlobArea);
    ps.on = ps.off = null; // done with the full pictures
  }

  finish(): DecodeResult {
    if (this.start === null && this.signal.length) this.sync();
    const stats: DecodeStats = {
      frames: this.frames, framesUsed: this.used, syncScore: round(this.syncScore, 3), offsetMs: this.start === null ? 0 : round(this.start - this.o.startGuessMs, 1),
      blobs: 0, decoded: 0, split: 0, repaired: 0, faint: 0, unclear: 0, badParity: 0, badCode: 0, tooBig: 0, duplicates: 0, missingSlots: 0,
    };
    if (this.start === null) return { ok: false, error: 'no frames from the sequence were recorded', startMs: null, detections: [], stats };
    const found: Found[] = [];
    const bits = this.plan.bits;
    this.plan.passes.forEach((pass, p) => {
      const ps = this.passes[p]!;
      if (!ps.spots) this.findSpots(ps);
      const sp = ps.spots!;
      stats.tooBig += sp.tooBig; stats.faint += sp.specks;
      // Slot index of each bit frame and its inverse.
      const slotOf = (kind: 'bit' | 'bit-inv', bit: number) => this.plan.slots.findIndex((s) => s.kind === kind && s.pass === p && s.bit === bit);
      const frames: [Float32Array | null, Float32Array | null][] = [];
      for (let b = 0; b <= bits; b++) {
        const a = medianOf(ps.samples.get(slotOf('bit', b))), c = medianOf(ps.samples.get(slotOf('bit-inv', b)));
        if (!a) stats.missingSlots++;
        if (!c) stats.missingSlots++;
        frames.push([a, c]);
      }
      ps.samples.clear();
      const r = readSpots(sp, frames, bits, pass.pixels.length, this.w, this.opts.minMargin);
      for (const d of r.found) found.push({ ...d, pixel: pass.pixels[d.pixel - 1]!, pass: p });
      stats.blobs += r.spots; stats.split += r.split; stats.faint += r.faint; stats.unclear += r.unclear; stats.badParity += r.badParity; stats.badCode += r.badCode;
    });
    const detections = resolveDuplicates(found, stats);
    stats.repaired = detections.filter((d) => d.repaired).length;
    const out: Detection[] = detections.map((d) => ({ pixel: d.pixel, x: round(d.x, 2), y: round(d.y, 2), strength: Math.round(d.strength), margin: round(Math.min(1, d.margin), 3), area: d.area, pass: d.pass }));
    out.sort((a, b) => a.pixel - b.pixel);
    stats.decoded = out.length;
    const error = this.failed ?? (out.length === 0 ? 'no lights could be read in this view' : undefined);
    return { ok: !this.failed && out.length > 0, ...(error && { error }), startMs: this.start, detections: out, stats, thumbnail: this.thumb };
  }
}

/**
 * The same code found twice: one light split in two (close together) is merged; otherwise one is a
 * reflection, which is dimmer and more spread out, so a clearly brighter peak (or clearly more light
 * overall) wins. If neither is clear, all are dropped.
 */
function resolveDuplicates(found: Found[], stats: DecodeStats): Found[] {
  const byPixel = new Map<number, Found[]>();
  for (const d of found) { const l = byPixel.get(d.pixel); if (l) l.push(d); else byPixel.set(d.pixel, [d]); }
  const out: Found[] = [];
  for (const list of byPixel.values()) {
    if (list.length === 1) { out.push(list[0]!); continue; }
    list.sort((a, b) => b.strength - a.strength);
    const top = list[0]!;
    if (list.every((d) => Math.hypot(d.x - top.x, d.y - top.y) < 6)) {
      const sw = list.reduce((a, d) => a + d.strength, 0);
      out.push({ ...top, x: list.reduce((a, d) => a + d.x * d.strength, 0) / sw, y: list.reduce((a, d) => a + d.y * d.strength, 0) / sw, strength: sw, area: list.reduce((a, d) => a + d.area, 0), margin: Math.min(...list.map((d) => d.margin)), peak: Math.max(...list.map((d) => d.peak)) });
      continue;
    }
    stats.duplicates += list.length - 1;
    const byStrength = top.strength >= 2.5 * list[1]!.strength ? top : null;
    const peaks = [...list].sort((a, b) => b.peak - a.peak);
    const byPeak = peaks[0]!.peak >= 1.5 * peaks[1]!.peak ? peaks[0]! : null;
    const pick = byStrength && byPeak && byStrength !== byPeak ? null : byStrength ?? byPeak;
    if (pick) out.push(pick); else stats.duplicates++;
  }
  return out;
}

/** A word read from bit frames: the weakest clear bit's margin, and whether one bit was restored from the parity. */
interface Reading { word: number; margin: number; repaired: boolean }

/**
 * Read a code from summed values: on/off levels and, per bit, the bit frame (a) and its inverse (c),
 * either of which may be missing (NaN). A bit whose two frames barely differ (under half the smallest
 * margin) is taken as lost; one lost bit is restored from the parity, two or more make it unclear.
 */
function readWord(on: number, off: number, a: Float64Array, c: Float64Array, bits: number, minMargin: number): Reading {
  const swing = on - off;
  if (!(swing > 0)) return { word: 0, margin: 0, repaired: false };
  let word = 0, margin = 1, lost = -1, nLost = 0;
  for (let b = 0; b <= bits; b++) {
    const va = a[b]!, vc = c[b]!;
    let d: number;
    if (va === va && vc === vc) d = (va - vc) / swing; // (NaN marks a missing frame)
    else if (va === va) d = (2 * (va - (on + off) / 2)) / swing; // one frame of the pair missing: compare with half-way
    else if (vc === vc) d = (2 * ((on + off) / 2 - vc)) / swing;
    else { nLost++; lost = b; continue; }
    if (Math.abs(d) < minMargin / 2) { nLost++; lost = b; continue; }
    margin = Math.min(margin, Math.abs(d));
    if (d > 0) word |= 1 << b;
  }
  if (nLost > 1) return { word, margin: 0, repaired: false };
  if (nLost === 1) {
    let par = 0;
    for (let x = word; x; x &= x - 1) par ^= 1;
    if (par) word |= 1 << lost; // even parity over all bits
  }
  return { word, margin, repaired: nLost === 1 };
}

/**
 * Read every spot of a pass. Returns lights with `pixel` set to their code (1-based place in the
 * pass) and counts of what couldn't be read.
 */
export function readSpots(sp: Spots, frames: [Float32Array | null, Float32Array | null][], bits: number, codes: number, w: number, minMargin: number) {
  const out = { found: [] as Omit<Found, 'pass'>[], spots: 0, split: 0, faint: 0, unclear: 0, badParity: 0, badCode: 0 };
  const n = sp.px.length;
  const thr = sp.thr;
  // Each spot pixel's own code (0: unclear or not in use).
  const code = new Int32Array(n);
  const va = new Float64Array(bits + 1), vc = new Float64Array(bits + 1);
  for (let k = 0; k < n; k++) {
    for (let b = 0; b <= bits; b++) { const [fa, fc] = frames[b]!; va[b] = fa ? fa[k]! : NaN; vc[b] = fc ? fc[k]! : NaN; }
    const r = readWord(sp.on[k]!, sp.off[k]!, va, vc, bits, minMargin);
    if (r.margin < minMargin) continue;
    const c = decodeWord(r.word, bits);
    if (c !== null && c >= 1 && c <= codes) code[k] = c;
  }

  /** Read a set of spot pixels as one light. */
  const readPart = (ks: ArrayLike<number>) => {
    let on = 0, off = 0;
    for (let b = 0; b <= bits; b++) { va[b] = frames[b]![0] ? 0 : NaN; vc[b] = frames[b]![1] ? 0 : NaN; }
    for (let j = 0; j < ks.length; j++) {
      const k = ks[j]!;
      on += sp.on[k]!; off += sp.off[k]!;
      for (let b = 0; b <= bits; b++) {
        const [fa, fc] = frames[b]!;
        if (fa) va[b]! += fa[k]!;
        if (fc) vc[b]! += fc[k]!;
      }
    }
    const r = readWord(on, off, va, vc, bits, minMargin);
    const c = r.margin >= minMargin ? decodeWord(r.word, bits) : null;
    return { r, c, strength: on - off };
  };
  /** Add a light; its centre is weighted over `centre` (by default all its pixels). */
  const light = (ks: number[], c: number, r: Reading, strength: number, centre = ks) => {
    let sw = 0, sx = 0, sy = 0, peak = 0;
    for (const k of ks) peak = Math.max(peak, sp.on[k]! - sp.off[k]!);
    for (const k of centre) {
      const i = sp.px[k]!;
      const wt = sp.on[k]! - sp.off[k]! - thr * 0.5;
      sw += wt; sx += wt * (i % w); sy += wt * Math.floor(i / w);
    }
    // +0.5: a pixel's centre is half a pixel in from its corner.
    out.found.push({ pixel: c, x: sx / sw + 0.5, y: sy / sw + 0.5, strength, margin: r.margin, area: ks.length, peak, repaired: r.repaired });
  };

  for (let s = 0; s + 1 < sp.start.length; s++) {
    const k0 = sp.start[s]!, k1 = sp.start[s + 1]!;
    out.spots++;
    const ks = Array.from({ length: k1 - k0 }, (_, j) => k0 + j);
    // Codes seen in this spot, with how many pixels show each.
    const counts = new Map<number, number>();
    for (const k of ks) if (code[k]) counts.set(code[k]!, (counts.get(code[k]!) ?? 0) + 1);
    const parts = [...counts].filter(([, m]) => m >= sp.minPart).map(([c]) => c);
    const whole = readPart(ks);
    // One light (the usual case): read from all its pixels.
    if (parts.length <= 1 && whole.c !== null && whole.c >= 1 && whole.c <= codes && (parts.length === 0 || parts[0] === whole.c)) {
      light(ks, whole.c, whole.r, whole.strength);
      continue;
    }
    // Several lights touching: each code's pixels are a light, checked again on their sums. Its own
    // pixels stop short of the mixed ones between the lights, which would pull its centre away from
    // its neighbour, so for the centre each mixed pixel goes to the nearest light.
    const split: { mine: number[]; c: number; part: ReturnType<typeof readPart>; x: number; y: number }[] = [];
    for (const c of parts) {
      const mine = ks.filter((k) => code[k] === c);
      const part = readPart(mine);
      if (part.c !== c) continue;
      let sw = 0, sx = 0, sy = 0;
      for (const k of mine) { const wt = sp.on[k]! - sp.off[k]!, i = sp.px[k]!; sw += wt; sx += wt * (i % w); sy += wt * Math.floor(i / w); }
      split.push({ mine, c, part, x: sx / sw, y: sy / sw });
    }
    const centres = split.map((l) => [...l.mine]);
    if (split.length > 1) for (const k of ks) {
      if (code[k]) continue;
      const x = sp.px[k]! % w, y = Math.floor(sp.px[k]! / w);
      let best = 0, bd = Infinity;
      split.forEach((l, j) => { const d = (l.x - x) ** 2 + (l.y - y) ** 2; if (d < bd) { bd = d; best = j; } });
      centres[best]!.push(k);
    }
    split.forEach((l, j) => light(l.mine, l.c, l.part.r, l.part.strength, centres[j]));
    const lights = split.length;
    if (lights > 1) out.split++;
    if (lights > 0) continue;
    let peak = 0;
    for (const k of ks) peak = Math.max(peak, sp.on[k]! - sp.off[k]!);
    if (whole.r.margin >= minMargin) { if (whole.c === null) out.badParity++; else out.badCode++; }
    else if (peak < 1.5 * thr) out.faint++;
    else out.unclear++;
  }
  return out;
}

function emptySpots(): Spots {
  return { px: new Int32Array(0), start: new Int32Array(1), on: new Float32Array(0), off: new Float32Array(0), thr: 0, tooBig: 0, specks: 0, minPart: 2 };
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** Sum of the brightest value in each 8×8 cell: rises with the lights, barely moves with the background. */
export function cellSignal(lum: Uint8Array, w: number, h: number): number {
  let total = 0;
  for (let cy = 0; cy < h; cy += CELL) {
    for (let cx = 0; cx < w; cx += CELL) {
      let m = 0;
      const ye = Math.min(h, cy + CELL), xe = Math.min(w, cx + CELL);
      for (let y = cy; y < ye; y += 2) { const row = y * w; for (let x = cx; x < xe; x++) { const v = lum[row + x]!; if (v > m) m = v; } }
      total += m;
    }
  }
  return total;
}

/**
 * Slide the expected brightness pattern (lead-in dark, preamble, first pass's background and
 * reference) along the recorded signal and return the start with the best correlation. Every start
 * on the best plateau fits equally well, so the middle of the plateau is taken.
 */
export function findStart(signal: { t: number; s: number }[], levels: number[], hold: number, guess: number, search: number): { start: number; score: number } {
  const n = Math.min(levels.length, PREAMBLE_SLOTS + 2);
  const step = 2;
  let best = -Infinity;
  const scores: { start: number; score: number }[] = [];
  for (let d = -search; d <= search; d += step) {
    const start = guess + d;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, c = 0;
    for (const { t, s } of signal) {
      const rel = t - start;
      if (rel < -2 * hold || rel >= n * hold) continue;
      const slot = Math.floor(rel / hold);
      const x = slot < 0 ? 0 : levels[slot]!;
      sx += x; sy += s; sxx += x * x; syy += s * s; sxy += x * s; c++;
    }
    if (c < 4) { scores.push({ start, score: -1 }); continue; }
    const cov = sxy - (sx * sy) / c, vx = sxx - (sx * sx) / c, vy = syy - (sy * sy) / c;
    const r = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : -1;
    scores.push({ start, score: r });
    if (r > best) best = r;
  }
  // Middle of the longest stretch of near-best scores.
  const tol = Math.max(1e-6, Math.abs(best) * 0.003);
  let runStart = -1, bestRun: [number, number] = [0, 0], bestLen = -1;
  scores.forEach((s, i) => {
    const good = s.score >= best - tol;
    if (good && runStart < 0) runStart = i;
    if ((!good || i === scores.length - 1) && runStart >= 0) {
      const end = good ? i : i - 1;
      if (end - runStart > bestLen) { bestLen = end - runStart; bestRun = [runStart, end]; }
      runStart = -1;
    }
  });
  const start = (scores[bestRun[0]]!.start + scores[bestRun[1]]!.start) / 2;
  return { start, score: best };
}


/** Per spot pixel, the median over a slot's frames. */
function medianOf(list: Uint8Array[] | undefined): Float32Array | null {
  if (!list?.length) return null;
  const n = list[0]!.length, out = new Float32Array(n);
  if (list.length === 1) { out.set(list[0]!); return out; }
  const len = list.length, tmp = new Uint8Array(len), m = len >> 1;
  for (let j = 0; j < n; j++) {
    // Insertion sort: a slot has only a handful of frames.
    for (let k = 0; k < len; k++) {
      const v = list[k]![j]!;
      let q = k;
      while (q > 0 && tmp[q - 1]! > v) { tmp[q] = tmp[q - 1]!; q--; }
      tmp[q] = v;
    }
    out[j] = len % 2 ? tmp[m]! : (tmp[m - 1]! + tmp[m]!) / 2;
  }
  return out;
}

/**
 * Bright spots in on − off: pixels rising more than a threshold (from the brightest lights, but at
 * least `minRise`), grouped 8-connected. Spots bigger than `maxArea` are glare, and specks smaller
 * than a light are noise or glints: both are left out (and counted).
 */
export function findSpots(on: Float32Array, off: Float32Array, w: number, h: number, minRise: number, maxArea: number): Spots {
  const n = w * h;
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[Math.max(0, Math.min(255, Math.round(on[i]! - off[i]!)))]!++;
  // The 99.9th percentile of the rise stands for a typical light's peak (lights are a small part of the picture).
  let acc = 0, p999 = 255;
  for (let v = 255; v >= 0; v--) { acc += hist[v]!; if (acc >= n * 0.001) { p999 = v; break; } }
  const thr = Math.max(minRise, 0.3 * p999);
  // A light covers a few pixels, more in a bigger picture: smaller specks are noise or glints.
  const scale = Math.max(1, w / 640);
  const minSpot = Math.round(3 * scale), minPart = Math.round(2 * scale);
  const seen = new Uint8Array(n);
  const px: number[] = [], start: number[] = [0];
  const stack: number[] = [];
  let tooBig = 0, specks = 0;
  for (let i0 = 0; i0 < n; i0++) {
    if (seen[i0] || on[i0]! - off[i0]! <= thr) continue;
    const first = px.length;
    seen[i0] = 1; stack.push(i0);
    while (stack.length) {
      const i = stack.pop()!;
      px.push(i);
      const x = i % w, y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (!seen[j] && on[j]! - off[j]! > thr) { seen[j] = 1; stack.push(j); }
      }
    }
    if (px.length - first > maxArea) { px.length = first; tooBig++; continue; }
    if (px.length - first < minSpot) { px.length = first; specks++; continue; }
    start.push(px.length);
  }
  const pxa = Int32Array.from(px);
  const onv = new Float32Array(pxa.length), offv = new Float32Array(pxa.length);
  for (let k = 0; k < pxa.length; k++) { onv[k] = on[pxa[k]!]!; offv[k] = off[pxa[k]!]!; }
  return { px: pxa, start: Int32Array.from(start), on: onv, off: offv, thr, tooBig, specks, minPart };
}

/** Downscale to at most 320 px wide for showing the view. */
function thumbnail(lum: Uint8Array, w: number, h: number): DecodeResult['thumbnail'] {
  const s = Math.max(1, Math.ceil(w / 320));
  const tw = Math.floor(w / s), th = Math.floor(h / s);
  const data = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    let m = 0;
    for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) m = Math.max(m, lum[(y * s + dy) * w + x * s + dx]!);
    data[y * tw + x] = m;
  }
  return { width: tw, height: th, data, scale: s };
}
