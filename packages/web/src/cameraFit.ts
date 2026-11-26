/**
 * Camera framing for the preview's views: where to put the camera so a set of points fills the
 * visible part of the screen (the area between the panels), seen from a given angle.
 */

export type V3 = [number, number, number];

export interface Box { min: V3; max: V3 }

export interface Fit { position: V3; target: V3 }

/** The house model's world box, and which loaded parts it covers. */
export interface HouseBounds {
  box: Box;
  /** Points that outline the model (e.g. the corners of each mesh's box). */
  points: V3[];
  /** Which loaded parts these cover. */
  key: string;
}

/**
 * Places a perspective camera looking from `azimuth` (around the vertical axis, 0 = from +z) and
 * `polar` (from straight up) so every point fits within `tanX`/`tanY` (the tangents of half the
 * visible field of view, horizontally and vertically). The target is shifted sideways and up or
 * down so the points sit centred, and the distance is the smallest that fits them all.
 */
export function fitPoints(points: V3[], azimuth: number, polar: number, tanX: number, tanY: number, minDepth = 0.5): Fit {
  // Camera axes: `back` points from the target to the camera.
  const sp = Math.sin(polar);
  const back: V3 = [sp * Math.sin(azimuth), Math.cos(polar), sp * Math.cos(azimuth)];
  const right: V3 = [Math.cos(azimuth), 0, -Math.sin(azimuth)]; // up × back, normalised
  const up = cross(back, right);
  const c = centroid(points);
  const local = points.map((p) => {
    const q: V3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    return { x: dot(q, right), y: dot(q, up), z: dot(q, back) };
  });
  // A point is visible when |x - a| <= tan * (d - z), for target offset a and distance d. A shared
  // offset exists for both sides when d >= (max(x/tan + z) + max(-x/tan + z)) / 2.
  const need = (tan: number, k: 'x' | 'y') =>
    (Math.max(...local.map((p) => p[k] / tan + p.z)) + Math.max(...local.map((p) => -p[k] / tan + p.z))) / 2;
  const d = Math.max(need(tanX, 'x'), need(tanY, 'y'), Math.max(...local.map((p) => p.z)) + minDepth);
  // Centre the points on screen: the offset where the leftmost and rightmost (or lowest and highest)
  // points land equally far from the middle. Their sum falls as the offset grows, so halve the range.
  const offset = (k: 'x' | 'y') => {
    const xs = local.map((p) => p[k]);
    let lo = Math.min(...xs);
    let hi = Math.max(...xs);
    for (let i = 0; i < 50; i++) {
      const a = (lo + hi) / 2;
      const s = local.map((p) => (p[k] - a) / (d - p.z));
      if (Math.max(...s) + Math.min(...s) > 0) lo = a; else hi = a;
    }
    return (lo + hi) / 2;
  };
  const a = offset('x');
  const b = offset('y');
  const target: V3 = [c[0] + right[0] * a + up[0] * b, c[1] + right[1] * a + up[1] * b, c[2] + right[2] * a + up[2] * b];
  return { target, position: [target[0] + back[0] * d, target[1] + back[1] * d, target[2] + back[2] * d] };
}

export function corners(box: Box): V3[] {
  const out: V3[] = [];
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) out.push([x, y, z]);
  return out;
}

export function union(a: Box, b: Box): Box {
  return { min: [0, 1, 2].map((i) => Math.min(a.min[i]!, b.min[i]!)) as V3, max: [0, 1, 2].map((i) => Math.max(a.max[i]!, b.max[i]!)) as V3 };
}

/** `box` cut down to `limit` on each axis (keeps at least the limit's own extent when they don't overlap). */
export function clip(box: Box, limit: Box): Box {
  const min = [0, 1, 2].map((i) => Math.min(Math.max(box.min[i]!, limit.min[i]!), limit.max[i]!)) as V3;
  const max = [0, 1, 2].map((i) => Math.max(Math.min(box.max[i]!, limit.max[i]!), min[i]!)) as V3;
  return { min, max };
}

export type View = 'house' | 'front' | 'close' | 'angle' | 'top';

/**
 * Viewing angle for each view (radians: azimuth around the vertical axis, 0 = from the street;
 * polar from straight up) and the margin around the framed box, as a fraction of the visible
 * half-width or half-height, without and with a house model.
 */
export const VIEW_ANGLES: Record<View, { azimuth: number; polar: number; margin: number; houseMargin: number }> = {
  house: { azimuth: 0, polar: 1.22, margin: 0.18, houseMargin: 0.04 },
  front: { azimuth: 0, polar: 1.3, margin: 0.18, houseMargin: 0.05 },
  close: { azimuth: 0, polar: 1.42, margin: 0.04, houseMargin: 0.04 },
  angle: { azimuth: -0.62, polar: 1.12, margin: 0.15, houseMargin: 0.05 },
  top: { azimuth: 0, polar: 0.02, margin: 0.18, houseMargin: 0.04 },
};

/**
 * The part of the scene each view frames. Without a house model every view frames the lights.
 * With one: House and Top take in the whole model (house, yard, stairs and walk); Front the house
 * from the porch lights up to the roof; Close the lights; Angle the house as wide as the porch, and
 * the yard in front of it down to the street.
 */
export function viewRegion(view: View, lights: Box, house: Box | null): Box {
  if (!house || view === 'close') return lights;
  if (view === 'house' || view === 'top') return house;
  const width = lights.max[0] - lights.min[0];
  const around = Math.max(1, width * 0.15);
  if (view === 'front') {
    return union(lights, clip(house, {
      min: [lights.min[0] - around, lights.min[1], house.min[2]],
      max: [lights.max[0] + around, house.max[1], lights.max[2]],
    }));
  }
  return union(lights, clip(house, {
    min: [lights.min[0] - around, house.min[1], house.min[2]],
    max: [lights.max[0] + around, house.max[1], house.max[2]],
  }));
}

/**
 * The points a view keeps in frame: the lights' box corners, plus the model's outline (the corners
 * of each of its pieces) pulled into the view's region. The outline hugs the model much better than
 * the corners of its overall box, which a long lawn and a tall roof would make a tall block.
 */
export function viewPoints(view: View, lights: Box, house: HouseBounds | null): V3[] {
  const region = viewRegion(view, lights, house?.box ?? null);
  if (!house || view === 'close') return corners(region);
  const inside = house.points.map((p) => [0, 1, 2].map((i) => Math.min(Math.max(p[i]!, region.min[i]!), region.max[i]!)) as V3);
  return [...inside, ...corners(lights)];
}

function dot(a: V3, b: V3) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: V3, b: V3): V3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function centroid(points: V3[]): V3 {
  const s: V3 = [0, 0, 0];
  for (const p of points) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
  const n = Math.max(1, points.length);
  return [s[0] / n, s[1] / n, s[2] / n];
}

/**
 * What the camera frames: the picked view (picking it again frames it again), where the lights are
 * and which house parts are loaded. A reloaded copy of the same layout gives the same key, so a
 * refresh (e.g. after Go) doesn't count as a change.
 */
export function framingKey(lights: { count: number; bounds: Box }, view: { name: string; nonce: number }, houseKey: string): string {
  return [view.name, view.nonce, lights.count, ...lights.bounds.min, ...lights.bounds.max, houseKey].join('|');
}

/**
 * Whether to frame the view again. A new framing always does. Otherwise (only the panels or the
 * window changed) an untouched view re-centres, but a view the user has moved stays where they put it.
 */
export function shouldReframe(lastKey: string | null, key: string, userMoved: boolean): boolean {
  return key !== lastKey || !userMoved;
}
