import { describe, expect, it } from 'vitest';
import { buildLayout, EFFECTS, PALETTE_NAMES, resolveParams } from '../src/index.js';
import { simulation } from '../src/fx/sim.js';
import { color_add, color_blend, color_fade, CHSV, fast_color_scale, rgb2hsv } from '../src/wled/color.js';
import { paramsFromMeta, parseWledMeta, wledSlug } from '../src/wled/define.js';
import {
  beat8, beat88, beatsin8_t, cubicwave8, ease8InOutCubic, hw_random, hw_random16, hw_random8, map, perlin8, perlin16, PRNG,
  qadd8, qsub8, scale8, setMillis, setRandomSource, sin16_t, sin8_t, cos8_t, sqrt32_bw, triwave8,
} from '../src/wled/math.js';
import { ColorFromPalette, CRGBPalette16, LINEARBLEND, LINEARBLEND_NOWRAP, loadPalette, NOBLEND, resolvePaletteId, WLED_PALETTE_NAMES } from '../src/wled/palettes.js';
import { Segment } from '../src/wled/segment.js';

// Expected values below are worked out by hand from the C sources (see comments).

describe('WLED integer maths', () => {
  it('sin8_t / sin16_t (Bhaskara approximation)', () => {
    expect(sin16_t(0)).toBe(0);
    expect(sin16_t(16384)).toBe(32766); // 131068*p/(4p+1) just under 32767
    expect(sin16_t(49152)).toBe(-32766);
    expect(sin8_t(0)).toBe(128); // (0 + 0x7fff + 128) >> 8
    expect(sin8_t(64)).toBe(255); // saturates at 0xffff
    expect(sin8_t(192)).toBe(0); // sin16 = -32761 → 134 >> 8
    expect(cos8_t(0)).toBe(255);
    expect(sin8_t(256 + 64)).toBe(255); // uint8 argument wraps
  });

  it('scale/saturate/wave helpers', () => {
    expect(scale8(255, 128)).toBe(128);
    expect(qadd8(200, 100)).toBe(255);
    expect(qsub8(10, 20)).toBe(0);
    expect(triwave8(64)).toBe(128);
    expect(triwave8(192)).toBe(126);
    expect(ease8InOutCubic(128)).toBe(128);
    expect(cubicwave8(64)).toBe(128);
    expect(sqrt32_bw(1000000)).toBe(1000);
    expect(sqrt32_bw(99)).toBe(9);
    expect(map(128, 0, 255, 255, 4)).toBe(130); // -32128/255 truncates to -125
  });

  it('beat generators use uint32 wrap-around like the C code', () => {
    setMillis(500);
    expect(beat8(60)).toBe(128); // 500*15360*280 >> 16 = 32812 → >> 8
    setMillis(100000);
    expect(beat88(15360)).toBe(8900); // product wraps mod 2^32 first
    setMillis(0);
    expect(beatsin8_t(60, 0, 255)).toBe(128);
  });

  it('random helpers read the seeded source with WLED argument forms', () => {
    setRandomSource(() => 0.75); // 0xC0000000
    expect(hw_random()).toBe(0xc0000000);
    expect(hw_random(10)).toBe(7); // (0xC0000000 * 10) >> 32
    expect(hw_random(5, 5)).toBe(5);
    setRandomSource(() => 0x80 / 4294967296);
    expect(hw_random8()).toBe(128);
    expect(hw_random8(100)).toBe(50);
    expect(hw_random8(10, 20)).toBe(15);
    expect(hw_random16(1000)).toBe(1); // (128 * 1000) >> 16
  });

  it('PRNG matches prng.h', () => {
    const p = new PRNG();
    expect(p.random16()).toBe(57065); // (0x1234*3001+31683) & 0xffff = 57175; ^= >>7
  });

  it('perlin noise stays in range and is smooth', () => {
    let prev = perlin8(0);
    for (let x = 1; x < 2000; x += 7) {
      const v = perlin8(x, 77), w = perlin16(x * 300, 5000, 123);
      expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(255);
      expect(w).toBeGreaterThanOrEqual(0); expect(w).toBeLessThanOrEqual(65535);
      prev = v;
    }
    expect(Math.abs(perlin8(1000) - perlin8(1001))).toBeLessThan(8);
    expect(prev).toBeTypeOf('number');
  });
});

describe('WLED colours', () => {
  it('color_blend / color_add / color_fade / fast_color_scale', () => {
    expect(color_blend(0xff0000, 0x0000ff, 128)).toBe(0x7f0080);
    expect(color_add(0x808080, 0x808080, true)).toBe(0xffffff);
    // Without preserveCR the overflow bits leak into W and G's low bit exactly as in the C code.
    expect(color_add(0x808080, 0x808080) & 0xffffff).toBe(0xffffff);
    expect(color_fade(0xff8040, 128)).toBe(0x804020);
    expect(fast_color_scale(0xffffff, 128)).toBe(0x7f7f7f);
  });

  it('HSV conversions', () => {
    expect(CHSV(0, 255, 255)).toBe(0xff0000);
    expect(CHSV(96, 255, 255)).toBe(0x00ff00);
    expect(CHSV(160, 255, 255)).toBe(0x0000ff);
    expect(rgb2hsv(0x00ff00)).toEqual({ h: 21845, s: 255, v: 255 });
  });
});

