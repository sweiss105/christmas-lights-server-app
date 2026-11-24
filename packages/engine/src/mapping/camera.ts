/**
 * Pinhole camera maths shared by the simulator and the solver.
 *
 * Camera coordinates follow the usual computer-vision convention: x to the right of the picture,
 * y down, z forward (away from the camera). A pose is the rotation R and translation t taking
 * world points into camera coordinates: Xc = R·Xw + t. Pictures are in pixels with (0,0) at the top
 * left; the principal point is the picture centre and pixels are square, which suits phone video.
 */
import type { Vec3 } from '../layout.js';

/** Row-major 3×3. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export interface Pose { R: Mat3; t: Vec3 }

export interface Intrinsics { f: number; cx: number; cy: number }

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => { const n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
export const dist = (a: Vec3, b: Vec3) => norm(sub(a, b));

export const mulMV = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
export const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
export function mulMM(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
  return o;
}

/** Focal length in pixels for a horizontal field of view. */
export const focalFromFov = (width: number, hfovDeg: number) => width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
export const fovFromFocal = (width: number, f: number) => (2 * Math.atan(width / 2 / f) * 180) / Math.PI;

/** A camera at `eye` looking at `target`, with world +Y as up. */
export function lookAt(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Pose {
  const f = normalize(sub(target, eye));
  let r = cross(f, up);
  if (norm(r) < 1e-9) r = cross(f, [0, 0, 1]);
  r = normalize(r);
  const d = cross(f, r); // picture "down"
  const R: Mat3 = [r[0], r[1], r[2], d[0], d[1], d[2], f[0], f[1], f[2]];
  return { R, t: scale(mulMV(R, eye), -1) };
}

/** Camera centre in world coordinates. */
export const cameraCenter = (p: Pose): Vec3 => scale(mulMV(transpose(p.R), p.t), -1);

/** Project a world point; null if it's behind the camera. */
export function project(p: Pose, k: Intrinsics, X: Vec3): [number, number] | null {
  const c = add(mulMV(p.R, X), p.t);
  if (c[2] <= 1e-6) return null;
  return [k.f * c[0] / c[2] + k.cx, k.f * c[1] / c[2] + k.cy];
}

/** Depth of a world point in front of the camera. */
export const depth = (p: Pose, X: Vec3) => dot([p.R[6], p.R[7], p.R[8]], X) + p.t[2];

/** World-space ray (origin, unit direction) through a picture point. */
export function pixelRay(p: Pose, k: Intrinsics, x: number, y: number): { origin: Vec3; dir: Vec3 } {
  const dc: Vec3 = [(x - k.cx) / k.f, (y - k.cy) / k.f, 1];
  return { origin: cameraCenter(p), dir: normalize(mulMV(transpose(p.R), dc)) };
}

/** Rotation from a rotation vector (axis × angle, radians). */
export function rodrigues(w: Vec3): Mat3 {
  const th = norm(w);
  if (th < 1e-12) return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1];
  const [x, y, z] = [w[0] / th, w[1] / th, w[2] / th];
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
}

/** Rotation vector of a rotation matrix (inverse of rodrigues). */
export function rotationVector(R: Mat3): Vec3 {
  const tr = R[0] + R[4] + R[8];
  const cos = Math.min(1, Math.max(-1, (tr - 1) / 2));
  const th = Math.acos(cos);
  if (th < 1e-9) return [(R[7] - R[5]) / 2, (R[2] - R[6]) / 2, (R[3] - R[1]) / 2];
  if (Math.PI - th < 1e-4) {
    // Near 180°: axis from the diagonal.
    const x = Math.sqrt(Math.max(0, (R[0] + 1) / 2)), y = Math.sqrt(Math.max(0, (R[4] + 1) / 2)), z = Math.sqrt(Math.max(0, (R[8] + 1) / 2));
    const a: Vec3 = [x, R[1] >= 0 ? y : -y, R[2] >= 0 ? z : -z];
    return scale(normalize(a), th);
  }
  const k = th / (2 * Math.sin(th));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}
