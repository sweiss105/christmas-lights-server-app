import { describe, expect, it } from 'vitest';
import { corners, fitPoints, viewPoints, viewRegion, type Box, type V3 } from '../src/cameraFit';

/** Where a point lands on screen (-1..1 when it is within tanX/tanY) for a camera looking at `target`. */
function project(p: V3, fit: { position: V3; target: V3 }, tanX: number, tanY: number) {
  const back = norm(sub(fit.position, fit.target));
  const right = norm(cross([0, 1, 0], back));
  const up = cross(back, right);
  const q = sub(p, fit.position);
  const depth = -dot(q, back);
  return { x: dot(q, right) / depth / tanX, y: dot(q, up) / depth / tanY, depth };
}

const tanY = Math.tan((20 * Math.PI) / 180);
const tanX = tanY * 1.5;
const house: Box = { min: [-6.6, -2.55, -10.84], max: [8, 8.46, 7.76] };
const lights: Box = { min: [-3.7, 0, -0.3], max: [3.7, 1.7, 0.8] };

describe('camera fitting', () => {
  for (const [name, az, polar] of [['front', 0, 1.3], ['angle', -0.62, 1.12], ['top', 0, 0.02]] as const) {
    it(`keeps every corner in view and touches the edge (${name})`, () => {
      const fit = fitPoints(corners(house), az, polar, tanX, tanY);
      const pts = corners(house).map((p) => project(p, fit, tanX, tanY));
      for (const p of pts) {
        expect(p.depth).toBeGreaterThan(0);
        expect(Math.abs(p.x)).toBeLessThanOrEqual(1 + 1e-6);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(1 + 1e-6);
      }
      // Tight: some corner reaches the edge, and the points are centred (equal room on both sides).
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      expect(Math.max(Math.max(...xs.map(Math.abs)), Math.max(...ys.map(Math.abs)))).toBeCloseTo(1, 5);
      expect(Math.max(...xs) + Math.min(...xs)).toBeCloseTo(0, 5);
      expect(Math.max(...ys) + Math.min(...ys)).toBeCloseTo(0, 5);
    });
  }

  it('looks from the street side and front-left', () => {
    const front = fitPoints(corners(lights), 0, 1.3, tanX, tanY);
    expect(front.position[2]).toBeGreaterThan(front.target[2]);
    const angle = fitPoints(corners(lights), -0.62, 1.12, tanX, tanY);
    expect(angle.position[0]).toBeLessThan(angle.target[0]);
  });

  it('frames the lights without a house model, and more of the house with one', () => {
    for (const v of ['house', 'front', 'close', 'angle', 'top'] as const) expect(viewRegion(v, lights, null)).toEqual(lights);
    expect(viewRegion('close', lights, house)).toEqual(lights);
    expect(viewRegion('house', lights, house)).toEqual(house);
    expect(viewRegion('top', lights, house)).toEqual(house);
    const front = viewRegion('front', lights, house);
    expect(front.max[1]).toBe(house.max[1]); // up to the roof
    expect(front.min[1]).toBe(lights.min[1]); // not the yard below the porch
    const angle = viewRegion('angle', lights, house);
    expect(angle.min[1]).toBe(house.min[1]); // down the hill
    expect(angle.max[2]).toBe(house.max[2]); // out to the street
  });

  it("keeps a view's points within its region, plus the lights", () => {
    const tree: Box = { min: [-5.84, 0, 1.56], max: [-3.94, 6.07, 3.03] };
    const bounds = { box: house, points: [...corners(house), ...corners(tree)], key: 'k' };
    expect(viewPoints('close', lights, bounds)).toEqual(corners(lights));
    expect(viewPoints('house', lights, bounds)).toEqual(expect.arrayContaining(corners(tree)));
    const region = viewRegion('front', lights, house);
    for (const p of viewPoints('front', lights, bounds)) {
      for (let i = 0; i < 3; i++) {
        expect(p[i]).toBeGreaterThanOrEqual(region.min[i]!);
        expect(p[i]).toBeLessThanOrEqual(region.max[i]!);
      }
    }
  });
});

function sub(a: V3, b: V3): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a: V3, b: V3) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: V3, b: V3): V3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a: V3): V3 { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; }
