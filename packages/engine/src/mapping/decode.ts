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
 * 3. Blobs. Per pass, the reference frame minus the background frame shows where that pass's lights
 *    are. Bright connected spots are blobs; their weighted centres are the light positions.
 * 4. Codes. For each blob and code bit, the bit frame and its inverse are compared at that spot. The
 *    brighter one gives the bit, and how much brighter (relative to the blob's full on/off swing) is
 *    the margin. A blob whose bits aren't all clear, whose parity is wrong, or whose code isn't used
 *    is dropped, so a merged pair of lights or a reflection doesn't produce a wrong pixel.
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
  /** Smallest brightness rise (0..255) for a blob. */
  minRise?: number;
  /** Largest blob in picture pixels; bigger ones are glare, not single lights. */
  maxBlobArea?: number;
}

export interface Detection {
  pixel: number;
  /** Weighted centre in picture pixels. */
  x: number;
  y: number;
  /** Summed brightness rise over the blob. */
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
  blobs: number;
  decoded: number;
  unclear: number;
  badParity: number;
  badCode: number;
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
  thumbnail?: { width: number; height: number; data: Uint8Array };
}

interface Blob { idx: Int32Array; cx: number; cy: number; area: number; on: number; off: number }

interface PassState {
  off: Float32Array | null; offN: number;
  on: Float32Array | null; onN: number;
  blobs: Blob[] | null;
  /** Per slot index: per-frame sums over each blob. */
  samples: Map<number, Float32Array[]>;
}

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
    this.opts = { minMargin: o.minMargin ?? 0.3, minRise: o.minRise ?? 18, maxBlobArea: o.maxBlobArea ?? Math.max(60, (o.width * o.height) / 2500) };
    this.passes = plan.passes.map(() => ({ off: null, offN: 0, on: null, onN: 0, blobs: null, samples: new Map() }));
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
    if (!ps.blobs) this.findBlobs(ps);
    const blobs = ps.blobs!;
    const v = new Float32Array(blobs.length);
    blobs.forEach((b, j) => { let sum = 0; for (const i of b.idx) sum += lum[i]!; v[j] = sum; });
    let list = ps.samples.get(slot);
    if (!list) ps.samples.set(slot, (list = []));
    list.push(v);
  }

  private findBlobs(ps: PassState) {
    if (!ps.on || !ps.off || !ps.onN || !ps.offN) { ps.blobs = []; return; }
    const on = ps.on, off = ps.off;
    for (let i = 0; i < on.length; i++) { on[i]! /= ps.onN; off[i]! /= ps.offN; }
    ps.blobs = detectBlobs(on, off, this.w, this.h, this.opts.minRise, this.opts.maxBlobArea);
    ps.on = ps.off = null; // done with the full pictures
  }

  finish(): DecodeResult {
    if (this.start === null && this.signal.length) this.sync();
    const stats: DecodeStats = { frames: this.frames, framesUsed: this.used, syncScore: round(this.syncScore, 3), offsetMs: this.start === null ? 0 : round(this.start - this.o.startGuessMs, 1), blobs: 0, decoded: 0, unclear: 0, badParity: 0, badCode: 0, duplicates: 0, missingSlots: 0 };
    if (this.start === null) return { ok: false, error: 'no frames from the sequence were recorded', startMs: null, detections: [], stats };
    const found: Detection[] = [];
    const bits = this.plan.bits;
    this.plan.passes.forEach((pass, p) => {
      const ps = this.passes[p]!;
      if (!ps.blobs) this.findBlobs(ps);
      const blobs = ps.blobs!;
      stats.blobs += blobs.length;
      // Slot index of each bit frame and its inverse.
      const slotOf = (kind: 'bit' | 'bit-inv', bit: number) => this.plan.slots.findIndex((s) => s.kind === kind && s.pass === p && s.bit === bit);
      const med: (Float32Array | null)[][] = [];
      for (let b = 0; b <= bits; b++) {
        const a = medianOf(ps.samples.get(slotOf('bit', b))), c = medianOf(ps.samples.get(slotOf('bit-inv', b)));
        if (!a) stats.missingSlots++;
        if (!c) stats.missingSlots++;
        med.push([a, c]);
      }
      blobs.forEach((blob, j) => {
        const swing = blob.on - blob.off;
        let word = 0, margin = 1;
        for (let b = 0; b <= bits; b++) {
          const [a, c] = med[b]!;
          let m: number, one: boolean;
          if (a && c) { one = a[j]! > c[j]!; m = Math.abs(a[j]! - c[j]!) / swing; }
          else if (a || c) { // one frame of the pair missing: compare with half-way between on and off
            const v = (a ?? c)![j]!, mid = (blob.on + blob.off) / 2;
            one = a ? v > mid : v < mid; m = (2 * Math.abs(v - mid)) / swing;
          } else { m = 0; one = false; }
          margin = Math.min(margin, m);
          if (one) word |= 1 << b;
        }
        if (margin < this.opts.minMargin) { stats.unclear++; return; }
        const code = decodeWord(word, bits);
        if (code === null) { stats.badParity++; return; }
        if (code < 1 || code > pass.pixels.length) { stats.badCode++; return; }
        found.push({ pixel: pass.pixels[code - 1]!, x: round(blob.cx, 2), y: round(blob.cy, 2), strength: Math.round(swing), margin: round(Math.min(1, margin), 3), area: blob.area, pass: p });
      });
    });
    // The same code twice: keep a clearly stronger one (a reflection is dimmer), else drop both.
    const byPixel = new Map<number, Detection[]>();
    for (const d of found) { const l = byPixel.get(d.pixel); if (l) l.push(d); else byPixel.set(d.pixel, [d]); }
    const detections: Detection[] = [];
    for (const list of byPixel.values()) {
      if (list.length === 1) { detections.push(list[0]!); continue; }
      list.sort((a, b) => b.strength - a.strength);
      const top = list[0]!;
      // One light split in two (a flat, saturated top): merge the pieces.
      if (list.every((d) => Math.hypot(d.x - top.x, d.y - top.y) < 6)) {
        const sw = list.reduce((a, d) => a + d.strength, 0);
        detections.push({ ...top, x: round(list.reduce((a, d) => a + d.x * d.strength, 0) / sw, 2), y: round(list.reduce((a, d) => a + d.y * d.strength, 0) / sw, 2), strength: sw, area: list.reduce((a, d) => a + d.area, 0), margin: Math.min(...list.map((d) => d.margin)) });
        continue;
      }
      stats.duplicates += list.length - 1;
      if (top.strength >= 2.5 * list[1]!.strength) detections.push(top);
      else stats.duplicates++;
    }
    detections.sort((a, b) => a.pixel - b.pixel);
    stats.decoded = detections.length;
    const error = this.failed ?? (detections.length === 0 ? 'no lights could be read in this view' : undefined);
    return { ok: !this.failed && detections.length > 0, ...(error && { error }), startMs: this.start, detections, stats, thumbnail: this.thumb };
  }
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