describe('WLED palettes', () => {
  const party = new Uint32Array(16);
  loadPalette(party, 6, 6, [0, 0, 0]);

  it('ColorFromPalette blends 16 entries and wraps (or not)', () => {
    expect(ColorFromPalette(party, 0)).toBe(0x9b00d5);
    expect(ColorFromPalette(party, 8, 255, LINEARBLEND)).toBe(0xac00c6);
    expect(ColorFromPalette(party, 8, 255, NOBLEND)).toBe(0x9b00d5);
    expect(ColorFromPalette(party, 0, 128)).toBe(0x4e006b);
    expect(ColorFromPalette(party, 248, 255, LINEARBLEND)).toBe(0x4d19e8); // blends into entry 0
    expect(ColorFromPalette(party, 248, 255, LINEARBLEND_NOWRAP)).toBe(0x3b19f2); // index remapped to 232
  });

  it('builds CRGBPalette16 gradients like FastLED', () => {
    const p = CRGBPalette16(0xff0000, 0x0000ff);
    expect(p[0]).toBe(0xff0000);
    expect(p[1]).toBe(0xee0011);
    expect(p[15]).toBe(0x0000ff);
    const c = new Uint32Array(16);
    loadPalette(c, 3, 6, [0xff0000, 0x0000ff, 0]); // "* Colors 1&2"
    expect(c[7]).toBe(0x990066);
  });

  it('lists WLED palettes first, in controller order, then our own; every name resolves', () => {
    expect(WLED_PALETTE_NAMES.length).toBe(72);
    expect(PALETTE_NAMES.slice(0, 72)).toEqual([...WLED_PALETTE_NAMES]);
    expect(PALETTE_NAMES).toContain('Christmas');
    expect(new Set(PALETTE_NAMES).size).toBe(PALETTE_NAMES.length);
    const p = new Uint32Array(16);
    for (const n of PALETTE_NAMES) {
      const id = resolvePaletteId(n);
      expect(id, n).toBeGreaterThanOrEqual(0);
      loadPalette(p, id, 6, [0xff0000, 0x00ff00, 0x0000ff], 12345, {});
      if (id > 1) expect(p.some((v) => v !== 0), n).toBe(true);
    }
    expect(resolvePaletteId('Fire')).toBe(35);
  });
});

describe('WLED metadata → params', () => {
  it('parses labels, colours, palette, flags and defaults', () => {
    const m = parseWledMeta('Ripple@!,Wave #,Blur,,,,Overlay;,!;!;12;c1=0');
    expect(m.name).toBe('Ripple');
    expect(m.sliders).toEqual(['Effect speed', 'Wave #', 'Blur', '', '']);
    expect(m.checks).toEqual(['', 'Overlay', '']);
    expect(m.colors[0]).toBe('');
    expect(m.colors[1]).toBeTruthy();
    expect(m.is2D).toBe(false);
    const ps = paramsFromMeta(m);
    expect(ps.map((p) => p.key)).toEqual(['speed', 'intensity', 'custom1', 'check2', 'color2', 'palette', 'mapping']);
    expect(ps.find((p) => p.key === 'custom1')!.default).toBe(0);
    expect(ps.find((p) => p.key === 'check2')).toMatchObject({ type: 'boolean', label: 'Overlay', default: false });
    expect(ps.find((p) => p.key === 'mapping')).toMatchObject({ type: 'select', label: 'Lights run', default: 'each' });
  });

  it('applies sx/ix/c3/pal defaults and treats "2" as a 2D effect', () => {
    const ps = paramsFromMeta(parseWledMeta('Fire 2012@Cooling,Spark rate,,2D Blur,Boost;;!;1;pal=35,sx=64,ix=160,m12=1,c2=128'));
    expect(ps.find((p) => p.key === 'speed')).toMatchObject({ label: 'Cooling', default: 64 });
    expect(ps.find((p) => p.key === 'intensity')!.default).toBe(160);
    expect(ps.find((p) => p.key === 'custom3')).toMatchObject({ label: 'Boost', max: 31, default: 16 });
    expect(ps.find((p) => p.key === 'palette')!.default).toBe('Fire');
    expect(ps.some((p) => p.type === 'color')).toBe(false);
    const dna = parseWledMeta('DNA@Scroll speed,Blur,,,,Smear;;!;2;ix=0');
    expect(dna.is2D).toBe(true);
    expect(paramsFromMeta(dna).some((p) => p.key === 'mapping')).toBe(false);
    expect(paramsFromMeta(parseWledMeta('Solid')).map((p) => p.key)).toEqual(['speed', 'intensity', 'color1', 'color2', 'color3', 'palette', 'mapping']);
    expect(wledSlug('Fire 2012')).toBe('wled-fire-2012');
  });
});

