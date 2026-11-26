import { describe, expect, it } from 'vitest';
import type { LayoutConfig } from '@xmas/engine';
import { sceneColors } from '../src/sceneColors';

const layout: LayoutConfig = {
  controllers: [{ id: 'porch', name: 'Porch', host: '192.0.2.1', pixelCount: 200 }],
  runs: [{ id: 'rail', controller: 'porch', start: 0, count: 200, points: [[0, 1, 0], [8, 1, 0]] }],
};
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
/** Whether a colour close to `want` is among `colors`. */
const has = (colors: string[], want: string) => colors.some((c) => Math.hypot(...rgb(c).map((v, i) => v - rgb(want)[i]!)) < 40);

describe('a scene’s swatch colours', () => {
  it('finds the colours a scene shows, most used first', () => {
    const colors = sceneColors({ name: 'c', layers: [{ id: 'a', effect: 'stripes', params: { colorA: '#ff0000', colorB: '#ffffff', count: 6 } }] }, layout)!;
    expect(colors).toHaveLength(2);
    expect(has(colors, '#ff0000') && has(colors, '#ffffff')).toBe(true);
  });

  it('reads WLED effects, which draw from palettes and their own colour slots', () => {
    const colors = sceneColors({ name: 'w', layers: [{ id: 'a', effect: 'wled-blink', params: { color1: '#00ff00', color2: '#0000ff', palette: '* Colors 1&2', speed: 200 } }] }, layout)!;
    expect(has(colors, '#00ff00') && has(colors, '#0000ff')).toBe(true);
  });

  it('counts a dim red as red, and leaves dark lights out', () => {
    expect(sceneColors({ name: 'd', layers: [{ id: 'a', effect: 'solid', params: { color: '#800000' } }] }, layout)).toEqual(['#ff0000']);
    expect(sceneColors({ name: 'off', layers: [] }, layout)).toEqual([]);
  });
});
