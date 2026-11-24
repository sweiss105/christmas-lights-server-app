import { describe, expect, it } from 'vitest';
import { buildLayout, EFFECTS, resolveParams } from '../src/index.js';
import { setMillis, setRandomSource } from '../src/wled/math.js';
import {
  calculateNumberOfParticles1D, calculateNumberOfParticles2D, calculateNumberOfSources1D, calculateNumberOfSources2D,
  fast_color_scaleAdd, getPS1D, getPS2D, limitSpeed, PF1_COLLIDE, PF2_COLLIDE, PS_P_RADIUS, PS_P_RADIUS_1D,
} from '../src/wled/particle-system.js';
import { beginDraw, Segment } from '../src/wled/segment.js';

// Expected values are worked out by hand from FXparticleSystem.cpp.

/** Make `seg` current (as the runner does) with a fixed random source. */
function draw(seg: Segment, now = 0, rnd = 0.5): void {
  setMillis(now);
  setRandomSource(() => rnd);
  beginDraw(seg, now);
}

describe('particle system helpers', () => {
  it('fast_color_scaleAdd scales the second colour and keeps the ratio on overflow', () => {
    expect(fast_color_scaleAdd(0, 0xff8000, 128)).toBe(0x7f4000); // (255*128)>>8, (128*128)>>8
    expect(fast_color_scaleAdd(0x102030, 0, 255)).toBe(0x102030);
    expect(fast_color_scaleAdd(0xff0000, 0xff4000)).toBe(fast_color_scaleAdd(0xff0000, 0xff4000, 255)); // default scale
    // r = 255 + 254 = 509 overflows: scale_factor = 65280 / 509 = 128 → r = 509*128 >> 8 = 254, g = 127*128 >> 8 = 63
    expect(fast_color_scaleAdd(0xff0000, 0xff8000, 255)).toBe(0xfe3f00);
    expect(fast_color_scaleAdd(0xff000000, 0x10, 255) >>> 24).toBe(0); // white dropped
  });

  it('limitSpeed clamps to ±120', () => {
    expect(limitSpeed(200)).toBe(120);
    expect(limitSpeed(-130)).toBe(-120);
    expect(limitSpeed(5)).toBe(5);
  });

  it('computes particle and source counts like WLED on an ESP32', () => {
    expect(calculateNumberOfParticles2D(64 * 16, false, false)).toBe(1024);
    expect(calculateNumberOfParticles2D(64 * 64, false, false)).toBe(2048); // MAXPARTICLES_2D
    expect(calculateNumberOfParticles2D(64 * 64, true, false)).toBe(1708); // 2048*10/12 = 1706 → multiple of 4
    expect(calculateNumberOfParticles2D(64 * 64, true, true)).toBe(216); // 1706/8 = 213 → 216
    expect(calculateNumberOfSources2D(1024, 8)).toBe(8);
    expect(calculateNumberOfSources2D(1024, 1)).toBe(4); // rounded up to 4
    expect(calculateNumberOfSources2D(4096, 64)).toBe(64);
    expect(calculateNumberOfSources1D(5)).toBe(8);
    expect(calculateNumberOfSources1D(0)).toBe(4);
    const seg = new Segment(1100, 1);
    draw(seg);
    expect(calculateNumberOfParticles1D(255, false)).toBe(1100);
    expect(calculateNumberOfParticles1D(128, true)).toBe(404); // 1100*8/11 = 800, *129 >> 8 = 403 → multiple of 4
  });
});

