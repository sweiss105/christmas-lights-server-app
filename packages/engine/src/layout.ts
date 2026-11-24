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
  /** The string is wound round the path (e.g. coiled around a rail) rather than laid along it. */
  coil?: CoilConfig;
}

export interface CoilConfig {
  /** Metres from the path's centre line to the lights (half the rail's thickness, roughly). */
  radius: number;
  /** Metres along the path per full turn. Each segment gets a whole number of turns, as near this as it can. */
  pitch: number;
  /** Segments (0 = first point to second) the string runs straight along instead, e.g. down a post. */
  skip?: number[];
}

export const MAX_COIL_RADIUS = 0.5;

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

/** Steps per turn when tracing a coil; the lights are then spaced evenly along the traced wire. */
const COIL_STEPS = 24;

/**
 * The path a coiled string's wire takes: a helix around each segment, starting and ending each turn
 * on top of the path (or, on a vertical segment, on the side facing +z), so segments join up.
 */
function coilPath(points: Vec3[], coil: CoilConfig, runId: string): Vec3[] {
  const { radius, pitch } = coil;
  if (!(radius > 0 && radius <= MAX_COIL_RADIUS)) throw new LayoutError(`run "${runId}" coil radius must be between 0 and ${MAX_COIL_RADIUS} m`);
  if (!(pitch > 0)) throw new LayoutError(`run "${runId}" coil pitch must be more than 0`);
  const skip = new Set(coil.skip ?? []);
  const out: Vec3[] = [];
  for (let s = 0; s + 1 < points.length; s++) {
    const a = points[s]!, b = points[s + 1]!;
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(...d);
    if (len === 0 || skip.has(s)) { if (s === 0) out.push([...a] as Vec3); out.push([...b] as Vec3); continue; }
    const t: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
    // Frame: v points "up" across the segment (world up minus its along-path part), u = t × v.
    let ref: Vec3 = Math.abs(t[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
    const k = ref[0] * t[0] + ref[1] * t[1] + ref[2] * t[2];
    let v: Vec3 = [ref[0] - k * t[0], ref[1] - k * t[1], ref[2] - k * t[2]];
    const vl = Math.hypot(...v); v = [v[0] / vl, v[1] / vl, v[2] / vl];
    const u: Vec3 = [t[1] * v[2] - t[2] * v[1], t[2] * v[0] - t[0] * v[2], t[0] * v[1] - t[1] * v[0]];
    const turns = Math.max(1, Math.round(len / pitch));
    const steps = turns * COIL_STEPS;
    for (let i = s === 0 ? 0 : 1; i <= steps; i++) {
      const f = i / steps, ang = 2 * Math.PI * turns * f;
      const c = Math.cos(ang) * radius, sn = Math.sin(ang) * radius;
      out.push([a[0] + d[0] * f + v[0] * c + u[0] * sn, a[1] + d[1] * f + v[1] * c + u[1] * sn, a[2] + d[2] * f + v[2] * c + u[2] * sn]);
    }
  }
  // A skipped segment joins the coil's start/end on top of the path; that small step is part of the wire.
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
      const pathPts = run.points ?? [];
      pts = samplePolyline(run.coil && pathPts.length > 1 ? coilPath(pathPts, run.coil, run.id) : pathPts, run.count);
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
