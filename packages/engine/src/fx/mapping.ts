import type { Layout } from '../layout.js';

/**
 * How a strip-style (1D) effect is laid over the house.
 * - each:   every run plays the pattern over its own length
 * - strip:  runs joined in wiring order, as one long strip
 * - across: left to right across the house
 * - up:     ground to top
 * - center: outwards from the middle of the house
 */
export type Mapping1D = 'each' | 'strip' | 'across' | 'up' | 'center';
export const MAPPINGS_1D: Mapping1D[] = ['each', 'strip', 'across', 'up', 'center'];
export const MAPPING_LABELS: Record<Mapping1D, string> = {
  each: 'Along each string',
  strip: 'One long strip',
  across: 'Across the house',
  up: 'Up the house',
  center: 'Out from the centre',
};

export interface Map1D {
  /** Position 0..1 along the virtual strip for each pixel; -1 for pixels not placed by any run. */
  pos: Float32Array;
  /** Number of virtual pixels the strip should have, so patterns keep roughly one light per cell. */
  length: number;
}

export interface Map2D {
  /** 0..1 across (left → right) and up (ground → top) the house front; -1 when not placed. */
  x: Float32Array;
  y: Float32Array;
  /** Width / height of the lit area, for effects that want round shapes. */
  aspect: number;
}

interface RunSpan { start: number; count: number }

/** Global index ranges of each run, in config (wiring) order. */
function runSpans(layout: Layout): RunSpan[] {
  return layout.config.runs.map((r) => ({ start: layout.controllerOffset.get(r.controller)! + r.start, count: r.count }));
}

const cache1D = new WeakMap<Layout, Map<Mapping1D, Map1D>>();
const cache2D = new WeakMap<Layout, Map2D>();

export function map1D(layout: Layout, mode: Mapping1D): Map1D {
  let byMode = cache1D.get(layout);
  if (!byMode) cache1D.set(layout, (byMode = new Map()));
  const hit = byMode.get(mode);
  if (hit) return hit;

  const pos = new Float32Array(layout.count).fill(-1);
  const spans = runSpans(layout);
  const placed = spans.reduce((a, s) => a + s.count, 0);
  let length = Math.max(1, placed);

  if (mode === 'each') {
    length = Math.max(1, ...spans.map((s) => s.count));
    for (const s of spans) for (let i = 0; i < s.count; i++) pos[s.start + i] = s.count > 1 ? i / (s.count - 1) : 0;
  } else if (mode === 'strip') {
    let k = 0;
    for (const s of spans) for (let i = 0; i < s.count; i++) pos[s.start + i] = placed > 1 ? k++ / (placed - 1) : 0;
  } else {
    const m = map2D(layout);
    let lo = Infinity, hi = -Infinity;
    const v = new Float32Array(layout.count);
    for (let i = 0; i < layout.count; i++) {
      if (m.x[i]! < 0) continue;
      const val = mode === 'across' ? m.x[i]! : mode === 'up' ? m.y[i]! : Math.hypot((m.x[i]! - 0.5) * m.aspect, m.y[i]! - 0.5);
      v[i] = val;
      lo = Math.min(lo, val); hi = Math.max(hi, val);
    }
    const span = hi - lo || 1;
    for (let i = 0; i < layout.count; i++) if (m.x[i]! >= 0) pos[i] = (v[i]! - lo) / span;
    if (mode === 'center') length = Math.max(1, Math.ceil(placed / 2));
  }
  const result = { pos, length };
  byMode.set(mode, result);
  return result;
}

export function map2D(layout: Layout): Map2D {
  const hit = cache2D.get(layout);
  if (hit) return hit;
  const { min, max } = layout.bounds;
  const sx = max[0] - min[0], sy = max[1] - min[1];
  const x = new Float32Array(layout.count).fill(-1), y = new Float32Array(layout.count).fill(-1);
  for (let i = 0; i < layout.count; i++) {
    if (!layout.mapped[i]) continue;
    x[i] = sx > 0 ? (layout.positions[i * 3]! - min[0]) / sx : 0.5;
    y[i] = sy > 0 ? (layout.positions[i * 3 + 1]! - min[1]) / sy : 0.5;
  }
  const result = { x, y, aspect: sy > 0 ? sx / sy : 1 };
  cache2D.set(layout, result);
  return result;
}
