/**
 * Camera mapping, part 1: the coded light sequence.
 *
 * The server plays this sequence on the lights while the phone films them; the phone decodes it.
 * Both sides build the same plan from the layout and the parameters, so nothing but the parameters
 * (and, as a check, the plan itself) has to travel between them.
 *
 * Layout of one view's sequence, one slot per `holdMs`:
 *
 *   PREAMBLE (every light, on/off in a Barker-7 code)  → the phone finds the timing from this
 *   for each pass:
 *     ref-off   (all dark)                             → background
 *     ref-on    (this pass's lights)                   → where the lights are (blobs)
 *     bit b, bit b inverted, for each code bit         → which light each blob is
 *   one dark slot at the end
 *
 * A pass lights every `k`th pixel of every run (pixel i of a run where i % k === offset), so the lit
 * pixels are far enough apart for the camera to tell them apart. Each lit pixel gets a code 1..N
 * (its place in the pass), sent as Gray-code bits plus an even-parity bit. Every bit is shown twice,
 * as itself and inverted, so the phone reads it by comparing the two frames at that spot: no global
 * threshold, and auto-exposure changes between frames mostly cancel out.
 */
import type { Layout } from '../layout.js';

export interface MappingParams {
  /** Every `k`th pixel of a run lights in one pass. */
  k: number;
  /** Passes per view, each with a different offset along the run (spread evenly over 0..k-1). */
  passes: number;
  /** Milliseconds each slot is held. */
  holdMs: number;
  /** 0..1 of white at the current master brightness. */
  level: number;
}

// Level 0.25: at full brightness the LEDs bloom into big blobs on a phone camera at night (first night test).
export const DEFAULT_MAPPING: MappingParams = { k: 10, passes: 2, holdMs: 250, level: 0.25 };

export const MAPPING_LIMITS = { k: [2, 64], passes: [1, 64], holdMs: [100, 1000], level: [0.05, 1] } as const;

/** Barker-7: a short on/off code whose shifted copies barely overlap, so the timing locks on clearly. */
export const PREAMBLE = [1, 1, 1, 0, 0, 1, 0] as const;

export type SlotKind = 'sync' | 'ref-off' | 'ref-on' | 'bit' | 'bit-inv' | 'end';

export interface Slot {
  kind: SlotKind;
  /** Pass index for ref/bit slots. */
  pass?: number;
  /** Code bit for bit slots (the last bit is the parity bit). */
  bit?: number;
  /** Sync slots: whether every light is on. */
  on?: boolean;
}

export interface MappingPass {
  offset: number;
  /** Global pixel indices lit in this pass; pixel `pixels[c - 1]` has code c. */
  pixels: number[];
}

export interface MappingPlan {
  params: MappingParams;
  passes: MappingPass[];
  /** Code bits per pass (Gray bits; one more parity bit is sent on top). */
  bits: number;
  slots: Slot[];
  durationMs: number;
  /** Every pixel placed by a run (lit in the preamble). */
  pixelCount: number;
}

export function clampParams(p: Partial<MappingParams>): MappingParams {
  const num = (v: unknown, d: number, [lo, hi]: readonly [number, number], int: boolean) => {
    const x = typeof v === 'number' && Number.isFinite(v) ? v : d;
    const c = Math.min(hi, Math.max(lo, x));
    return int ? Math.round(c) : c;
  };
  const k = num(p.k, DEFAULT_MAPPING.k, MAPPING_LIMITS.k, true);
  return {
    k,
    passes: Math.min(k, num(p.passes, DEFAULT_MAPPING.passes, MAPPING_LIMITS.passes, true)),
    holdMs: num(p.holdMs, DEFAULT_MAPPING.holdMs, MAPPING_LIMITS.holdMs, true),
    level: num(p.level, DEFAULT_MAPPING.level, MAPPING_LIMITS.level, false),
  };
}

export const gray = (n: number) => n ^ (n >>> 1);
export function fromGray(g: number): number {
  let n = g;
  for (let s = g >>> 1; s; s >>>= 1) n ^= s;
  return n;
}
const parity = (n: number) => { let p = 0; for (; n; n &= n - 1) p ^= 1; return p; };

