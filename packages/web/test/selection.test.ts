import { describe, expect, it } from 'vitest';
import { buildLayout, type LayoutConfig } from '@xmas/engine';
import { aboveHeight, combine, endsOfRuns, everyNth, inCircle, inPolygon, inRect, invert, runAt, sideOf } from '../src/selection.js';

// Screen positions (x, y) for 5 pixels; NaN = behind the camera / not placed.
const screen = new Float32Array([10, 10, 50, 50, 90, 90, 50, 10, NaN, NaN]);

describe('picking pixels on screen', () => {
  it('rectangle (any drag direction)', () => {
    expect([...inRect(screen, { x0: 40, y0: 0, x1: 100, y1: 60 })].sort()).toEqual([1, 3]);
    expect([...inRect(screen, { x0: 100, y0: 60, x1: 40, y1: 0 })].sort()).toEqual([1, 3]);
  });

  it('lasso polygon', () => {
    const triangle = [[0, 0], [100, 0], [0, 100]] as [number, number][];
    expect([...inPolygon(screen, triangle)].sort()).toEqual([0, 3]); // (50,50) is on the edge: excluded
  });

  it('brush circle', () => {
    expect([...inCircle(screen, 50, 30, 21)].sort()).toEqual([1, 3]);
  });

  it('combines with the current selection: replace, add, subtract', () => {
    const cur = new Set([0, 1]);
    expect([...combine(cur, new Set([3]), 'replace')]).toEqual([3]);
    expect([...combine(cur, new Set([3]), 'add')].sort()).toEqual([0, 1, 3]);
    expect([...combine(cur, new Set([1]), 'subtract')]).toEqual([0]);
  });
});

describe('selection rules', () => {
  const layout = buildLayout({
    controllers: [{ id: 'c', name: 'C', host: 'x', pixelCount: 20 }],
    runs: [
      { id: 'a', controller: 'c', start: 0, count: 10, points: [[0, 0, 0], [9, 0, 0]] }, // along the ground, x 0..9
      { id: 'b', controller: 'c', start: 10, count: 8, points: [[10, 0, 0], [10, 7, 0]] }, // a post, y 0..7
    ],
  } satisfies LayoutConfig);
  const all = new Set(Array.from({ length: 18 }, (_, i) => i));

  it('every Nth light, counted along each string, of the current selection', () => {
    expect([...everyNth(layout, all, 3, 0)]).toEqual([0, 3, 6, 9, 10, 13, 16]);
    expect([...everyNth(layout, new Set([0, 1, 2, 3, 4, 5]), 2, 1)]).toEqual([1, 3, 5]);
  });

  it('first or last N lights of each string', () => {
    expect([...endsOfRuns(layout, 2, 'first')]).toEqual([0, 1, 10, 11]);
    expect([...endsOfRuns(layout, 2, 'last')]).toEqual([8, 9, 16, 17]);
  });

  it('above or below a height, and left or right half of the house', () => {
    expect([...aboveHeight(layout, 4.5, 'above')]).toEqual([15, 16, 17]); // the post's lights are 1 m apart: 5, 6, 7 m
    expect([...aboveHeight(layout, 0.5, 'below')].length).toBe(11); // the ground run plus the post's first pixel
    expect([...sideOf(layout, 'left')]).toEqual([0, 1, 2, 3, 4]); // x < 5 (middle of 0..10)
  });

  it('invert selects every placed light that isn’t selected', () => {
    expect([...invert(layout, new Set([0, 1, 2]))].length).toBe(15);
    expect(invert(layout, new Set([0])).has(18)).toBe(false); // unplaced pixels never get selected
  });
});

describe('selecting whole strings', () => {
  const layout = buildLayout({
    controllers: [{ id: 'c', name: 'C', host: 'x', pixelCount: 20 }],
    runs: [
      { id: 'a', controller: 'c', start: 0, count: 10, points: [[0, 0, 0], [9, 0, 0]] },
      { id: 'b', controller: 'c', start: 10, count: 8, points: [[10, 0, 0], [10, 7, 0]] },
    ],
  });

  it('finds the string under the pointer (nearest light within reach) and returns all its lights', () => {
    const screen = new Float32Array(40).fill(NaN);
    for (let i = 0; i < 18; i++) { screen[i * 2] = i * 10; screen[i * 2 + 1] = 100; } // a row of lights on screen
    expect([...runAt(layout, screen, 32, 104, 12)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect([...runAt(layout, screen, 151, 98, 12)]).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
    expect(runAt(layout, screen, 500, 500, 12).size).toBe(0); // nothing nearby
  });
});
