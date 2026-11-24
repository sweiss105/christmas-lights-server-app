import { describe, expect, it } from 'vitest';
import { buildLayout, LayoutError, type LayoutConfig } from '../src/index.js';

const cfg = (coil: unknown, points: [number, number, number][] = [[0, 1, 0], [2, 1, 0]], count = 200): LayoutConfig => ({
  controllers: [{ id: 'c', name: 'C', host: 'x', pixelCount: count }],
  runs: [{ id: 'r', controller: 'c', start: 0, count, points, coil } as LayoutConfig['runs'][number]],
});
const pos = (l: ReturnType<typeof buildLayout>, i: number) => [l.positions[i * 3]!, l.positions[i * 3 + 1]!, l.positions[i * 3 + 2]!];

describe('coiled runs (lights wound around a rail)', () => {
  it('winds the lights round the path at the given radius, keeping them along it', () => {
    const l = buildLayout(cfg({ radius: 0.05, pitch: 0.25 }));
    let ys = [] as number[];
    for (let i = 0; i < 200; i++) {
      const [x, y, z] = pos(l, i);
      expect(Math.hypot(y - 1, z)).toBeCloseTo(0.05, 3); // on the coil's surface
      expect(x).toBeGreaterThanOrEqual(-1e-6); expect(x).toBeLessThanOrEqual(2 + 1e-6);
      ys.push(y);
    }
    expect(Math.max(...ys)).toBeCloseTo(1.05, 2);
    expect(Math.min(...ys)).toBeCloseTo(0.95, 2);
    expect(pos(l, 0)[0]).toBeCloseTo(0, 5);
    expect(pos(l, 199)[0]).toBeCloseTo(2, 5);
  });

  it('makes a whole number of turns per segment, about one per pitch', () => {
    // 2 m at 0.25 m pitch = 8 turns: the height crosses the rail's middle going up 8 times.
    const l = buildLayout(cfg({ radius: 0.05, pitch: 0.25 }, undefined, 800));
    let ups = 0;
    for (let i = 1; i < 800; i++) if (pos(l, i - 1)[1]! < 1 && pos(l, i)[1]! >= 1) ups++;
    expect(ups).toBe(8);
  });

  it('leaves skipped segments straight (e.g. down a post)', () => {
    const l = buildLayout(cfg({ radius: 0.05, pitch: 0.25, skip: [1] }, [[0, 1, 0], [1, 1, 0], [1, 0, 0]], 300));
    for (let i = 0; i < 300; i++) {
      const [x, y, z] = pos(l, i);
      if (y < 0.9) { expect(x).toBeCloseTo(1, 5); expect(z).toBeCloseTo(0, 5); }
    }
  });

  it('works on vertical and sloping segments', () => {
    const l = buildLayout(cfg({ radius: 0.04, pitch: 0.2 }, [[0, 0, 0], [0, 1, 0], [0, 1.5, 1]], 300));
    for (let i = 0; i < 300; i++) expect(pos(l, i).every(Number.isFinite)).toBe(true);
  });

  it('rejects nonsense', () => {
    expect(() => buildLayout(cfg({ radius: -1, pitch: 0.2 }))).toThrow(LayoutError);
    expect(() => buildLayout(cfg({ radius: 0.05, pitch: 0 }))).toThrow(LayoutError);
    expect(() => buildLayout(cfg({ radius: 2, pitch: 0.2 }))).toThrow(LayoutError);
  });
});
