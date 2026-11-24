import { describe, expect, it } from 'vitest';
import { buildLayout, type Vec3 } from '../src/index.js';
import {
  cameraCenter, decompose, dist, dlt, fitAlongWire, focalFromFov, lookAt, project, rng, solveMapping, solvePose, symEig, triangulate,
  trueProjection as trueProjectionOf,
  QUALITY, type Correspondence, type SimView, type ViewInput,
} from '../src/mapping/index.js';
import { filmAndDecode, porchRuns, roughLayout, spots, truePositions } from './mapping-fixture.js';

describe('linear algebra', () => {
  it('finds eigenvalues and eigenvectors of a symmetric matrix', () => {
    const A = [4, 1, 2, 1, 3, 0, 2, 0, 5];
    const { values, vectors } = symEig(A, 3);
    for (let k = 0; k < 3; k++) {
      const v = vectors[k]!;
      for (let i = 0; i < 3; i++) expect(A[i * 3]! * v[0]! + A[i * 3 + 1]! * v[1]! + A[i * 3 + 2]! * v[2]!).toBeCloseTo(values[k]! * v[i]!, 9);
    }
    expect(values[0]).toBeLessThan(values[1]!);
  });
});

const porch = buildLayout(roughLayout);
const porchPoints = (step = 7): Vec3[] => {
  const out: Vec3[] = [];
  for (let i = 0; i < 1000; i += step) out.push([porch.positions[i * 3]!, porch.positions[i * 3 + 1]!, porch.positions[i * 3 + 2]!]);
  return out;
};

describe('camera pose', () => {
  const W = 1280, H = 720;
  const truth = lookAt([2.5, -0.5, 11], [0, 0.4, 2.5]);
  const k = { f: focalFromFov(W, 66), cx: W / 2, cy: H / 2 };
  const cs = (noise: number, outliers: number, seed = 1): Correspondence[] => {
    const r = rng(seed);
    return porchPoints().map((X) => {
      const p = project(truth, k, X)!;
      const bad = r() < outliers;
      return { X, x: bad ? r() * W : p[0] + (r() - 0.5) * 2 * noise, y: bad ? r() * H : p[1] + (r() - 0.5) * 2 * noise };
    });
  };

  it('DLT recovers an exact pose and focal length', () => {
    const c = cs(0, 0);
    const d = decompose(dlt(c)!, W / 2, H / 2, c)!;
    expect(d.f).toBeCloseTo(k.f, 3);
    expect(dist(cameraCenter(d.pose), [2.5, -0.5, 11])).toBeLessThan(1e-6);
  });

  it('finds the phone within a few centimetres despite noise and wrong codes, without knowing the focal length', () => {
    const r = solvePose(cs(1.0, 0.08), { width: W, height: H, fGuess: focalFromFov(W, 72) })!;
    expect(r).not.toBeNull();
    expect(dist(r.center, [2.5, -0.5, 11])).toBeLessThan(0.08);
    expect(Math.abs(r.k.f - k.f) / k.f).toBeLessThan(0.01);
    expect(r.rmsPx).toBeLessThan(1.2);
    expect(r.inliers.length).toBeGreaterThan(porchPoints().length * 0.85);
  });

  it('works from lights that are nearly in one plane (only the front railing seen)', () => {
    const front = porchPoints(3).filter((X) => Math.abs(X[2] - 2.5) < 0.05);
    const c = front.map((X) => { const p = project(truth, k, X)!; return { X, x: p[0], y: p[1] }; });
    const r = solvePose(c, { width: W, height: H, fGuess: k.f, fixFocal: true })!;
    expect(r).not.toBeNull();
    expect(dist(r.center, [2.5, -0.5, 11])).toBeLessThan(0.05);
  });
});

