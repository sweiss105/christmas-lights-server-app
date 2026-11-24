import { describe, expect, it } from 'vitest';
import { buildLayout, Engine, EFFECTS, resolveParams, type LayoutConfig } from '../src/index.js';
import { PALETTES, paletteFor, samplePalette } from '../src/fx/palettes.js';
import { map1D, map2D } from '../src/fx/mapping.js';
import { createRandom } from '../src/fx/random.js';
import { simulation } from '../src/fx/sim.js';

/** Two runs on one controller, a gap, and a vertical run: enough shape to exercise every mapping. */
const layoutCfg = (): LayoutConfig => ({
  controllers: [{ id: 'a', name: 'A', host: 'x', pixelCount: 60 }],
  runs: [
    { id: 'left', controller: 'a', start: 0, count: 20, points: [[0, 1, 0], [5, 1, 0]] },
    { id: 'right', controller: 'a', start: 20, count: 30, points: [[6, 1, 0], [10, 1, 0]] },
    { id: 'post', controller: 'a', start: 50, count: 8, points: [[10, 0, 0], [10, 3, 0]] },
  ],
});

describe('palettes', () => {
  it('samples gradient stops, interpolating between them and clamping at the ends', () => {
    const pal = [{ at: 0, rgb: [1, 0, 0] as [number, number, number] }, { at: 1, rgb: [0, 0, 1] as [number, number, number] }];
    const out: [number, number, number] = [0, 0, 0];
    samplePalette(pal, 0.5, out);
    expect(out[0]).toBeCloseTo(0.5); expect(out[2]).toBeCloseTo(0.5);
    samplePalette(pal, 1.5, out, false); // no wrap: clamp
    expect(out).toEqual([0, 0, 1]);
  });

  it('wraps by default, so a moving palette loops seamlessly', () => {
    const out1: [number, number, number] = [0, 0, 0], out2: [number, number, number] = [0, 0, 0];
    samplePalette(PALETTES.Rainbow!, 0.25, out1);
    samplePalette(PALETTES.Rainbow!, 1.25, out2);
    expect(out1).toEqual(out2);
  });

  it('every built-in palette has sorted stops in 0..1 with colours in 0..1', () => {
    for (const [name, pal] of Object.entries(PALETTES)) {
      expect(pal.length, name).toBeGreaterThan(1);
      pal.forEach((s, i) => {
        expect(s.at).toBeGreaterThanOrEqual(i ? pal[i - 1]!.at : 0);
        expect(s.at).toBeLessThanOrEqual(1);
        for (const c of s.rgb) { expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThanOrEqual(1); }
      });
    }
  });

  it('builds palettes from the layer colours, like WLED\'s "Color 1/2/3" palettes', () => {
    const pal = paletteFor('Colors 1&2', { color1: '#ff0000', color2: '#0000ff' });
    const out: [number, number, number] = [0, 0, 0];
    samplePalette(pal, 0, out, false);
    expect(out).toEqual([1, 0, 0]);
    samplePalette(pal, 1, out, false);
    expect(out).toEqual([0, 0, 1]);
  });
});

