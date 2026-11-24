/**
 * Camera mapping, part 3a: where was the phone? Solves a view's camera pose (and focal length)
 * from lights whose 3D positions are already trusted and whose picture positions were decoded.
 *
 * - Hypotheses come from the Direct Linear Transform (DLT) on random samples of 10 points (RANSAC;
 *   decoded codes are almost never wrong, so small clean samples are likely), plus a few starts
 *   from typical yard positions, which also works when the trusted lights are nearly in one plane.
 * - Each hypothesis is scored by how many points it projects to within a few pixels; the best is
 *   refined with Levenberg–Marquardt (rotation, translation and focal length) under a robust loss.
 */
import type { Vec3 } from '../layout.js';
import {
  add, cameraCenter, dot, lookAt, mulMV, normalize, project, rodrigues, rotationVector, sub, type Intrinsics, type Mat3, type Pose,
} from './camera.js';
import { levenbergMarquardt, nullVector } from './linalg.js';
import { rng } from './simulate.js';

export interface Correspondence { X: Vec3; x: number; y: number }

export interface PoseResult {
  pose: Pose;
  k: Intrinsics;
  /** Indices of the correspondences that fit. */
  inliers: number[];
  /** RMS reprojection error of the inliers, picture pixels. */
  rmsPx: number;
  center: Vec3;
}

export interface PoseOptions {
  width: number;
  height: number;
  /** Starting focal length in pixels. */
  fGuess: number;
  /** Keep the focal length fixed (e.g. shared from other views). */
  fixFocal?: boolean;
  /** Inlier threshold, picture pixels. */
  thresholdPx?: number;
  iterations?: number;
  seed?: number;
}

/** Projection matrix (3×4, row-major) from 6+ correspondences, with Hartley normalisation. */
export function dlt(cs: Correspondence[]): number[] | null {
  const n = cs.length;
  if (n < 6) return null;
  let mx = 0, my = 0, mX = 0, mY = 0, mZ = 0;
  for (const c of cs) { mx += c.x; my += c.y; mX += c.X[0]; mY += c.X[1]; mZ += c.X[2]; }
  mx /= n; my /= n; mX /= n; mY /= n; mZ /= n;
  let d2 = 0, d3 = 0;
  for (const c of cs) { d2 += Math.hypot(c.x - mx, c.y - my); d3 += Math.hypot(c.X[0] - mX, c.X[1] - mY, c.X[2] - mZ); }
  const s2 = Math.SQRT2 / (d2 / n || 1), s3 = Math.sqrt(3) / (d3 / n || 1);
  const rows: number[][] = [];
  for (const c of cs) {
    const X = (c.X[0] - mX) * s3, Y = (c.X[1] - mY) * s3, Z = (c.X[2] - mZ) * s3;
    const u = (c.x - mx) * s2, v = (c.y - my) * s2;
    rows.push([X, Y, Z, 1, 0, 0, 0, 0, -u * X, -u * Y, -u * Z, -u]);
    rows.push([0, 0, 0, 0, X, Y, Z, 1, -v * X, -v * Y, -v * Z, -v]);
  }
  const p = nullVector(rows, 12);
  // Undo the normalisation: P = T2⁻¹ · P̃ · T3.
  const T3 = [s3, 0, 0, -s3 * mX, 0, s3, 0, -s3 * mY, 0, 0, s3, -s3 * mZ, 0, 0, 0, 1];
  const T2inv = [1 / s2, 0, mx, 0, 1 / s2, my, 0, 0, 1];
  const A = new Array(12).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += p[i * 4 + k]! * T3[k * 4 + j]!; A[i * 4 + j] = s; }
  const P = new Array(12).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 3; k++) s += T2inv[i * 3 + k]! * A[k * 4 + j]; P[i * 4 + j] = s; }
  return P;
}

/**
 * Split P = K [R | t] (RQ by Gram–Schmidt from the bottom row) into a pose and a focal length,
 * taking the principal point as the picture centre. Null if it puts the camera the wrong way round.
 */
