import { afterEach, describe, expect, it } from 'vitest';
import { buildLayout, EFFECTS, resolveParams, type LayoutConfig } from '../src/index.js';
import { FontManager } from '../src/wled/fonts.js';
import { setWallClock } from '../src/wled/effects/text.js';
import { beginDraw, Segment } from '../src/wled/segment.js';

const fx = EFFECTS['wled-scrolling-text']!;

/** A 64 × 16 grid of lights: the house front as a matrix. */
const grid = buildLayout({
  controllers: [{ id: 'a', name: 'A', host: 'x', pixelCount: 64 * 16 }],
  runs: Array.from({ length: 16 }, (_, y) => ({ id: `r${y}`, controller: 'a', start: y * 64, count: 64, points: [[0, y, 0], [63, y, 0]] as [number, number, number][] })),
} satisfies LayoutConfig);

function frame(params: Record<string, unknown>, t: number): number[] {
  const r = fx.create(resolveParams(fx, params), grid);
  const out = new Float32Array(grid.count * 3);
  r(t, out);
  return [...out];
}
const lit = (px: number[]) => px.filter((v) => v > 0).length;

afterEach(() => setWallClock(null));

describe('text param', () => {
  it('defaults to "Merry Christmas" and is listed first', () => {
    expect(fx.params[0]).toMatchObject({ key: 'text', type: 'text', default: 'Merry Christmas', maxLength: 64 });
    expect(resolveParams(fx, {}).text).toBe('Merry Christmas');
    expect(resolveParams(fx, { text: '' }).text).toBe('');
  });

  it('cuts text to maxLength characters without splitting an emoji', () => {
    expect(resolveParams(fx, { text: 'x'.repeat(100) }).text).toBe('x'.repeat(64));
    const s = '🎄'.repeat(70); // 2 UTF-16 units each
    expect(resolveParams(fx, { text: s }).text).toBe('🎄'.repeat(64));
  });

  it('rejects anything but a string', () => {
    expect(() => resolveParams(fx, { text: 42 })).toThrow(/text/);
    expect(() => resolveParams(fx, { text: null })).toThrow(/text/);
  });
});

describe('fonts', () => {
  it('draws "H" from console_font_6x8 (font 2) pixel for pixel', () => {
    const seg = new Segment(10, 10);
    beginDraw(seg, 0);
    const fm = new FontManager(seg);
    expect(fm.loadFont(2, new Uint8Array([0x48, 0]), false)).toBe(true);
    expect(fm.getFontHeight()).toBe(8);
    expect(fm.getGlyphWidth(0x48)).toBe(5);
    fm.drawCharacter(0x48, 1, 1, 0xff0000, 0xff0000, 0);
    const rows: string[] = [];
    for (let y = 0; y < 10; y++) {
      let r = '';
      for (let x = 0; x < 10; x++) r += seg.pixels[x + y * 10] ? '#' : '.';
      rows.push(r);
    }
    expect(rows).toEqual([
      '..........',
      '.#...#....',
      '.#...#....',
      '.#...#....',
      '.#####....',
      '.#...#....',
      '.#...#....',
      '.#...#....',
      '..........',
      '..........',
    ]);
    expect(seg.pixels[1 + 1 * 10]).toBe(0xff0000);
  });

  it('every font size slider position loads a font', () => {
    for (const custom2 of [0, 64, 128, 192, 255]) expect(lit(frame({ text: 'Hi', custom2 }, 1))).toBeGreaterThan(0);
  });
});

describe('Scrolling Text', () => {
  it('changing the text changes the output', () => {
    expect(frame({ text: 'Merry Christmas' }, 2)).not.toEqual(frame({ text: 'Happy New Year' }, 2));
  });

  it('clock tokens read the injected wall clock', () => {
    setWallClock(() => new Date(2026, 11, 24, 18, 5, 9));
    const token = frame({ text: '#HHMM' }, 1);
    expect(token).toEqual(frame({ text: '18:05' }, 1));
    expect(frame({ text: '#DATE0' }, 1)).toEqual(frame({ text: '24.12.2026' }, 1));
    expect(frame({ text: '#DAY #MON #DD' }, 1)).toEqual(frame({ text: 'Thu Dec 24' }, 1));
    setWallClock(() => new Date(2026, 11, 24, 7, 30, 0).getTime()); // epoch ms work too
    expect(frame({ text: '#HHMM' }, 1)).toEqual(frame({ text: '7:30' }, 1));
    expect(frame({ text: '#HHMM' }, 1)).not.toEqual(token);
  });

  it('empty text shows the date and time from the injected clock', () => {
    setWallClock(() => new Date(2026, 11, 24, 18, 5, 9));
    expect(frame({ text: '' }, 2)).toEqual(frame({ text: 'Dec 24, 2026 18:05:09' }, 2));
  });

  it('defaults to a fixed clock, so renders are deterministic', () => {
    expect(frame({ text: '#TIME' }, 1)).toEqual(frame({ text: '18:00:00' }, 1));
  });

  it('keeps scrolling across simulation windows instead of jumping back to the start', () => {
    // Our simulation restarts from a fresh segment every 30 s; the text must carry on from where it was.
    const mask = (t: number) => {
      const px = frame({}, t), m: boolean[] = [];
      for (let i = 0; i < grid.count; i++) m.push(px[i * 3]! + px[i * 3 + 1]! + px[i * 3 + 2]! > 0);
      return m;
    };
    const before = mask(29.975), after = mask(30);
    expect(before.filter(Boolean).length).toBeGreaterThan(20);
    const same = before.every((v, i) => v === after[i]);
    // or moved one column to the left (ignore the right-hand edge, where new pixels enter)
    const shifted = after.every((v, i) => i % 64 === 63 || v === before[i + 1]);
    expect(same || shifted).toBe(true);
  });
});
