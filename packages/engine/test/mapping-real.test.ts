/**
 * Solver behaviour learnt from the first real night (2026-11-24): spots close to the lights, the
 * ultra wide lens with some barrel distortion, and spots filmed with different lenses.
 */
import { describe, expect, it } from 'vitest';
import { buildLayout, type Vec3 } from '../src/index.js';
import { dist, focalFromFov, lookAt, project, rng, solveMapping, solvePose, type Intrinsics, type Pose, type ViewInput } from '../src/mapping/index.js';
import { porchRuns } from './mapping-fixture.js';

const layoutConfig = { controllers: [{ id: 'porch', name: 'Porch', host: '192.0.2.1', pixelCount: 1101 }], runs: porchRuns };
const layout = buildLayout(layoutConfig);
const pos = (i: number): Vec3 => [layout.positions[i * 3]!, layout.positions[i * 3 + 1]!, layout.positions[i * 3 + 2]!];

/** Every `step`-th light as the camera sees it, with a little noise; lights outside the picture are left out. */
function sighting(pose: Pose, k: Intrinsics, w: number, h: number, step: number, noisePx: number, seed: number) {
  const rand = rng(seed);
  const out: { pixel: number; x: number; y: number; X: Vec3 }[] = [];
  for (let i = 0; i < layout.count; i += step) {
    if (!layout.mapped[i]) continue;
    const p = project(pose, k, pos(i));
    if (!p || p[0] < 0 || p[1] < 0 || p[0] >= w || p[1] >= h) continue;
    out.push({ pixel: i, x: p[0] + (rand() - 0.5) * 2 * noisePx, y: p[1] + (rand() - 0.5) * 2 * noisePx, X: pos(i) });
  }
  return out;
}

describe('placing the camera from real-world spots', () => {
  it('finds a camera close to the lights (on the front steps, 2–3 m away)', () => {
    const eye: Vec3 = [0, 0.6, 5];
    const pose = lookAt(eye, [0, 0.8, 2.5]);
    const k = { f: focalFromFov(1280, 104), cx: 640, cy: 360 };
    const cs = sighting(pose, k, 1280, 720, 10, 2, 1);
    expect(cs.length).toBeGreaterThan(30);
    const r = solvePose(cs, { width: 1280, height: 720, fGuess: focalFromFov(1280, 70), thresholdPx: 20 })!;
    expect(r).not.toBeNull();
    expect(dist(r.center, eye)).toBeLessThan(0.2);
  });

  it('allows for a wide lens’s barrel distortion', () => {
    const eye: Vec3 = [-1.5, 1.2, 6];
    const pose = lookAt(eye, [0, 0.7, 2.5]);
    const k = { f: focalFromFov(1280, 104), cx: 640, cy: 360, k1: -0.12 };
    const cs = sighting(pose, k, 1280, 720, 8, 1, 2);
    const r = solvePose(cs, { width: 1280, height: 720, fGuess: focalFromFov(1280, 104), thresholdPx: 20 })!;
    expect(r).not.toBeNull();
    expect(r.rmsPx).toBeLessThan(3);
    expect(r.k.k1!).toBeLessThan(-0.05);
    expect(dist(r.center, eye)).toBeLessThan(0.25);
  });

  it('places spots filmed with different lenses without forcing one focal length on all', () => {
    const shots = [
      { eye: [-2, 1, 7] as Vec3, fov: 68, camera: 'Back Triple Camera@1' },
      { eye: [2, 1, 7] as Vec3, fov: 68, camera: 'Back Triple Camera@1' },
      { eye: [0, 0.8, 5] as Vec3, fov: 104, camera: 'Back Ultra Wide Camera@1' },
    ];
    const views: ViewInput[] = shots.map((s, i) => {
      const pose = lookAt(s.eye, [0, 0.8, 2.5]);
      const ds = sighting(pose, { f: focalFromFov(1280, s.fov), cx: 640, cy: 360 }, 1280, 720, 10, 1, 10 + i);
      return { id: `v${i}`, width: 1280, height: 720, camera: s.camera, detections: ds.map(({ pixel, x, y }) => ({ pixel, x, y })) };
    });
    const r = solveMapping({ layout: layoutConfig, views, anchorRuns: ['gpio16', 'gpio12'], targetRuns: [] });
    r.views.forEach((v, i) => {
      expect(v.ok).toBe(true);
      expect(Math.abs(v.fovDeg! - shots[i]!.fov)).toBeLessThan(4);
      expect(dist(v.center!, shots[i]!.eye)).toBeLessThan(0.3);
    });
  });
});