describe('triangulation', () => {
  it('puts a light where two views saw it', () => {
    const W = 1280, H = 720, k = { f: focalFromFov(W, 66), cx: W / 2, cy: H / 2 };
    const a = lookAt([-4, 0, 10], [0, 0.5, 3]), b = lookAt([4, 0, 10], [0, 0.5, 3]);
    const X: Vec3 = [0.7, 1.1, 2.6];
    const pa = project(a, k, X)!, pb = project(b, k, X)!;
    const t = triangulate([{ pose: a, k, x: pa[0], y: pa[1] }, { pose: b, k, x: pb[0], y: pb[1] }])!;
    expect(dist(t.X, X)).toBeLessThan(1e-6);
    expect(t.angleDeg).toBeGreaterThan(40);
  });
});

describe('filling a run along the wire', () => {
  it('interpolates between measured lights, carries on at the ends and drops a light that is off the wire', () => {
    const line = (i: number): Vec3 => [i * 0.02, 1, 0];
    const samples = [5, 15, 25, 35, 45].map((i) => ({ i, X: line(i), q: QUALITY.triangulated }));
    samples[2] = { i: 25, X: [0.5, 1.6, 0.3], q: QUALITY.triangulated }; // 60 cm off
    const r = fitAlongWire(samples, 50);
    expect(r.rejected).toBe(1);
    expect(r.spacing).toBeCloseTo(0.02, 4);
    for (let i = 0; i < 50; i++) expect(dist(r.positions![i]!, line(i))).toBeLessThan(1e-3);
    expect(r.quality[5]).toBe(QUALITY.triangulated);
    expect(r.quality[25]).toBe(QUALITY.filled);
    expect(r.quality[0]).toBe(QUALITY.filled);
  });

  it('keeps the run’s own shape (a coil) between measured lights, shifted onto them', () => {
    const coil = (i: number, dx = 0): Vec3 => [i * 0.015 + dx, 1 + 0.04 * Math.cos(i * 0.6), 0.04 * Math.sin(i * 0.6)];
    const model = Array.from({ length: 60 }, (_, i) => coil(i));
    // The real string is 10 cm further right than the model says.
    const samples = [3, 13, 23, 33, 43, 53].map((i) => ({ i, X: coil(i, 0.1), q: QUALITY.triangulated }));
    const r = fitAlongWire(samples, 60, model);
    for (let i = 0; i < 60; i++) expect(dist(r.positions![i]!, coil(i, 0.1))).toBeLessThan(1e-3);
    const straight = fitAlongWire(samples, 60);
    expect(Math.max(...Array.from({ length: 60 }, (_, i) => dist(straight.positions![i]!, coil(i, 0.1))))).toBeGreaterThan(0.03);
  });
});

describe('lights seen from one spot only', () => {
  it('go where the ray meets the house model when nothing else is known', () => {
    // A string lying flat on a wall at z = 0.2 (the "house"), filmed from one spot; the porch places the camera.
    const layout = { ...roughLayout, runs: [...porchRuns, { id: 'wall', controller: 'yard', start: 0, count: 60, points: [[-2, 2.2, 0.2], [2, 2.6, 0.2]] as Vec3[] }] };
    const truth = buildLayout(layout).positions;
    const view: SimView = { eye: [1, 0, 11], target: [0, 1, 2], hfovDeg: 66, width: 1280, height: 720 };
    const proj = trueProjectionOf(truth, view);
    const detections = [...Array(truth.length / 3).keys()].filter((i) => i % 5 === 0 && Number.isFinite(proj[i * 2])).map((pixel) => ({ pixel, x: proj[pixel * 2]!, y: proj[pixel * 2 + 1]! }));
    const wall = (o: Vec3, d: Vec3): Vec3 | null => { const t = (0.2 - o[2]) / d[2]; return t > 0 ? [o[0] + d[0] * t, o[1] + d[1] * t, 0.2] : null; };
    const shifted = { ...layout, runs: layout.runs.map((r) => (r.id === 'wall' ? { ...r, points: [[-2, 1.5, 0.2], [2, 1.5, 0.2]] as Vec3[] } : r)) };
    const res = solveMapping({ layout: shifted, views: [{ id: 'a', width: 1280, height: 720, detections }], anchorRuns: porchRuns.map((r) => r.id), targetRuns: ['wall'], raycast: wall });
    const run = res.runs[0]!;
    expect(run.oneView).toBeGreaterThan(10);
    const base = buildLayout(layout).controllerOffset.get('yard')!;
    const errs = run.positions!.map((p, i) => dist(p, [truth[(base + i) * 3]!, truth[(base + i) * 3 + 1]!, truth[(base + i) * 3 + 2]!])).sort((a, b) => a - b);
    expect(errs[errs.length >> 1]!).toBeLessThan(0.01);
    expect(errs.at(-1)!).toBeLessThan(0.04); // the ends carry on in the drawn (level) direction
  });
});

