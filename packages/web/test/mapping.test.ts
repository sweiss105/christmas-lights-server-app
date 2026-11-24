import { describe, expect, it } from 'vitest';
import type { LayoutConfig } from '@xmas/engine';
import { QUALITY, type RunSolve } from '@xmas/engine/mapping';
import { ServerClock } from '../src/clock.js';
import { rgbaToLum } from '../src/mapping/workerProtocol.js';
import { applyPositions, solverViews } from '../src/mapping/review.js';
import type { MappingView } from '../src/api.js';

describe('mapping in the browser', () => {
  it('turns camera RGBA into greyscale weighted towards green', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255]);
    expect([...rgbaToLum(rgba, 3, 1)]).toEqual([255, 127, 63]);
  });

  it('converts the server’s sequence start to the phone’s clock', async () => {
    const local = 100;
    const clock = new ServerClock(async () => 5000 + local, () => local);
    await clock.sync(1);
    expect(clock.toLocal(5110)).toBeCloseTo(110, 6); // the server reads 5000 s ahead
  });

  it('writes measured positions only into the chosen runs', () => {
    const layout: LayoutConfig = {
      controllers: [{ id: 'c', name: 'C', host: 'x', pixelCount: 4 }],
      runs: [
        { id: 'a', controller: 'c', start: 0, count: 2, points: [[0, 0, 0], [1, 0, 0]] },
        { id: 'b', controller: 'c', start: 2, count: 2, points: [[0, 1, 0], [1, 1, 0]] },
      ],
    };
    const run = (id: string): RunSolve => ({ runId: id, count: 2, positions: [[5, 5, 5], [6, 6, 6]], quality: [QUALITY.triangulated, QUALITY.filled], measured: 1, oneView: 0, filled: 1, rejected: 0, spacing: 1, moved: 1 });
    const next = applyPositions(layout, [run('a'), run('b')], new Set(['b']));
    expect(next.runs[0]!.positions).toBeUndefined();
    expect(next.runs[1]!.positions).toEqual([[5, 5, 5], [6, 6, 6]]);
    expect(layout.runs[1]!.positions).toBeUndefined(); // the saved layout is untouched
  });

  it('leaves out spots filmed against a layout of a different size', () => {
    const v = (id: string, layoutPixels: number) => ({ id, layoutPixels, width: 10, height: 10, detections: [] }) as unknown as MappingView;
    expect(solverViews([v('a', 4), v('b', 9)], 4).map((x) => x.id)).toEqual(['a']);
  });
});