describe('ParticleSystem2D', () => {
  it('sprayEmit copies the source and draws ttl in [minLife, maxLife)', () => {
    const seg = new Segment(32, 16);
    draw(seg);
    const ps = getPS2D(1)!;
    ps.src.x[0] = 100; ps.src.y[0] = 200; ps.src.hue[0] = 42; ps.src.flags[0] = PF2_COLLIDE;
    ps.srcVx[0] = 3; ps.srcVy[0] = -4; ps.srcVar[0] = 0; ps.srcMinLife[0] = 10; ps.srcMaxLife[0] = 20;
    const k = ps.sprayEmit(0);
    expect(k).toBe(1); // emitIndex is pre-incremented
    const P = ps.particles;
    expect([P.x[k], P.y[k], P.vx[k], P.vy[k], P.hue[k], P.sat[k], P.flags[k]]).toEqual([100, 200, 3, -4, 42, 255, PF2_COLLIDE]);
    expect(P.ttl[k]).toBe(10); // hw_random16 reads the low 16 bits of 0x80000000: 0
  });

  it('moves, ages, bounces off walls with hardness and kills out of bounds particles', () => {
    const seg = new Segment(32, 16);
    draw(seg);
    const ps = getPS2D(1)!;
    ps.updateSystem();
    const P = ps.particles;
    expect(ps.maxX).toBe(32 * PS_P_RADIUS - 1);
    ps.setBounceX(true);
    ps.setWallHardness(128);
    P.ttl[0] = 10; P.x[0] = 70; P.y[0] = 500; P.vx[0] = -20; P.vy[0] = 0;
    ps.particleMoveUpdate(P, 0);
    expect(P.ttl[0]).toBe(9);
    // newX = 50 < hard radius 64 (size 1) → bounce: vx = (20*128+128)>>8 = 10, x = 64
    expect(P.x[0]).toBe(64);
    expect(P.vx[0]).toBe(10);
    ps.setBounceX(false);
    ps.setKillOutOfBounds(true);
    P.x[0] = 5; P.vx[0] = -100;
    ps.particleMoveUpdate(P, 0); // -95 < -(31+1) → out of bounds and killed
    expect(P.ttl[0]).toBe(0);
  });

  it('wraps around when wrapX is set', () => {
    const seg = new Segment(32, 16);
    draw(seg);
    const ps = getPS2D(1)!;
    const P = ps.particles;
    ps.setWrapX(true);
    P.ttl[0] = 10; P.x[0] = ps.maxX - 2; P.y[0] = 500; P.vx[0] = 10;
    ps.particleMoveUpdate(P, 0);
    expect(P.x[0]).toBe((ps.maxX + 8) % (ps.maxX + 1));
  });

  it('applies small forces through the 4-bit counter (force 8 = +1 every other frame)', () => {
    const seg = new Segment(32, 16);
    draw(seg);
    const ps = getPS2D(1)!;
    const P = ps.particles;
    let counter = 0;
    const vs: number[] = [];
    for (let f = 0; f < 4; f++) { counter = ps.applyForceTo(P, 0, 8, 0, counter); vs.push(P.vx[0]!); }
    expect(vs).toEqual([0, 1, 1, 2]);
  });

  it('renders a 2x2 particle with bilinear weights (gamma-corrected, flipped y)', () => {
    const seg = new Segment(8, 8);
    draw(seg);
    seg.currentPalette.fill(0xffffff); // white palette
    const ps = getPS2D(1)!;
    ps.updateSystem();
    const P = ps.particles;
    P.ttl[0] = 200; P.x[0] = 3 * PS_P_RADIUS + 32; P.y[0] = 2 * PS_P_RADIUS + 32; // exactly in the centre of pixel (3, 2)
    P.flags[0] = 0;
    ps.usedParticles = 1;
    ps.update();
    // x = 224 → xoffset 256: dx = 0, so the whole weight goes to the left/bottom pixel (3, 2), flipped to row 7 - 2
    const lit = [...seg.pixels].map((c, i) => [i % 8, Math.floor(i / 8), c] as const).filter((p) => p[2] > 0);
    expect(lit).toEqual([[3, 5, 0xfefefe]]); // ttl 199 → brightness 255 → white * 255 >> 8
  });

  it('collisions push two overlapping particles apart', () => {
    const seg = new Segment(32, 16);
    draw(seg);
    const ps = getPS2D(1)!;
    ps.updateSystem();
    ps.enableParticleCollisions(true, 255);
    const P = ps.particles;
    ps.usedParticles = 2;
    for (const i of [0, 1]) { P.ttl[i] = 100; P.flags[i] = PF2_COLLIDE; P.y[i] = 500; }
    P.x[0] = 1000; P.vx[0] = 10; P.x[1] = 1060; P.vx[1] = -10;
    ps.update();
    expect(P.vx[0]!).toBeLessThan(0);
    expect(P.vx[1]!).toBeGreaterThan(0);
  });
});

describe('ParticleSystem1D', () => {
  it('emits, falls under gravity and stops at the floor with bounce', () => {
    const seg = new Segment(100, 1);
    draw(seg);
    seg.currentPalette.fill(0xffffff);
    const ps = getPS1D(1)!;
    ps.updateSystem();
    expect(ps.maxX).toBe(100 * PS_P_RADIUS_1D - 1);
    ps.setGravity(16);
    ps.setBounce(true);
    ps.setWallHardness(0);
    const P = ps.particles;
    ps.src.x[0] = 1000; ps.srcV[0] = 0; ps.srcVar[0] = 0; ps.srcMinLife[0] = 500; ps.srcMaxLife[0] = 500;
    ps.src.flags[0] = PF1_COLLIDE;
    const k = ps.sprayEmit(0);
    expect(k).toBe(1);
    expect(P.ttl[k]).toBe(500);
    for (let f = 0; f < 60; f++) { draw(seg, f * 25); ps.update(); }
    expect(P.x[k]).toBe(16); // particle hard radius for size 0 is 16
    expect(P.vx[k]).toBe(0); // gravity pulls to -1 each frame, the zero-hardness floor bounce stops it again
    expect(seg.pixels[0]).not.toBe(0);
  });

  it('adds the background colour after rendering', () => {
    const seg = new Segment(10, 1);
    seg.colors[1] = 0x000010;
    draw(seg);
    const ps = getPS1D(1)!;
    ps.update();
    expect(seg.pixels[5]).toBe(0x00000f); // 16*255>>8
  });
});

