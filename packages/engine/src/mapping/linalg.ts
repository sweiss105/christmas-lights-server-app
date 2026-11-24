/** Small dense linear algebra for the solver (matrices are row-major Float64Arrays). */

/**
 * Eigen-decomposition of a symmetric n×n matrix by cyclic Jacobi rotations. Returns eigenvalues in
 * ascending order with their unit eigenvectors (vectors[k] belongs to values[k]).
 */
export function symEig(A: ArrayLike<number>, n: number): { values: number[]; vectors: number[][] } {
  const a = Float64Array.from(A);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q]! ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = a[p * n + q]!;
      if (Math.abs(apq) < 1e-300) continue;
      const app = a[p * n + p]!, aqq = a[q * n + q]!;
      const theta = (aqq - app) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {
        const akp = a[k * n + p]!, akq = a[k * n + q]!;
        a[k * n + p] = c * akp - s * akq; a[k * n + q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = a[p * n + k]!, aqk = a[q * n + k]!;
        a[p * n + k] = c * apk - s * aqk; a[q * n + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = v[k * n + p]!, vkq = v[k * n + q]!;
        v[k * n + p] = c * vkp - s * vkq; v[k * n + q] = s * vkp + c * vkq;
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i * n + i]! - a[j * n + j]!);
  return { values: order.map((i) => a[i * n + i]!), vectors: order.map((i) => Array.from({ length: n }, (_, k) => v[k * n + i]!)) };
}

/** Unit vector x minimising |A x| for an m×n matrix A (the null space in least squares). */
export function nullVector(rows: number[][], n: number): number[] {
  const ata = new Float64Array(n * n);
  for (const r of rows) for (let i = 0; i < n; i++) { const ri = r[i]!; if (ri === 0) continue; for (let j = 0; j < n; j++) ata[i * n + j]! += ri * r[j]!; }
  return symEig(ata, n).vectors[0]!;
}

/** Solve A x = b (n×n) by Gaussian elimination with partial pivoting; null if singular. */
export function solveLinear(A: ArrayLike<number>, b: ArrayLike<number>, n: number): number[] | null {
  const m = Float64Array.from(A), y = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r * n + c]!) > Math.abs(m[p * n + c]!)) p = r;
    if (Math.abs(m[p * n + c]!) < 1e-14) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) { const t = m[c * n + k]!; m[c * n + k] = m[p * n + k]!; m[p * n + k] = t; }
      const t = y[c]!; y[c] = y[p]!; y[p] = t;
    }
    for (let r = c + 1; r < n; r++) {
      const f = m[r * n + c]! / m[c * n + c]!;
      if (f === 0) continue;
      for (let k = c; k < n; k++) m[r * n + k]! -= f * m[c * n + k]!;
      y[r]! -= f * y[c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = y[r]!;
    for (let k = r + 1; k < n; k++) s -= m[r * n + k]! * x[k]!;
    x[r] = s / m[r * n + r]!;
  }
  return x;
}

/**
 * Levenberg–Marquardt on a residual function with a numeric Jacobian and per-residual weights from
 * a robust (Huber) loss, so a few bad points can't drag the fit. Returns the refined parameters.
 */
export function levenbergMarquardt(
  params: number[],
  residuals: (p: number[]) => Float64Array,
  opts: { iterations?: number; huber?: number; steps?: number[] } = {},
): { params: number[]; cost: number } {
  const n = params.length;
  let p = params.slice();
  let lambda = 1e-3;
  const huber = opts.huber ?? Infinity;
  const cost = (r: Float64Array) => {
    let c = 0;
    for (const v of r) { const a = Math.abs(v); c += a <= huber ? 0.5 * v * v : huber * (a - 0.5 * huber); }
    return c;
  };
  let r = residuals(p);
  let c = cost(r);
  for (let it = 0; it < (opts.iterations ?? 40); it++) {
    const m = r.length;
    const J: Float64Array[] = [];
    for (let j = 0; j < n; j++) {
      const h = opts.steps?.[j] ?? 1e-6 * Math.max(1, Math.abs(p[j]!));
      const q = p.slice(); q[j]! += h;
      const rq = residuals(q);
      const col = new Float64Array(m);
      for (let i = 0; i < m; i++) col[i] = (rq[i]! - r[i]!) / h;
      J.push(col);
    }
    // Huber via iteratively reweighted least squares.
    const w = new Float64Array(m);
    for (let i = 0; i < m; i++) { const a = Math.abs(r[i]!); w[i] = a <= huber ? 1 : huber / a; }
    const JtJ = new Float64Array(n * n), Jtr = new Float64Array(n);
    for (let a = 0; a < n; a++) {
      const ca = J[a]!;
      let s = 0;
      for (let i = 0; i < m; i++) s += ca[i]! * w[i]! * r[i]!;
      Jtr[a] = s;
      for (let b = a; b < n; b++) {
        const cb = J[b]!;
        let t = 0;
        for (let i = 0; i < m; i++) t += ca[i]! * w[i]! * cb[i]!;
        JtJ[a * n + b] = t; JtJ[b * n + a] = t;
      }
    }
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const A = Float64Array.from(JtJ);
      for (let d = 0; d < n; d++) A[d * n + d]! += lambda * (JtJ[d * n + d]! || 1);
      const step = solveLinear(A, Jtr.map((v) => -v), n);
      if (!step) { lambda *= 10; continue; }
      const q = p.map((v, i) => v + step[i]!);
      const rq = residuals(q);
      const cq = cost(rq);
      if (Number.isFinite(cq) && cq < c) {
        const done = (c - cq) < 1e-10 * (1 + c);
        p = q; r = rq; c = cq; lambda = Math.max(1e-9, lambda / 5); improved = true;
        if (done) return { params: p, cost: c };
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return { params: p, cost: c };
}
