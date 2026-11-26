import { describe, expect, it } from 'vitest';
import { buildLayout, EFFECTS, Engine } from '@xmas/engine';
import { isPatternEffect, patternLook } from '../src/paint';

/** The porch, roughly: 300 lights along two railings and a stair rail. */
const layout = buildLayout({
  controllers: [{ id: 'porch', name: 'Porch', host: '192.0.2.1', pixelCount: 300 }],
  runs: [
    { id: 'left', controller: 'porch', start: 0, count: 120, points: [[0, 1, 0], [4, 1, 0]] },
    { id: 'right', controller: 'porch', start: 120, count: 120, points: [[5, 1, 0], [9, 1, 0]] },
    { id: 'stairs', controller: 'porch', start: 240, count: 60, points: [[4, 1, 0], [4.5, 0, 2]] },
  ],
});

/**
 * How the effect painted as a pattern masks a white layer over a few seconds: the share of lights
 * the mask dims at least once, and the share it lets through at least once.
 */
function patternCoverage(id: string): { dimmed: number; lit: number } {
  const look = patternLook({ effect: id, params: {} });
  const engine = new Engine(layout);
  engine.setOutput({ gamma: 1 });
  engine.setScene({ name: 't', layers: [{ id: 'base', effect: 'solid', params: { color: '#ffffff' } }, { id: 'fx', ...look }] });
  const dimmed = new Uint8Array(layout.count), lit = new Uint8Array(layout.count);
  for (let f = 0; f < 240; f++) {
    const frame = engine.render(f / 40);
    for (let i = 0; i < layout.count; i++) {
      const v = Math.max(frame[i * 3]!, frame[i * 3 + 1]!, frame[i * 3 + 2]!);
      if (v < 160) dimmed[i] = 1;
      if (v > 60) lit[i] = 1;
    }
  }
  const share = (a: Uint8Array) => a.reduce((s, v) => s + v, 0) / layout.count;
  return { dimmed: share(dimmed), lit: share(lit) };
}

describe('effects the Brush paints as a pattern', () => {
  const ids = Object.keys(EFFECTS).filter(isPatternEffect);
  it('offers a good choice of effects', () => { expect(ids.length).toBeGreaterThan(40); });
  it.each(ids)('%s makes a visible pattern in white on black', (id) => {
    const { dimmed, lit } = patternCoverage(id);
    // Neither always dark (nothing would show) nor always fully on (nothing would move).
    expect({ id, dimmed: dimmed > 0.05, lit: lit > 0.05 }).toEqual({ id, dimmed: true, lit: true });
  });
});

describe('a pattern painted over colours', () => {
  it('makes the lights below follow the effect, in their own colour, only where it is painted', async () => {
    const { encodePaint } = await import('@xmas/engine');
    const red = new Uint8Array(layout.count).fill(255);
    const half = new Uint8Array(layout.count).map((_, i) => (i < 150 ? 255 : 0));
    const look = patternLook({ effect: 'twinkle', params: { density: 0.3 } });
    expect(look.blend).toBe('mask');
    expect(look.params).toMatchObject({ color: '#ffffff', background: '#000000' });
    const engine = new Engine(layout);
    engine.setOutput({ gamma: 1 });
    engine.setScene({ name: 't', layers: [
      { id: 'red', effect: 'solid', params: { color: '#ff0000' }, paint: encodePaint(red) },
      { id: 'fx', ...look, paint: encodePaint(half) },
    ] });
    let dimInside = false, dimOutside = false;
    for (let f = 0; f < 80; f++) {
      const frame = engine.render(f / 20);
      for (let i = 0; i < layout.count; i++) {
        expect(frame[i * 3 + 1]).toBe(0); // still red: the pattern adds no colour of its own
        expect(frame[i * 3 + 2]).toBe(0);
        if (frame[i * 3]! < 200) { if (i < 150) dimInside = true; else dimOutside = true; }
      }
    }
    expect(dimInside).toBe(true);
    expect(dimOutside).toBe(false);
  });
});
