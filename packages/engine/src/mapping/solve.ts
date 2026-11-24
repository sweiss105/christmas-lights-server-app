/**
 * Camera mapping, part 3c: from the views' detections to positions for whole runs.
 *
 * 1. Each view's camera is placed from the lights of trusted runs (anchors) it saw.
 * 2. With two or more placed views, every light seen from at least two of them (with enough angle
 *    between the rays) is triangulated. Seen once only, it can be put where its ray meets the house
 *    model (less certain).
 * 3. Measured lights of a run that don't fit the wire (further from their neighbours than the
 *    string's spacing allows) are dropped; the rest of the run is filled in along the wire in pixel
 *    order, so a run mapped at every 10th light still gets a position for every light.
 */
import { buildLayout, type LayoutConfig, type Vec3 } from '../layout.js';
import { dist, focalFromFov, pixelRay, type Intrinsics, type Pose } from './camera.js';
import { solvePose, type Correspondence } from './pose.js';
import { triangulate, type Sighting } from './triangulate.js';

export interface ViewInput {
  id: string;
  width: number;
  height: number;
  detections: { pixel: number; x: number; y: number }[];
}

export interface SolveInput {
  layout: LayoutConfig;
  views: ViewInput[];
  /** Runs whose current positions are trusted, used to place the cameras. */
  anchorRuns: string[];
  /** Runs to measure. A run may be both (its lights then both place cameras and get measured). */
  targetRuns: string[];
  /** Starting guess for the phone's horizontal field of view, degrees (iPhone main camera video ≈ 65–72°). */
  fovGuessDeg?: number;
  /** Where a ray from a camera first meets the house model, if one is loaded. */
  raycast?: (origin: Vec3, dir: Vec3) => Vec3 | null;
  /** Largest reprojection error for a measured light, picture pixels. */
  maxErrorPx?: number;
  /** Smallest angle between rays for triangulation, degrees. */
  minAngleDeg?: number;
}

export interface ViewSolve {
  id: string;
  ok: boolean;
  reason?: string;
  pose?: Pose;
  k?: Intrinsics;
  center?: Vec3;
  fovDeg?: number;
  anchorsSeen: number;
  inliers: number;
  rmsPx: number;
  targetsSeen: number;
}

export type PointSource = 'triangulated' | 'surface';

export interface MeasuredPixel { pixel: number; X: Vec3; source: PointSource; views: number; rmsPx: number; angleDeg: number }

/** Per light: 0 none, 1 filled in along the wire, 2 from the house surface, 3 triangulated. */
export const QUALITY = { none: 0, filled: 1, surface: 2, triangulated: 3 } as const;

export interface RunSolve {
  runId: string;
  count: number;
  /** A position for every light, or null if too few were measured. */
  positions: Vec3[] | null;
  quality: number[];
  measured: number;
  surface: number;
  filled: number;
  rejected: number;
  /** Metres between neighbouring lights along the string, as measured. */
  spacing: number | null;
  /** Median distance from the run's current positions, metres (how much accepting would move it). */
  moved: number | null;
}

export interface SolveResult {
  views: ViewSolve[];
  pixels: MeasuredPixel[];
  runs: RunSolve[];
  /** For anchor lights that were also triangulated: how far from their trusted positions (m). */
  anchorCheck: { count: number; median: number; p90: number } | null;
}

const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const quantile = (a: number[], q: number) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]!; };