export function decompose(P: number[], cx: number, cy: number, sample: Correspondence[]): { pose: Pose; f: number } | null {
  for (const sign of [1, -1]) {
    const m = P.map((v) => v * sign);
    const m1: Vec3 = [m[0]!, m[1]!, m[2]!], m2: Vec3 = [m[4]!, m[5]!, m[6]!], m3: Vec3 = [m[8]!, m[9]!, m[10]!];
    const k22 = Math.hypot(...m3);
    if (k22 === 0) return null;
    const r3: Vec3 = [m3[0] / k22, m3[1] / k22, m3[2] / k22];
    const k12 = dot(m2, r3);
    const u2 = sub(m2, [r3[0] * k12, r3[1] * k12, r3[2] * k12]);
    const k11 = Math.hypot(...u2);
    const r2 = normalize(u2);
    const k02 = dot(m1, r3), k01 = dot(m1, r2);
    const u1 = sub(sub(m1, [r2[0] * k01, r2[1] * k01, r2[2] * k01]), [r3[0] * k02, r3[1] * k02, r3[2] * k02]);
    const k00 = Math.hypot(...u1);
    const r1 = normalize(u1);
    const R: Mat3 = [...r1, ...r2, ...r3] as Mat3;
    const det = r1[0] * (r2[1] * r3[2] - r2[2] * r3[1]) - r1[1] * (r2[0] * r3[2] - r2[2] * r3[0]) + r1[2] * (r2[0] * r3[1] - r2[1] * r3[0]);
    if (det < 0) continue;
    // t = K⁻¹ p4, with K upper triangular [[k00,k01,k02],[0,k11,k12],[0,0,k22]].
    const p4: Vec3 = [m[3]!, m[7]!, m[11]!];
    const t2 = p4[2] / k22, t1 = (p4[1] - k12 * t2) / k11, t0 = (p4[0] - k01 * t1 - k02 * t2) / k00;
    const pose: Pose = { R, t: [t0, t1, t2] };
    const front = sample.filter((c) => dot([R[6], R[7], R[8]], c.X) + t2 > 0).length;
    if (front < sample.length * 0.8) return null;
    void cx; void cy;
    return { pose, f: (k00 + k11) / 2 / k22 };
  }
  return null;
}

const reprojErr = (pose: Pose, k: Intrinsics, c: Correspondence) => {
  const p = project(pose, k, c.X);
  return p ? Math.hypot(p[0] - c.x, p[1] - c.y) : Infinity;
};

function score(pose: Pose, k: Intrinsics, cs: Correspondence[], thr: number) {
  const inliers: number[] = [];
  let sq = 0;
  cs.forEach((c, i) => { const e = reprojErr(pose, k, c); if (e < thr) { inliers.push(i); sq += e * e; } });
  return { inliers, rms: inliers.length ? Math.sqrt(sq / inliers.length) : Infinity };
}

/** Refine pose (and focal length unless fixed) on the given points. */
export function refinePose(pose: Pose, f: number, cs: Correspondence[], o: { cx: number; cy: number; fixFocal?: boolean; huber?: number }): { pose: Pose; f: number } {
  const w0 = rotationVector(pose.R);
  const start = [...w0, ...pose.t, f];
  const fixed = o.fixFocal;
  const res = (p: number[]) => {
    const R = rodrigues([p[0]!, p[1]!, p[2]!]);
    const t: Vec3 = [p[3]!, p[4]!, p[5]!];
    const ff = fixed ? f : p[6]!;
    const r = new Float64Array(cs.length * 2);
    cs.forEach((c, i) => {
      const q = add(mulMV(R, c.X), t);
      const z = Math.max(1e-6, q[2]);
      r[i * 2] = ff * q[0] / z + o.cx - c.x;
      r[i * 2 + 1] = ff * q[1] / z + o.cy - c.y;
    });
    return r;
  };
  const steps = [1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-3];
  const out = levenbergMarquardt(fixed ? start.slice(0, 6) : start, res, { huber: o.huber ?? 2, iterations: 50, steps });
  const p = out.params;
  return { pose: { R: rodrigues([p[0]!, p[1]!, p[2]!]), t: [p[3]!, p[4]!, p[5]!] }, f: fixed ? f : p[6]! };
}

