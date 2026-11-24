/** Physical model of the display: controllers, the runs of pixels wired to them, and named groups. */

export type Vec3 = [number, number, number];

export interface ControllerConfig {
  id: string;
  name: string;
  /** IP or hostname of the WLED controller. */
  host: string;
  /** DDP port, WLED default 4048. */
  port?: number;
  /** Total pixels this controller drives (must match WLED's LED count). */
  pixelCount: number;
  /** WLED preset to load when streaming stops (fallback show). */
  fallbackPreset?: number;
}

/**
 * A run is a contiguous block of pixels on one controller, placed in space along a polyline
 * (roofline, window frame, tree spiral...). Phase 3 camera mapping replaces polylines with
 * measured per-pixel positions via `positions`.
 */
export interface RunConfig {
  id: string;
  name?: string;
  controller: string;
  /** First pixel index on the controller (0-based). */
  start: number;
  count: number;
  /** Polyline in metres; pixels are spaced evenly along it. Ignored if `positions` is given. */
  points?: Vec3[];
  /** Measured position for each pixel (from camera mapping). */
  positions?: Vec3[];
}

export interface GroupConfig {
  runs?: string[];
  /** Explicit global pixel indices. */
  pixels?: number[];
  /** Soft edge in metres: effects on this group fade out over this distance around it. 0 or absent = hard edge. */
  feather?: number;
}

export const MAX_FEATHER = 10;

export interface LayoutConfig {
  controllers: ControllerConfig[];
  runs: RunConfig[];
  groups?: Record<string, GroupConfig>;
}

export interface Layout {
  config: LayoutConfig;
  count: number;
  /** World positions, xyz per pixel. NaN for pixels not placed by any run. */
  positions: Float32Array;
  /** Positions normalised to 0..1 per axis using the largest extent (keeps proportions). */
  normalized: Float32Array;
  /** 1 if the pixel belongs to a run. */
  mapped: Uint8Array;
  /** Offset of each controller's first pixel in the global index space. */
  controllerOffset: Map<string, number>;
  groups: Map<string, Uint8Array>;
  /** Per-pixel weights 0..1 for feathered groups (absent for hard-edged ones). */
  groupWeights: Map<string, Float32Array>;
  bounds: { min: Vec3; max: Vec3 };
}

export class LayoutError extends Error {}

function samplePolyline(points: Vec3[], count: number): Vec3[] {
  if (points.length === 0) throw new LayoutError('run needs at least one point');
  if (points.length === 1 || count === 1) return Array.from({ length: count }, () => [...points[0]!] as Vec3);
  const segLen: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    segLen.push(l);
    total += l;
  }
  const out: Vec3[] = [];
  let seg = 0, segStart = 0;
  for (let i = 0; i < count; i++) {
    const d = (total * i) / (count - 1);
    while (seg < segLen.length - 1 && d > segStart + segLen[seg]!) { segStart += segLen[seg]!; seg++; }
    const a = points[seg]!, b = points[seg + 1]!;
    const f = segLen[seg]! === 0 ? 0 : Math.min(1, (d - segStart) / segLen[seg]!);
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
  }
  return out;
}