export function solveMapping(input: SolveInput): SolveResult {
  const layout = buildLayout(input.layout);
  const pos = (i: number): Vec3 => [layout.positions[i * 3]!, layout.positions[i * 3 + 1]!, layout.positions[i * 3 + 2]!];
  const runPixels = (id: string) => { const m = layout.groups.get(`run:${id}`); const out: number[] = []; if (m) for (let i = 0; i < m.length; i++) if (m[i]) out.push(i); return out; };
  const anchor = new Uint8Array(layout.count), target = new Uint8Array(layout.count);
  for (const id of input.anchorRuns) for (const i of runPixels(id)) anchor[i] = 1;
  for (const id of input.targetRuns) for (const i of runPixels(id)) target[i] = 1;
  const maxPx = input.maxErrorPx ?? 4;
  const minAngle = input.minAngleDeg ?? 3;

  // 1. Place each camera.
  const fov = input.fovGuessDeg ?? 68;
  const solveViews = (fixedFocalNorm: number | null) => input.views.map((v): ViewSolve => {
    const cs: Correspondence[] = [];
    let targetsSeen = 0;
    for (const d of v.detections) {
      if (d.pixel >= layout.count) continue;
      if (anchor[d.pixel] && layout.mapped[d.pixel]) cs.push({ X: pos(d.pixel), x: d.x, y: d.y });
      if (target[d.pixel]) targetsSeen++;
    }
    const base = { id: v.id, anchorsSeen: cs.length, inliers: 0, rmsPx: NaN, targetsSeen };
    if (cs.length < 12) return { ...base, ok: false, reason: `only ${cs.length} trusted lights seen (12 or more needed)` };
    const big = Math.max(v.width, v.height);
    // The field of view is across the picture's long side (the phone may be held either way).
    const fGuess = fixedFocalNorm ? fixedFocalNorm * big : focalFromFov(big, fov);
    const r = solvePose(cs, { width: v.width, height: v.height, fGuess, fixFocal: fixedFocalNorm !== null });
    if (!r) return { ...base, ok: false, reason: 'the trusted lights did not fit one camera position' };
    const fovDeg = (2 * Math.atan(v.width / 2 / r.k.f) * 180) / Math.PI;
    return { ...base, ok: true, pose: r.pose, k: r.k, center: r.center, fovDeg, inliers: r.inliers.length, rmsPx: r.rmsPx };
  });
  let views = solveViews(null);
  // The same phone filmed every view: share one focal length (as a share of the picture size).
  const good = views.filter((v) => v.ok);
  if (good.length >= 2) {
    const fNorm = median(good.map((v) => v.k!.f / Math.max(...sizeOf(input, v.id))));
    const again = solveViews(fNorm);
    views = again.map((v, i) => (v.ok || !views[i]!.ok ? v : views[i]!));
  }

  // 2. Measure lights.
  const sightings = new Map<number, Sighting[]>();
  input.views.forEach((v, vi) => {
    const s = views[vi]!;
    if (!s.ok) return;
    for (const d of v.detections) {
      if (d.pixel >= layout.count || !(target[d.pixel] || anchor[d.pixel])) continue;
      let l = sightings.get(d.pixel);
      if (!l) sightings.set(d.pixel, (l = []));
      l.push({ pose: s.pose!, k: s.k!, x: d.x, y: d.y });
    }
  });
  const pixels: MeasuredPixel[] = [];
  const checks: number[] = [];
  for (const [pixel, ss] of sightings) {
    const tri = ss.length >= 2 ? triangulate(ss, maxPx) : null;
    if (tri && tri.rmsPx <= maxPx && tri.angleDeg >= minAngle) {
      if (anchor[pixel] && layout.mapped[pixel]) checks.push(dist(tri.X, pos(pixel)));
      if (target[pixel]) pixels.push({ pixel, X: tri.X, source: 'triangulated', views: tri.used, rmsPx: round(tri.rmsPx, 2), angleDeg: round(tri.angleDeg, 1) });
      continue;
    }
    if (!target[pixel] || !input.raycast) continue;
    // Seen once (or from too narrow an angle): where the ray meets the house.
    const s = ss[0]!;
    const ray = pixelRay(s.pose, s.k, s.x, s.y);
    const hit = input.raycast(ray.origin, ray.dir);
    if (hit) pixels.push({ pixel, X: hit, source: 'surface', views: ss.length, rmsPx: 0, angleDeg: 0 });
  }
  pixels.sort((a, b) => a.pixel - b.pixel);

  // 3. Whole runs.
  const byPixel = new Map(pixels.map((p) => [p.pixel, p]));
  const runs: RunSolve[] = input.targetRuns.map((id) => {
    const ids = runPixels(id);
    const samples = ids.map((g, i) => ({ i, p: byPixel.get(g) })).filter((s): s is { i: number; p: MeasuredPixel } => !!s.p);
    // Prefer triangulated lights; surface ones only where nothing better is near.
    const fit = fitAlongWire(samples.map((s) => ({ i: s.i, X: s.p.X, q: s.p.source === 'triangulated' ? QUALITY.triangulated : QUALITY.surface })), ids.length);
    const moved = fit.positions ? median(ids.map((g, i) => (layout.mapped[g] ? dist(fit.positions![i]!, pos(g)) : NaN)).filter(Number.isFinite)) : null;
    return {
      runId: id, count: ids.length, positions: fit.positions, quality: fit.quality,
      measured: fit.quality.filter((q) => q === QUALITY.triangulated).length,
      surface: fit.quality.filter((q) => q === QUALITY.surface).length,
      filled: fit.quality.filter((q) => q === QUALITY.filled).length,
      rejected: fit.rejected, spacing: fit.spacing, moved: moved === null ? null : round(moved, 3),
    };
  });

  const anchorCheck = checks.length ? { count: checks.length, median: round(median(checks), 4), p90: round(quantile(checks, 0.9), 4) } : null;
  return { views, pixels, runs, anchorCheck };
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

function sizeOf(input: SolveInput, id: string): [number, number] {
  const v = input.views.find((x) => x.id === id)!;
  return [v.width, v.height];
}

/**
 * Drop measured lights that don't fit the wire, then give every light a position: measured ones
 * keep theirs, the ones between are spaced along the straight line between their measured
 * neighbours, and the ends carry on in the direction of the last two measured lights.
 */
export function fitAlongWire(samples: { i: number; X: Vec3; q: number }[], count: number): { positions: Vec3[] | null; quality: number[]; rejected: number; spacing: number | null } {
  let s = [...samples].sort((a, b) => a.i - b.i);
  const quality = new Array<number>(count).fill(QUALITY.none);
  let rejected = 0;
  // The string's spacing: per measured light, the distance per light to its nearer-fitting neighbour
  // (a wrong light spoils both its links, a good one has at least one good link); then the median.
  const spacingOf = (list: typeof s) => {
    if (list.length < 2) return null;
    const link = (a: number, b: number) => dist(list[a]!.X, list[b]!.X) / (list[b]!.i - list[a]!.i);
    const r = list.map((_, k) => Math.min(k > 0 ? link(k - 1, k) : Infinity, k + 1 < list.length ? link(k, k + 1) : Infinity));
    return median(r);
  };
  let spacing = spacingOf(s);
  for (let round = 0; round < 50 && spacing !== null && s.length >= 3; round++) {
    // A light is out if it's further from its neighbours than the wire between them could reach.
    const slack = (gap: number) => gap * spacing! * 1.6 + 0.03;
    const bad = (k: number) => {
      const here = s[k]!, prev = s[k - 1], next = s[k + 1];
      const offPrev = prev ? dist(here.X, prev.X) - slack(here.i - prev.i) : -1;
      const offNext = next ? dist(here.X, next.X) - slack(next.i - here.i) : -1;
      // Interior lights must break both links (else it's the neighbour that's wrong); ends just theirs.
      return prev && next ? Math.min(offPrev, offNext) : Math.max(offPrev, offNext);
    };
    let worst = -1, worstBy = 0;
    for (let k = 0; k < s.length; k++) { const b = bad(k); if (b > worstBy) { worstBy = b; worst = k; } }
    if (worst < 0) break;
    s = s.filter((_, k) => k !== worst);
    rejected++;
    spacing = spacingOf(s);
  }
  if (s.length < 2) return { positions: null, quality, rejected, spacing };
  const out: Vec3[] = new Array(count);
  const lerp = (a: Vec3, b: Vec3, f: number): Vec3 => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  for (const m of s) { out[m.i] = m.X; quality[m.i] = m.q; }
  for (let k = 1; k < s.length; k++) {
    const a = s[k - 1]!, b = s[k]!;
    for (let i = a.i + 1; i < b.i; i++) { out[i] = lerp(a.X, b.X, (i - a.i) / (b.i - a.i)); quality[i] = QUALITY.filled; }
  }
  const first = s[0]!, second = s[1]!, last = s.at(-1)!, before = s.at(-2)!;
  for (let i = 0; i < first.i; i++) { out[i] = lerp(first.X, second.X, (i - first.i) / (second.i - first.i)); quality[i] = QUALITY.filled; }
  for (let i = last.i + 1; i < count; i++) { out[i] = lerp(before.X, last.X, (i - before.i) / (last.i - before.i)); quality[i] = QUALITY.filled; }
  return { positions: out.map((p) => [round(p[0], 4), round(p[1], 4), round(p[2], 4)] as Vec3), quality, rejected, spacing: spacing === null ? null : round(spacing, 4) };
}
