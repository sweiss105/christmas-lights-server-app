/** Camera mapping, part 3b: a light's 3D position from where two or more posed views saw it. */
import type { Vec3 } from '../layout.js';
import { cameraCenter, depth, dot, normalize, project, sub, type Intrinsics, type Pose } from './camera.js';
import { levenbergMarquardt, nullVector } from './linalg.js';

export interface Sighting { pose: Pose; k: Intrinsics; x: number; y: number }

export interface Triangulated {
  X: Vec3;
  /** RMS reprojection error over the sightings used, picture pixels. */
  rmsPx: number;
  /** Widest angle between two of the rays, degrees: small angles give poor depth. */
  angleDeg: number;
  used: number;
}

/** Linear triangulation (DLT) then a least-squares polish. Drops one bad sighting when there are 3+. */
export function triangulate(ss: Sighting[], maxPx = Infinity): Triangulated | null {
  if (ss.length < 2) return null;
  let use = ss;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = solveOnce(use);
    if (!r) return null;
    const errs = use.map((s) => { const p = project(s.pose, s.k, r.X); return p ? Math.hypot(p[0] - s.x, p[1] - s.y) : Infinity; });
    const worst = errs.indexOf(Math.max(...errs));
    if (errs[worst]! <= maxPx || use.length < 3) return { ...r, used: use.length };
    use = use.filter((_, i) => i !== worst);
  }
  const r = solveOnce(use);
  return r && { ...r, used: use.length };
}

function solveOnce(ss: Sighting[]): Omit<Triangulated, 'used'> | null {
  const rows: number[][] = [];
  for (const s of ss) {
    const { R, t } = s.pose, { f, cx, cy } = s.k;
    // P = K[R|t], row by row.
    const P = [
      [f * R[0] + cx * R[6], f * R[1] + cx * R[7], f * R[2] + cx * R[8], f * t[0] + cx * t[2]],
      [f * R[3] + cy * R[6], f * R[4] + cy * R[7], f * R[5] + cy * R[8], f * t[1] + cy * t[2]],
      [R[6], R[7], R[8], t[2]],
    ];
    // Scale rows so far views don't count for less.
    const w = 1 / Math.max(1e-6, f);
    rows.push(P[2]!.map((v, j) => (s.x * v - P[0]![j]!) * w));
    rows.push(P[2]!.map((v, j) => (s.y * v - P[1]![j]!) * w));
  }
  const h = nullVector(rows, 4);
  if (Math.abs(h[3]!) < 1e-12) return null;
  let X: Vec3 = [h[0]! / h[3]!, h[1]! / h[3]!, h[2]! / h[3]!];
  const res = (p: number[]) => {
    const r = new Float64Array(ss.length * 2);
    ss.forEach((s, i) => {
      const q = project(s.pose, s.k, [p[0]!, p[1]!, p[2]!]);
      r[i * 2] = q ? q[0] - s.x : 1e3; r[i * 2 + 1] = q ? q[1] - s.y : 1e3;
    });
    return r;
  };
  X = levenbergMarquardt(X, res, { iterations: 20, steps: [1e-6, 1e-6, 1e-6] }).params as Vec3;
  if (ss.some((s) => depth(s.pose, X) <= 0)) return null;
  const r = res(X);
  let sq = 0;
  for (const v of r) sq += v * v;
  let angle = 0;
  const dirs = ss.map((s) => normalize(sub(X, cameraCenter(s.pose))));
  for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) angle = Math.max(angle, Math.acos(Math.min(1, Math.max(-1, dot(dirs[i]!, dirs[j]!)))));
  return { X, rmsPx: Math.sqrt(sq / ss.length), angleDeg: (angle * 180) / Math.PI };
}