export function buildLayout(config: LayoutConfig): Layout {
  const controllerOffset = new Map<string, number>();
  let count = 0;
  for (const c of config.controllers) {
    if (controllerOffset.has(c.id)) throw new LayoutError(`duplicate controller id "${c.id}"`);
    if (!Number.isInteger(c.pixelCount) || c.pixelCount < 0) throw new LayoutError(`controller "${c.id}" has invalid pixelCount`);
    controllerOffset.set(c.id, count);
    count += c.pixelCount;
  }
  const positions = new Float32Array(count * 3).fill(NaN);
  const mapped = new Uint8Array(count);
  const runPixels = new Map<string, number[]>();

  for (const run of config.runs) {
    const ctrl = config.controllers.find((c) => c.id === run.controller);
    if (!ctrl) throw new LayoutError(`run "${run.id}" references unknown controller "${run.controller}"`);
    if (run.start < 0 || run.start + run.count > ctrl.pixelCount) {
      throw new LayoutError(`run "${run.id}" (${run.start}..${run.start + run.count - 1}) exceeds controller "${ctrl.id}" (${ctrl.pixelCount} pixels)`);
    }
    let pts: Vec3[];
    if (run.positions) {
      if (run.positions.length !== run.count) throw new LayoutError(`run "${run.id}" has ${run.positions.length} positions for ${run.count} pixels`);
      pts = run.positions;
    } else {
      pts = samplePolyline(run.points ?? [], run.count);
    }
    const base = controllerOffset.get(ctrl.id)! + run.start;
    const ids: number[] = [];
    for (let i = 0; i < run.count; i++) {
      const g = base + i;
      if (mapped[g]) throw new LayoutError(`pixel ${g} is claimed by more than one run (run "${run.id}")`);
      mapped[g] = 1;
      positions.set(pts[i]!, g * 3);
      ids.push(g);
    }
    runPixels.set(run.id, ids);
  }

  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    if (!mapped[i]) continue;
    for (let a = 0; a < 3; a++) {
      const v = positions[i * 3 + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  if (min[0] === Infinity) { min.fill(0); max.fill(1); }
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  const normalized = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) {
    const a = i % 3;
    normalized[i] = mapped[(i / 3) | 0] ? (positions[i]! - min[a]!) / extent : 0;
  }

  const groups = new Map<string, Uint8Array>();
  const groupWeights = new Map<string, Float32Array>();
  const all = new Uint8Array(count).fill(1);
  groups.set('all', all);
  for (const [name, g] of Object.entries(config.groups ?? {})) {
    const m = new Uint8Array(count);
    for (const r of g.runs ?? []) {
      const ids = runPixels.get(r);
      if (!ids) throw new LayoutError(`group "${name}" references unknown run "${r}"`);
      for (const id of ids) m[id] = 1;
    }
    for (const p of g.pixels ?? []) {
      if (p < 0 || p >= count) throw new LayoutError(`group "${name}" pixel ${p} out of range`);
      m[p] = 1;
    }
    const feather = g.feather ?? 0;
    if (!(Number.isFinite(feather) && feather >= 0 && feather <= MAX_FEATHER)) throw new LayoutError(`group "${name}" feather must be 0..${MAX_FEATHER} m`);
    if (feather > 0) {
      const w = featherWeights(m, positions, mapped, feather);
      for (let i = 0; i < count; i++) if (w[i]! > 0) m[i] = 1;
      groupWeights.set(name, w);
    }
    groups.set(name, m);
  }
  // Every run is also addressable as a group named "run:<id>".
  for (const [id, ids] of runPixels) {
    const m = new Uint8Array(count);
    for (const p of ids) m[p] = 1;
    groups.set(`run:${id}`, m);
  }

  return { config, count, positions, normalized, mapped, controllerOffset, groups, groupWeights, bounds: { min, max } };
}

/**
 * Weights for a feathered group: 1 inside, easing to 0 at `feather` metres from the nearest selected
 * pixel (a cosine curve, so the edge has no visible step).
 */
function featherWeights(selected: Uint8Array, positions: Float32Array, mapped: Uint8Array, feather: number): Float32Array {
  const n = selected.length;
  const w = new Float32Array(n);
  const sel: number[] = [];
  for (let i = 0; i < n; i++) if (selected[i]) { w[i] = 1; if (mapped[i]) sel.push(i); }
  for (let i = 0; i < n; i++) {
    if (selected[i] || !mapped[i]) continue;
    const x = positions[i * 3]!, y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!;
    let best = Infinity;
    for (const j of sel) {
      const dx = positions[j * 3]! - x, dy = positions[j * 3 + 1]! - y, dz = positions[j * 3 + 2]! - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) best = d2;
    }
    const d = Math.sqrt(best);
    w[i] = d >= feather ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * d) / feather);
  }
  return w;
}
