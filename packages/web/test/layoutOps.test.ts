import { describe, expect, it } from 'vitest';
import type { LayoutConfig } from '@xmas/engine';
import { addRun, appendPoint, freeRanges, insertPoint, layoutError, removePoint, removeRun, reverseRun, runLength, setPoint, updateRun } from '../src/layoutOps.js';
import { History } from '../src/editor.js';

const layout = (): LayoutConfig => ({
  controllers: [{ id: 'porch', name: 'Porch', host: '10.0.0.5', pixelCount: 1101 }],
  runs: [
    { id: 'left', name: 'Left', controller: 'porch', start: 0, count: 500, points: [[0, 1.5, 0], [5, 1.5, 0], [5, 0.9, 1.4]] },
    { id: 'right', name: 'Right', controller: 'porch', start: 500, count: 500, points: [[6.5, 0.9, 1.4], [6.5, 1.5, 0]] },
  ],
  groups: { porch: { runs: ['left', 'right'] } },
});

describe('layout operations', () => {
  it('adds a run in the first free pixels of the controller, next to the last run', () => {
    const l = addRun(layout(), 'porch');
    const r = l.runs.at(-1)!;
    expect(r).toMatchObject({ controller: 'porch', start: 1000, count: 101 });
    expect(r.id).toBe('run-3');
    expect(r.points!.length).toBe(2);
    expect(layoutError(l)).toBeNull();
  });

  it('reports free pixel ranges per controller', () => {
    expect(freeRanges(layout(), 'porch')).toEqual([{ start: 1000, count: 101 }]);
  });

  it('updates, reverses and removes runs (removing also cleans up groups)', () => {
    let l = updateRun(layout(), 'left', { name: 'Left railing', count: 400 });
    expect(l.runs[0]).toMatchObject({ name: 'Left railing', count: 400 });
    l = reverseRun(l, 'right');
    expect(l.runs[1]!.points).toEqual([[6.5, 1.5, 0], [6.5, 0.9, 1.4]]);
    l = removeRun(l, 'left');
    expect(l.runs.map((r) => r.id)).toEqual(['right']);
    expect(l.groups!.porch!.runs).toEqual(['right']);
  });

  it('edits points: set, insert after, append and remove (never below one point)', () => {
    let l = setPoint(layout(), 'right', 0, [7, 1, 1]);
    expect(l.runs[1]!.points![0]).toEqual([7, 1, 1]);
    l = insertPoint(l, 'right', 0);
    expect(l.runs[1]!.points!.length).toBe(3);
    expect(l.runs[1]!.points![1]).toEqual([6.75, 1.25, 0.5]); // midpoint of its neighbours
    l = appendPoint(l, 'right', [8.6, 1.5, 0]);
    expect(l.runs[1]!.points!.at(-1)).toEqual([8.6, 1.5, 0]);
    l = removePoint(l, 'right', 0);
    expect(l.runs[1]!.points!.length).toBe(3);
    const one = { ...l, runs: [{ ...l.runs[1]!, points: [[1, 1, 1]] as [number, number, number][] }] };
    expect(removePoint(one, 'right', 0).runs[0]!.points!.length).toBe(1);
  });

  it('measures run length in metres along the polyline', () => {
    expect(runLength(layout().runs[0]!)).toBeCloseTo(5 + Math.hypot(0.6, 1.4), 6);
  });

  it('explains what is wrong with an invalid layout', () => {
    expect(layoutError(updateRun(layout(), 'right', { start: 400 }))).toMatch(/claimed by more than one run/);
    expect(layoutError(updateRun(layout(), 'right', { count: 700 }))).toMatch(/exceeds controller/);
    expect(layoutError(layout())).toBeNull();
  });
});

describe('History (shared undo for scenes and layouts)', () => {
  it('works for any JSON value', () => {
    const h = new History<LayoutConfig>(layout());
    h.edit(updateRun(h.value, 'left', { count: 10 }));
    h.undo();
    expect(h.value.runs[0]!.count).toBe(500);
    h.redo();
    expect(h.value.runs[0]!.count).toBe(10);
  });
});

describe('coiled runs keep their straight segments when points change', () => {
  const base = (): LayoutConfig => ({
    controllers: [{ id: 'c', name: 'C', host: 'x', pixelCount: 10 }],
    // Segments: 0 along the top, 1 down a post (straight), 2 back along the bottom.
    runs: [{ id: 'r', controller: 'c', start: 0, count: 10, points: [[0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0]], coil: { radius: 0.05, pitch: 0.25, skip: [1] } }],
  });
  const skip = (l: LayoutConfig) => l.runs[0]!.coil!.skip;

  it('reverse, insert and remove', () => {
    expect(skip(reverseRun(base(), 'r'))).toEqual([1]); // the post is still the middle segment
    expect(skip(insertPoint(base(), 'r', 0))).toEqual([2]); // a point added before it shifts it on
    expect(skip(insertPoint(base(), 'r', 1))).toEqual([1, 2]); // splitting the post: both halves straight
    expect(skip(removePoint(base(), 'r', 0))).toEqual([0]);
    expect(skip(removePoint(base(), 'r', 3))).toEqual([1]);
    expect(skip(removePoint(base(), 'r', 1))).toEqual([]); // the top and the post join: coiled
  });
});