/** The code word for code c (1..N) with `bits` Gray bits: Gray bits, then a parity bit on top. */
export function codeWord(c: number, bits: number): number {
  const g = gray(c);
  return g | (parity(g) << bits);
}

/** Inverse of codeWord; null if the parity is wrong. */
export function decodeWord(word: number, bits: number): number | null {
  const g = word & ((1 << bits) - 1);
  if (parity(g) !== (word >>> bits & 1)) return null;
  return fromGray(g);
}

/** Pixels lit in a pass: every k-th pixel of every run, starting at `offset`, in global order. */
function passPixels(layout: Layout, k: number, offset: number): number[] {
  const out: number[] = [];
  for (const run of layout.config.runs) {
    const base = layout.controllerOffset.get(run.controller);
    if (base === undefined) continue;
    for (let i = offset; i < run.count; i += k) out.push(base + run.start + i);
  }
  return out.sort((a, b) => a - b);
}

export function planMapping(layout: Layout, params: Partial<MappingParams> = {}): MappingPlan {
  const p = clampParams(params);
  const passes: MappingPass[] = [];
  for (let i = 0; i < p.passes; i++) {
    const offset = Math.floor((i * p.k) / p.passes);
    passes.push({ offset, pixels: passPixels(layout, p.k, offset) });
  }
  const maxN = Math.max(1, ...passes.map((q) => q.pixels.length));
  const bits = Math.max(1, Math.ceil(Math.log2(maxN + 1)));
  const slots: Slot[] = PREAMBLE.map((b) => ({ kind: 'sync', on: b === 1 }));
  passes.forEach((_, pass) => {
    slots.push({ kind: 'ref-off', pass }, { kind: 'ref-on', pass });
    for (let bit = 0; bit <= bits; bit++) slots.push({ kind: 'bit', pass, bit }, { kind: 'bit-inv', pass, bit });
  });
  slots.push({ kind: 'end' });
  let pixelCount = 0;
  for (let i = 0; i < layout.count; i++) pixelCount += layout.mapped[i]!;
  return { params: p, passes, bits, slots, durationMs: slots.length * p.holdMs, pixelCount };
}

/**
 * Which pixels are lit in each slot (1 = on), indexed by global pixel. Slots that light the same set
 * share one array.
 */
export function slotMasks(layout: Layout, plan: MappingPlan): Uint8Array[] {
  const n = layout.count;
  const dark = new Uint8Array(n);
  const all = Uint8Array.from(layout.mapped);
  const perPass = plan.passes.map((pass) => {
    const on = new Uint8Array(n);
    for (const px of pass.pixels) on[px] = 1;
    const bit: Uint8Array[] = [], inv: Uint8Array[] = [];
    for (let b = 0; b <= plan.bits; b++) {
      const m = new Uint8Array(n), mi = new Uint8Array(n);
      pass.pixels.forEach((px, i) => { if ((codeWord(i + 1, plan.bits) >>> b) & 1) m[px] = 1; else mi[px] = 1; });
      bit.push(m); inv.push(mi);
    }
    return { on, bit, inv };
  });
  return plan.slots.map((s) => {
    switch (s.kind) {
      case 'sync': return s.on ? all : dark;
      case 'ref-on': return perPass[s.pass!]!.on;
      case 'bit': return perPass[s.pass!]!.bit[s.bit!]!;
      case 'bit-inv': return perPass[s.pass!]!.inv[s.bit!]!;
      default: return dark;
    }
  });
}

/** Share of all placed pixels lit in each slot: what the whole picture's brightness should follow. */
export function slotLevels(plan: MappingPlan): number[] {
  const total = Math.max(1, plan.pixelCount);
  const half = (pass: number) => plan.passes[pass]!.pixels.length / 2 / total;
  return plan.slots.map((s) => {
    switch (s.kind) {
      case 'sync': return s.on ? 1 : 0;
      case 'ref-on': return plan.passes[s.pass!]!.pixels.length / total;
      case 'bit': case 'bit-inv': return half(s.pass!);
      default: return 0;
    }
  });
}

/** Index of the first slot of the passes (after the preamble). */
export const PREAMBLE_SLOTS = PREAMBLE.length;