function medianOf(list: Float32Array[] | undefined): Float32Array | null {
  if (!list?.length) return null;
  if (list.length === 1) return list[0]!;
  const n = list[0]!.length, out = new Float32Array(n), tmp = new Array<number>(list.length);
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < list.length; k++) tmp[k] = list[k]![j]!;
    tmp.sort((a, b) => a - b);
    const m = tmp.length >> 1;
    out[j] = tmp.length % 2 ? tmp[m]! : (tmp[m - 1]! + tmp[m]!) / 2;
  }
  return out;
}

/**
 * Bright spots in on − off. Pixels rising more than a threshold (from the brightest lights, but at
 * least `minRise`) are grouped 8-connected; a group with several separate peaks (two lights touching)
 * is split between them. Each blob keeps its pixels (for reading bits) and its weighted centre.
 */
export function detectBlobs(on: Float32Array, off: Float32Array, w: number, h: number, minRise: number, maxArea: number) {
  const n = w * h;
  const diff = new Float32Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) { const d = on[i]! - off[i]!; diff[i] = d; hist[Math.max(0, Math.min(255, Math.round(d)))]!++; }
  // The 99.9th percentile of the rise stands for a typical light's peak (lights are a small part of the picture).
  let acc = 0, p999 = 255;
  for (let v = 255; v >= 0; v--) { acc += hist[v]!; if (acc >= n * 0.001) { p999 = v; break; } }
  const thr = Math.max(minRise, 0.3 * p999);
  const label = new Int32Array(n).fill(-1);
  const blobs: Blob[] = [];
  const stack: number[] = [];
  for (let i0 = 0; i0 < n; i0++) {
    if (label[i0] !== -1 || diff[i0]! <= thr) continue;
    const comp: number[] = [];
    label[i0] = -2; stack.push(i0);
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (label[j] === -1 && diff[j]! > thr) { label[j] = -2; stack.push(j); }
      }
    }
    if (comp.length > maxArea) continue;
    for (const part of splitPeaks(comp, diff, w)) {
      let sw = 0, sx = 0, sy = 0, sOn = 0, sOff = 0;
      for (const i of part) {
        const wt = diff[i]! - thr * 0.5;
        sw += wt; sx += wt * (i % w); sy += wt * ((i / w) | 0);
        sOn += on[i]!; sOff += off[i]!;
      }
      if (sw <= 0) continue;
      // +0.5: a pixel's centre is half a pixel in from its corner.
      blobs.push({ idx: Int32Array.from(part), cx: sx / sw + 0.5, cy: sy / sw + 0.5, area: part.length, on: sOn, off: sOff });
    }
  }
  return blobs;
}

/** Split a group of pixels between its separate peaks (local maxima at least 3 px apart). */
function splitPeaks(comp: number[], diff: Float32Array, w: number): number[][] {
  if (comp.length < 6) return [comp];
  const inComp = new Set(comp);
  let top = 0;
  for (const i of comp) top = Math.max(top, diff[i]!);
  const peaks: number[] = [];
  for (const i of comp) {
    const v = diff[i]!;
    if (v < 0.6 * top) continue;
    let isMax = true;
    const x = i % w;
    for (let dy = -2; dy <= 2 && isMax; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (!dx && !dy) continue;
      if (x + dx < 0 || x + dx >= w) continue;
      const j = i + dy * w + dx;
      if (inComp.has(j) && (diff[j]! > v || (diff[j]! === v && j < i))) { isMax = false; break; }
    }
    if (isMax) peaks.push(i);
  }
  // Saturated lights have flat tops; peaks too close together are one light.
  const kept: number[] = [];
  for (const p of peaks) if (kept.every((q) => Math.hypot((p % w) - (q % w), ((p / w) | 0) - ((q / w) | 0)) >= 3)) kept.push(p);
  if (kept.length < 2) return [comp];
  const parts: number[][] = kept.map(() => []);
  for (const i of comp) {
    let best = 0, bd = Infinity;
    kept.forEach((p, k) => { const d = Math.hypot((i % w) - (p % w), ((i / w) | 0) - ((p / w) | 0)); if (d < bd) { bd = d; best = k; } });
    parts[best]!.push(i);
  }
  return parts;
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
  return { width: tw, height: th, data };
}