describe('WLED segment', () => {
  it('fadeToBlackBy, fade_out and blur match the C arithmetic', () => {
    const s = new Segment(3);
    s.fill(0xffffff);
    s.fadeToBlackBy(64);
    expect(s.getPixelColor(0)).toBe(0xbebebe);
    s.fill(0xff0000);
    s.fade_out(250); // towards colors[1] = black: delta = trunc(-255*64/256) = -63
    expect(s.getPixelColor(1)).toBe(0xc00000);
    s.fill(0);
    s.setPixelColor(1, 0x800000);
    s.blur(128);
    expect([...s.pixels]).toEqual([0x200000, 0x3f0000, 0x200000]);
  });

  it('keeps C integer widths for runtime fields and indexes', () => {
    const s = new Segment(10);
    s.aux0 = 65535; s.aux0++;
    expect(s.aux0).toBe(0);
    s.step = -1;
    expect(s.step).toBe(0xffffffff);
    s.setPixelColor(3 | (1 << 16), 0x123456); // virtual-strip index is masked
    expect(s.getPixelColor(3)).toBe(0x123456);
    expect(s.getPixelColor(-1)).toBe(0);
    expect(s.allocateData(8)).toBe(true);
    s.view(Uint16Array)[1] = 0xbeef;
    expect(s.data[2]).toBe(0xef); // little-endian like the ESP32
  });

  it('draws in 2D', () => {
    const s = new Segment(8, 8);
    expect(s.is2D()).toBe(true);
    s.drawLine(0, 0, 7, 7, 0xffffff);
    expect(s.getPixelColorXY(4, 4)).toBe(0xffffff);
    s.blur2D(64, 64);
    expect(s.getPixelColorXY(5, 4)).not.toBe(0);
  });
});

describe('ported WLED effects', () => {
  const layout = buildLayout({
    controllers: [{ id: 'a', name: 'A', host: 'x', pixelCount: 200 }],
    runs: [
      { id: 'roof', controller: 'a', start: 0, count: 120, points: [[0, 3, 0], [12, 3, 0]] },
      { id: 'post', controller: 'a', start: 120, count: 80, points: [[12, 0, 0], [12, 3, 0]] },
    ],
  });

  it('registers the five ports with WLED names', () => {
    for (const [id, name] of [['wled-blink', 'Blink'], ['wled-colortwinkles', 'Colortwinkles'], ['wled-fire-2012', 'Fire 2012'], ['wled-ripple', 'Ripple'], ['wled-dna', 'DNA']]) {
      expect(EFFECTS[id!], id).toBeDefined();
      expect(EFFECTS[id!]!.wled).toBe(name);
    }
  });

  it('a 2D effect lights pixels across the house', () => {
    const fx = EFFECTS['wled-dna']!;
    const r = fx.create(resolveParams(fx, {}), layout);
    const out = new Float32Array(layout.count * 3);
    r(2, out);
    let lit = 0;
    for (let i = 0; i < layout.count; i++) if (out[i * 3]! + out[i * 3 + 1]! + out[i * 3 + 2]! > 0.05) lit++;
    expect(lit).toBeGreaterThan(10);
  });

  it('Blink follows its duty cycle (time-only effect)', () => {
    const fx = EFFECTS['wled-blink']!;
    const r = fx.create(resolveParams(fx, { color1: '#ff0000', palette: 'Default' }), layout);
    const out = new Float32Array(layout.count * 3);
    r(0.5, out); // cycle 2590 ms, on for 1295+25 ms
    expect(out[0]).toBe(1);
    r(2.0, out);
    expect(out[0]).toBe(0);
  });

  it('palette and mapping params change the output', () => {
    const fx = EFFECTS['wled-fire-2012']!;
    const a = new Float32Array(layout.count * 3), b = new Float32Array(layout.count * 3);
    fx.create(resolveParams(fx, {}), layout)(5, a);
    fx.create(resolveParams(fx, { palette: 'Ocean' }), layout)(5, b);
    expect([...a]).not.toEqual([...b]);
    fx.create(resolveParams(fx, { mapping: 'strip' }), layout)(5, b);
    expect([...a]).not.toEqual([...b]);
  });
});

describe('simulation warm-up', () => {
  const make = () => simulation({
    fps: 40, window: 2, warmup: 1, seed: 3,
    init: (rnd) => ({ x: rnd(), frames: 0, first: -1 }),
    step: (s, rnd, _dt, frame) => { if (s.first < 0) s.first = frame; s.x = (s.x + rnd()) % 1; s.frames++; },
  });

  it('starts each window early and is the same however it got to t', () => {
    const a = make(), b = make(), c = make();
    for (let k = 0; k <= 200; k++) a.at(k / 40);
    expect(b.at(5)).toEqual(a.at(5));
    // window 2 starts at 4 s; its simulation began 1 s earlier (frame 120) and has rendered frames 120..200
    expect(c.at(5)).toMatchObject({ first: 120, frames: 81 });
    expect(c.at(0.5)).toMatchObject({ first: 0, frames: 21 }); // first window has no warm-up
  });
});