/** Robust camera pose from trusted points; null if there's no consistent fit. */
export function solvePose(cs: Correspondence[], o: PoseOptions): PoseResult | null {
  if (cs.length < 8) return null;
  const cx = o.width / 2, cy = o.height / 2;
  const thr = o.thresholdPx ?? Math.max(3, 0.005 * Math.max(o.width, o.height));
  const rand = rng(o.seed ?? 12345);
  type Cand = { pose: Pose; f: number };
  const cands: Cand[] = [];
  const fOk = (f: number) => o.fixFocal ? true : f > o.fGuess * 0.35 && f < o.fGuess * 3;

  // RANSAC with DLT on samples of 10.
  const iters = o.iterations ?? 200;
  const sampleSize = Math.min(10, cs.length);
  let best = { n: 0, cand: null as Cand | null };
  for (let it = 0; it < iters; it++) {
    const idx = new Set<number>();
    while (idx.size < sampleSize) idx.add(Math.floor(rand() * cs.length));
    const sample = [...idx].map((i) => cs[i]!);
    const P = dlt(sample);
    if (!P) continue;
    const d = decompose(P, cx, cy, sample);
    if (!d || !Number.isFinite(d.f) || !fOk(d.f)) continue;
    const f = o.fixFocal ? o.fGuess : d.f;
    const s = score(d.pose, { f, cx, cy }, cs, thr * 3);
    if (s.inliers.length > best.n) best = { n: s.inliers.length, cand: { pose: d.pose, f } };
    if (best.n > cs.length * 0.9 && it > 30) break;
  }
  if (best.cand) cands.push(best.cand);

  // Starts from typical spots in the yard, looking at the middle of the trusted lights.
  const mid: Vec3 = [0, 0, 0];
  for (const c of cs) { mid[0] += c.X[0] / cs.length; mid[1] += c.X[1] / cs.length; mid[2] += c.X[2] / cs.length; }
  for (const dist of [6, 12, 20]) for (const az of [-50, -20, 0, 20, 50]) {
    const a = (az * Math.PI) / 180;
    const eye: Vec3 = [mid[0] + dist * Math.sin(a), mid[1] + 0.5, mid[2] + dist * Math.cos(a)];
    cands.push({ pose: lookAt(eye, mid), f: o.fGuess });
  }

  let bestFit: PoseResult | null = null;
  for (const cand of cands) {
    // Coarse refine on everything with a wide robust loss, then on the inliers with a tight one.
    let { pose, f } = refinePose(cand.pose, cand.f, cs, { cx, cy, fixFocal: true, huber: 20 });
    if (!o.fixFocal) ({ pose, f } = refinePose(pose, f, cs, { cx, cy, huber: 10 }));
    if (!fOk(f)) continue;
    for (let round = 0; round < 3; round++) {
      const s = score(pose, { f, cx, cy }, cs, thr * (round === 0 ? 3 : 1));
      if (s.inliers.length < 6) break;
      ({ pose, f } = refinePose(pose, f, s.inliers.map((i) => cs[i]!), { cx, cy, fixFocal: o.fixFocal, huber: thr / 2 }));
    }
    if (!fOk(f)) continue;
    const s = score(pose, { f, cx, cy }, cs, thr);
    if (!bestFit || s.inliers.length > bestFit.inliers.length || (s.inliers.length === bestFit.inliers.length && s.rms < bestFit.rmsPx)) {
      bestFit = { pose, k: { f, cx, cy }, inliers: s.inliers, rmsPx: s.rms, center: cameraCenter(pose) };
    }
  }
  if (!bestFit || bestFit.inliers.length < Math.max(8, cs.length * 0.3)) return null;
  return bestFit;
}
