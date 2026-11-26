import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLayout, type LayoutConfig } from '@xmas/engine';
import { planMapping, QUALITY, type RunSolve } from '@xmas/engine/mapping';
import { simulatedSource } from '../src/mapping/capture.js';
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

  describe('the demo’s simulated camera on a slow computer', () => {
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
    const layout: LayoutConfig = { controllers: [{ id: 'c', name: 'C', host: 'x', pixelCount: 6 }], runs: [{ id: 'a', controller: 'c', start: 0, count: 6, points: [[0, 0, 0], [5, 0, 0]] }] };
    const view = { eye: [2.5, 0, 10] as [number, number, number], target: [2.5, 0, 0] as [number, number, number], hfovDeg: 60, width: 32, height: 18 };
    /** A source whose timer can fire late: the clock only moves when the test says so. */
    const setup = () => {
      let now = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const source = simulatedSource(layout, planMapping(buildLayout(layout)), view, 1000, null);
      const times: number[] = [];
      let open = true;
      const stop = source.start((t) => times.push(t), () => open);
      return { source, times, stop, setClock: (ms: number) => { now = ms; }, setOpen: (v: boolean) => { open = v; }, tick: () => vi.advanceTimersToNextTimer() };
    };

    it('stamps frames with the moment they show, not when a late timer gets to them', () => {
      const { source, times, stop, setClock, tick } = setup();
      expect(source.simulated).toBe(true);
      setClock(1000); // the timer fires a whole second late
      tick();
      stop();
      expect(times.length).toBeGreaterThan(25); // about 30 frames a second, a few dropped like a real camera
      expect(times[0]).toBeLessThan(40);
      expect(times.at(-1)).toBeLessThanOrEqual(1000);
      for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThan(20); // spread out, not bunched
    });

    it('waits for a busy decoder instead of dropping frames', () => {
      const { times, stop, setClock, setOpen, tick } = setup();
      setClock(500);
      setOpen(false);
      tick();
      expect(times).toEqual([]); // nothing made while the decoder is busy
      setOpen(true);
      tick();
      const first = times.length;
      setClock(1000);
      tick();
      stop();
      expect(first).toBeGreaterThan(10);
      expect(times[0]).toBeLessThan(40); // it picks up from the start, nothing skipped
      for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeLessThan(110); // at most a couple of dropped frames in a row
    });
  });
});
