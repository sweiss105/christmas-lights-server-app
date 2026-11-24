import { describe, expect, it } from 'vitest';
import { estimateOffset, ServerClock } from '../src/clock.js';
import { latestWins } from '../src/latest.js';

describe('clock sync', () => {
  it('uses the shortest round trip and its midpoint', () => {
    const offset = estimateOffset([
      { sentAt: 10, receivedAt: 10.5, serverT: 100.4 }, // slow, noisy sample
      { sentAt: 11, receivedAt: 11.02, serverT: 101.01 }, // fast sample: midpoint 11.01 ↔ 101.01
    ]);
    expect(offset).toBeCloseTo(90, 6);
  });

  it('tracks a server clock that runs ahead of local time', async () => {
    let local = 5;
    const clock = new ServerClock(async () => { local += 0.01; const t = local + 42; local += 0.01; return t; }, () => local);
    expect(clock.synced).toBe(false);
    await clock.sync(3);
    expect(clock.synced).toBe(true);
    expect(clock.now() - local).toBeCloseTo(42, 6);
  });
});

describe('latestWins', () => {
  it('sends the first value at once, then only the newest value after each request finishes', async () => {
    const sent: number[] = [];
    const releases: (() => void)[] = [];
    const push = latestWins<number>((v) => { sent.push(v); return new Promise<void>((r) => releases.push(r)); });
    push(1); push(2); push(3); push(4);
    expect(sent).toEqual([1]);
    releases.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([1, 4]);
    releases.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([1, 4]);
  });

  it('reports errors and keeps working', async () => {
    const errors: unknown[] = [];
    let fail = true;
    const sent: number[] = [];
    const push = latestWins<number>(async (v) => { sent.push(v); if (fail) { fail = false; throw new Error('boom'); } }, (e) => errors.push(e));
    push(1);
    await new Promise((r) => setTimeout(r, 0));
    push(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([1, 2]);
    expect(errors).toHaveLength(1);
  });
});