describe('1D mapping', () => {
  const l = buildLayout(layoutCfg());

  it('"each" runs every string over its own length', () => {
    const m = map1D(l, 'each');
    expect(m.length).toBe(30); // longest run
    expect(m.pos[0]).toBe(0);
    expect(m.pos[19]).toBeCloseTo(1);
    expect(m.pos[20]).toBe(0);
    expect(m.pos[49]).toBeCloseTo(1);
  });

  it('"strip" joins the runs in wiring order', () => {
    const m = map1D(l, 'strip');
    expect(m.length).toBe(58);
    expect(m.pos[0]).toBe(0);
    expect(m.pos[57]).toBeCloseTo(1);
    expect(m.pos[20]!).toBeGreaterThan(m.pos[19]!);
  });

  it('"across" and "up" follow the house, "center" grows from the middle', () => {
    const across = map1D(l, 'across');
    expect(across.pos[0]).toBeCloseTo(0);
    expect(across.pos[49]).toBeCloseTo(1);
    const up = map1D(l, 'up');
    expect(up.pos[50]).toBeCloseTo(0);
    expect(up.pos[57]).toBeCloseTo(1);
    const centre = map1D(l, 'center');
    expect(centre.pos[0]!).toBeGreaterThan(centre.pos[19]!); // left end is farther out than its inner end
  });

  it('leaves unplaced pixels at -1', () => {
    expect(map1D(l, 'each').pos[59]).toBe(-1);
  });

  it('2D mapping puts the house front on a 0..1 grid', () => {
    const m = map2D(l);
    expect(m.x[0]).toBeCloseTo(0);
    expect(m.x[49]).toBeCloseTo(1);
    expect(m.y[50]).toBeCloseTo(0);
    expect(m.y[57]).toBeCloseTo(1);
  });
});

describe('random and simulations', () => {
  it('seeded random is repeatable', () => {
    const a = createRandom(42), b = createRandom(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(new Set(xs).size).toBe(5);
  });

  it('a simulation gives the same state at time t however it got there', () => {
    const make = () => simulation({
      fps: 40, window: 30, seed: 7,
      init: (rnd) => ({ x: rnd(), steps: 0 }),
      step: (s, rnd) => { s.x = (s.x + rnd()) % 1; s.steps++; },
    });
    const a = make(), b = make();
    for (let k = 0; k < 480; k++) a.at(k / 40); // steps along from the start
    expect(b.at(12)).toEqual(a.at(12)); // joins late
    expect(a.at(31).steps).toBe(b.at(31).steps); // next window reseeds for both
    expect(a.at(31).steps).toBeLessThan(80);
  });
});

describe('every effect in the catalogue', () => {
  const l = buildLayout(layoutCfg());
  const ids = Object.keys(EFFECTS);

  it('has a name, description, category and resolvable default params', () => {
    for (const id of ids) {
      const fx = EFFECTS[id]!;
      expect(fx.name, id).toBeTruthy();
      expect(fx.description, id).toBeTruthy();
      expect(fx.category, id).toBeTruthy();
      expect(() => resolveParams(fx, {}), id).not.toThrow();
    }
  });

  it.each(ids)('%s: stays in range, is deterministic for a given t (even when started late) and renders fast', (id) => {
    const fx = EFFECTS[id]!;
    const p = resolveParams(fx, {});
    const a = fx.create(p, l), b = fx.create(p, l);
    const outA = new Float32Array(l.count * 3), outB = new Float32Array(l.count * 3);
    for (let k = 0; k <= 120; k++) a(k / 40, outA); // frame numbers, so the last t is exactly 3
    b(3, outB);
    for (let i = 0; i < outA.length; i++) {
      expect(Number.isFinite(outA[i]!), `${id} value ${i}`).toBe(true);
      expect(outA[i]!).toBeGreaterThanOrEqual(0);
      expect(outA[i]!).toBeLessThanOrEqual(1);
    }
    expect([...outB]).toEqual([...outA]);
    // Budget: 1100 pixels (the porch) must render well inside a 25 ms frame.
    const big = buildLayout({ controllers: [{ id: 'a', name: 'A', host: 'x', pixelCount: 1100 }], runs: [{ id: 'r', controller: 'a', start: 0, count: 1100, points: [[0, 0, 0], [20, 0, 0], [20, 5, 0]] }] });
    const r = fx.create(p, big), out = new Float32Array(1100 * 3);
    r(10, out);
    const t0 = performance.now();
    for (let k = 0; k < 20; k++) r(10 + k / 40, out);
    expect((performance.now() - t0) / 20, `${id} ms/frame`).toBeLessThan(4);
  });

  it('the engine composites any effect without errors', () => {
    const e = new Engine(l);
    for (const id of ids) e.setScene({ name: id, layers: [{ id: 'x', effect: id }] }) && e.render(1.5);
  });
});