// -------------------------------------------------------------------------------------------------

const PS_IDS = Object.keys(EFFECTS).filter((id) => id.startsWith('wled-ps-'));
const square = buildLayout({
  controllers: [{ id: 'a', name: 'A', host: 'x', pixelCount: 4096 }],
  runs: Array.from({ length: 64 }, (_, r) => ({
    id: `r${r}`, controller: 'a', start: r * 64, count: 64, points: [[0, r, 0], [10, r, 0]] as [number, number, number][],
  })).map((run, r) => ({ ...run, points: [[0, (r * 10) / 63, 0], [10, (r * 10) / 63, 0]] as [number, number, number][] })),
});
const porch = buildLayout({ controllers: [{ id: 'a', name: 'A', host: 'x', pixelCount: 1100 }], runs: [{ id: 'r', controller: 'a', start: 0, count: 1100, points: [[0, 0, 0], [20, 0, 0], [20, 5, 0]] }] });

describe('PS effects', () => {
  it('there are 23 of them, all in the Particles category', () => {
    expect(PS_IDS.length).toBe(23);
    for (const id of PS_IDS) expect(EFFECTS[id]!.category, id).toBe('Particles');
  });

  it.each(PS_IDS)('%s lights something up within 10 s', (id) => {
    const fx = EFFECTS[id]!;
    const l = fx.params.some((p) => p.key === 'mapping') ? porch : square; // 2D effects: every cell of the grid
    const r = fx.create(resolveParams(fx, {}), l);
    const out = new Float32Array(l.count * 3);
    let lit = 0;
    for (let t = 0.5; t <= 10 && !lit; t += 0.5) {
      r(t, out);
      lit = out.reduce((a, v) => a + (v > 0.02 ? 1 : 0), 0);
    }
    expect(lit, id).toBeGreaterThan(0);
  });

  it.each(PS_IDS)('%s renders a 64x64 grid fast enough', (id) => {
    const fx = EFFECTS[id]!;
    const p = resolveParams(fx, {});
    const r = fx.create(p, square), out = new Float32Array(square.count * 3);
    r(20, out);
    const t0 = performance.now();
    for (let k = 1; k <= 40; k++) r(20 + k / 40, out);
    const ms = (performance.now() - t0) / 40;
    console.log(`${id} 64x64: ${ms.toFixed(2)} ms/frame`);
    expect(ms).toBeLessThan(4);
  });
});

describe('PS effects, heavy settings', () => {
  // [id, params, layout, budget ms]. Fuzzy Noise with Collide on a full 64x64 grid checks ~400k particle pairs per
  // frame exactly as WLED's binning does, ~3.7 ms here: it gets a looser budget.
  const cases: [string, Record<string, unknown>, 'square' | 'porch', number?][] = [
    ['wled-ps-ballpit', { intensity: 255, custom2: 255 }, 'square'],
    ['wled-ps-ballpit', { intensity: 255, custom1: 255 }, 'square'],
    ['wled-ps-box', { intensity: 255 }, 'square'],
    ['wled-ps-fuzzy-noise', { intensity: 255, check3: true }, 'square', 6],
    ['wled-ps-volcano', { intensity: 255, check3: true }, 'square'],
    ['wled-ps-waterfall', { intensity: 255 }, 'square'],
    ['wled-ps-attractor', { intensity: 255, custom2: 255 }, 'square'],
    ['wled-ps-fire', { intensity: 255, check3: true }, 'square'],
    ['wled-ps-pinball', { intensity: 255, check1: true }, 'porch'],
    ['wled-ps-pinball', { intensity: 255, check2: true, custom1: 255 }, 'porch'],
    ['wled-ps-hourglass', { intensity: 255 }, 'porch'],
    ['wled-ps-1d-balance', { intensity: 255, custom1: 200 }, 'porch'],
    ['wled-ps-starburst', { intensity: 255, check3: true }, 'porch'],
  ];
  it.each(cases)('%s %j stays within budget', (id, params, where, budget = 4) => {
    const fx = EFFECTS[id]!;
    const l = where === 'square' ? square : porch;
    const r = fx.create(resolveParams(fx, params), l), out = new Float32Array(l.count * 3);
    // t = 20..21: one simulation running (in the last 5 s of a window the next window's warm-up runs alongside,
    // doubling the cost; the catalogue test measures the same single-simulation case)
    r(20, out);
    const t0 = performance.now();
    for (let k = 1; k <= 40; k++) r(20 + k / 40, out);
    const ms = (performance.now() - t0) / 40;
    console.log(`${id} ${JSON.stringify(params)} ${where}: ${ms.toFixed(2)} ms/frame`);
    expect(ms).toBeLessThan(budget);
  });
});
