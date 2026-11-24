import type { Layout } from '@xmas/engine';

/**
 * Selecting lights: pure functions over global pixel indices. Screen positions come from projecting
 * each light through the 3D camera (x, y per pixel; NaN when behind the camera or not placed).
 */
export type Selection = Set<number>;
export type SelectMode = 'replace' | 'add' | 'subtract';

const each = (screen: Float32Array, test: (x: number, y: number) => boolean): Selection => {
  const out = new Set<number>();
  for (let i = 0; i < screen.length / 2; i++) {
    const x = screen[i * 2]!, y = screen[i * 2 + 1]!;
    if (!Number.isNaN(x) && test(x, y)) out.add(i);
  }
  return out;
};

export function inRect(screen: Float32Array, r: { x0: number; y0: number; x1: number; y1: number }): Selection {
  const xa = Math.min(r.x0, r.x1), xb = Math.max(r.x0, r.x1), ya = Math.min(r.y0, r.y1), yb = Math.max(r.y0, r.y1);
  return each(screen, (x, y) => x >= xa && x <= xb && y >= ya && y <= yb);
}

/** Lasso: even-odd point-in-polygon test (points exactly on an edge may fall either side). */
export function inPolygon(screen: Float32Array, poly: [number, number][]): Selection {
  if (poly.length < 3) return new Set();
  return each(screen, (x, y) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  });
}

export function inCircle(screen: Float32Array, cx: number, cy: number, r: number): Selection {
  const r2 = r * r;
  return each(screen, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r2);
}

export function combine(current: Selection, picked: Selection, mode: SelectMode): Selection {
  if (mode === 'replace') return new Set(picked);
  const out = new Set(current);
  for (const i of picked) { if (mode === 'add') out.add(i); else out.delete(i); }
  return out;
}

// ---- rules --------------------------------------------------------------------------------------

/** Global indices of each run, in wiring order. */
function runIndices(layout: Layout): number[][] {
  return layout.config.runs.map((r) => {
    const base = layout.controllerOffset.get(r.controller)! + r.start;
    return Array.from({ length: r.count }, (_, k) => base + k);
  });
}

/** Every Nth selected light, counting along each string (offset 0 = the first selected one). */
export function everyNth(layout: Layout, current: Selection, n: number, offset = 0): Selection {
  const out = new Set<number>();
  const step = Math.max(1, Math.round(n));
  for (const run of runIndices(layout)) {
    let k = 0;
    for (const i of run) {
      if (!current.has(i)) continue;
      if ((k - offset) % step === 0 && k >= offset) out.add(i);
      k++;
    }
  }
  return out;
}

/** The first or last `n` lights of every string. */
export function endsOfRuns(layout: Layout, n: number, which: 'first' | 'last'): Selection {
  const out = new Set<number>();
  for (const run of runIndices(layout)) for (const i of which === 'first' ? run.slice(0, n) : run.slice(-n)) out.add(i);
  return out;
}

/** Lights above or below a height in metres. */
export function aboveHeight(layout: Layout, metres: number, which: 'above' | 'below'): Selection {
  const out = new Set<number>();
  for (let i = 0; i < layout.count; i++) {
    if (!layout.mapped[i]) continue;
    const y = layout.positions[i * 3 + 1]!;
    if (which === 'above' ? y > metres : y < metres) out.add(i);
  }
  return out;
}

/** The left or right half of the house (split at the middle of the lights' width). */
export function sideOf(layout: Layout, side: 'left' | 'right'): Selection {
  const mid = (layout.bounds.min[0] + layout.bounds.max[0]) / 2;
  const out = new Set<number>();
  for (let i = 0; i < layout.count; i++) {
    if (!layout.mapped[i]) continue;
    const x = layout.positions[i * 3]!;
    if (side === 'left' ? x < mid : x > mid) out.add(i);
  }
  return out;
}

export function invert(layout: Layout, current: Selection): Selection {
  const out = new Set<number>();
  for (let i = 0; i < layout.count; i++) if (layout.mapped[i] && !current.has(i)) out.add(i);
  return out;
}

export function selectAll(layout: Layout): Selection {
  return invert(layout, new Set());
}

/** All lights of the string whose nearest light is within `reach` pixels of the pointer, or nothing. */
export function runAt(layout: Layout, screen: Float32Array, x: number, y: number, reach: number): Selection {
  let best = -1, bestD = reach * reach;
  for (let i = 0; i < screen.length / 2; i++) {
    const sx = screen[i * 2]!, sy = screen[i * 2 + 1]!;
    if (Number.isNaN(sx)) continue;
    const d = (sx - x) ** 2 + (sy - y) ** 2;
    if (d <= bestD) { bestD = d; best = i; }
  }
  if (best < 0) return new Set();
  for (const run of runIndices(layout)) if (run.includes(best)) return new Set(run);
  return new Set();
}