describe('mapping end to end with the synthetic camera', () => {
  it('films three spots, places the cameras from the porch and measures the new strings to a few centimetres', () => {
    const W = 960, H = 540;
    const views: ViewInput[] = spots.map((s, i) => {
      const view: SimView = { ...s, hfovDeg: 67, width: W, height: H };
      const { result } = filmAndDecode(view, { seed: 20 + i, clockErrorMs: [150, -300, 420][i] });
      expect(result.ok).toBe(true);
      return { id: `spot${i + 1}`, width: W, height: H, detections: result.detections };
    });
    const truth = truePositions();
    const res = solveMapping({ layout: roughLayout, views, anchorRuns: porchRuns.map((r) => r.id), targetRuns: ['handrail', 'bush'] });

    for (const [i, v] of res.views.entries()) {
      expect(v.ok, v.reason).toBe(true);
      expect(dist(v.center!, spots[i]!.eye)).toBeLessThan(0.15);
      expect(Math.abs(v.fovDeg! - 67)).toBeLessThan(1.5);
    }
    // Porch lights triangulated from the solved cameras land on the model (which itself is ±1 cm).
    expect(res.anchorCheck!.median).toBeLessThan(0.025);

    const layout = buildLayout(roughLayout);
    for (const run of res.runs) {
      expect(run.positions, run.runId).not.toBeNull();
      const base = layout.controllerOffset.get('yard')! + roughLayout.runs.find((r) => r.id === run.runId)!.start;
      const errs = { measured: [] as number[], filled: [] as number[] };
      run.positions!.forEach((p, i) => {
        const g = base + i;
        const e = dist(p, [truth[g * 3]!, truth[g * 3 + 1]!, truth[g * 3 + 2]!]);
        if (run.quality[i] === QUALITY.triangulated) errs.measured.push(e); else errs.filled.push(e);
      });
      const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;
      const p90 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.9)]!;
      expect(run.measured, run.runId).toBeGreaterThan(run.count * 0.12);
      expect(med(errs.measured), `${run.runId} measured median`).toBeLessThan(0.03);
      expect(p90(errs.measured), `${run.runId} measured p90`).toBeLessThan(0.06);
      expect(med(errs.filled), `${run.runId} filled median`).toBeLessThan(0.05);
      expect(run.spacing!).toBeGreaterThan(0.015);
      expect(run.moved!).toBeGreaterThan(0.1); // the rough guess was well off
    }
  }, 120_000);

  it('can check the porch itself: one string trusted, the other measured', () => {
    const W = 960, H = 540;
    const views: ViewInput[] = [spots[0]!, spots[2]!].map((s, i) => {
      const { result } = filmAndDecode({ ...s, hfovDeg: 67, width: W, height: H }, { seed: 40 + i, passes: 1 });
      return { id: `v${i}`, width: W, height: H, detections: result.detections };
    });
    const res = solveMapping({ layout: roughLayout, views, anchorRuns: ['gpio16'], targetRuns: ['gpio12'] });
    expect(res.views.every((v) => v.ok)).toBe(true);
    const run = res.runs[0]!;
    expect(run.positions).not.toBeNull();
    // The measured string is where the model put it, to within the model's own error and a coil's width.
    expect(run.moved!).toBeLessThan(0.025);
  }, 120_000);
});
