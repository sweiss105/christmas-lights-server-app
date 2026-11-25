import { describe, expect, it } from 'vitest';
import { inWindow, nextWindow, playlistPosition, shuffledOrder, sunTimes, zonedTime, type ScheduleConfig } from '../src/show.js';

const H = 3600_000, M = 60_000;
const utc = (s: string) => Date.parse(s);

describe('playlist position', () => {
  const entries = [{ scene: 'A', seconds: 10 }, { scene: 'B', seconds: 20 }, { scene: 'C', seconds: 30 }];

  it('works out the current entry from when the playlist started, looping', () => {
    expect(playlistPosition(entries, 0, 0, true)).toMatchObject({ index: 0, nextAt: 10_000 });
    expect(playlistPosition(entries, 0, 15_000, true)).toMatchObject({ index: 1, nextAt: 30_000 });
    expect(playlistPosition(entries, 0, 59_999, true)).toMatchObject({ index: 2, nextAt: 60_000 });
    expect(playlistPosition(entries, 0, 61_000, true)).toMatchObject({ index: 0, nextAt: 70_000 }); // second time round
  });

  it('holds the last entry when not looping', () => {
    expect(playlistPosition(entries, 0, 600_000, false)).toMatchObject({ index: 2, nextAt: null });
  });
});

describe('shuffled playlists', () => {
  const entries = [{ scene: 'A', seconds: 10 }, { scene: 'B', seconds: 20 }, { scene: 'C', seconds: 30 }];
  const many = Array.from({ length: 8 }, (_, i) => ({ scene: `S${i}`, seconds: 10 }));
  const round = (startedAt: number, cycle: number) =>
    Array.from({ length: 8 }, (_, k) => playlistPosition(many, startedAt, startedAt + cycle * 80_000 + k * 10_000 + 5, true, true).index);

  it('plays every scene once per round, in an order that changes from round to round', () => {
    const r0 = round(1_700_000_000_000, 0), r1 = round(1_700_000_000_000, 1);
    expect([...r0].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect([...r1].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(r0).not.toEqual(r1);
    expect(r0).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('gives the same order when asked again (so it survives a restart)', () => {
    expect(round(1_700_000_123_456, 3)).toEqual(round(1_700_000_123_456, 3));
    expect(shuffledOrder(8, 42, 5)).toEqual(shuffledOrder(8, 42, 5));
  });

  it('never starts a round with the scene the last round ended on', () => {
    for (let c = 1; c < 200; c++) expect(shuffledOrder(5, 99, c)[0]).not.toBe(shuffledOrder(5, 99, c - 1)[4]);
  });

  it('keeps each scene’s own length, and not looping ends on the round’s last scene', () => {
    const order = shuffledOrder(entries.length, 0, 0);
    let at = 0;
    for (const i of order) {
      expect(playlistPosition(entries, 0, at + 1, true, true)).toMatchObject({ index: i, nextAt: at + entries[i]!.seconds * 1000 });
      at += entries[i]!.seconds * 1000;
    }
    expect(playlistPosition(entries, 0, 10 * 60_000, false, true)).toMatchObject({ index: order[2], nextAt: null });
  });
});

describe('sunrise and sunset', () => {
  it('New York on the winter solstice: sunset about 16:32 EST (21:32 UTC)', () => {
    const { sunset } = sunTimes(utc('2026-12-21T17:00:00Z'), 40.7128, -74.006);
    expect(Math.abs(sunset - utc('2026-12-21T21:32:00Z'))).toBeLessThan(5 * M);
  });

  it('London on the summer solstice: sunrise about 04:43 BST, sunset about 21:21 BST', () => {
    const { sunrise, sunset } = sunTimes(utc('2026-06-21T12:00:00Z'), 51.5074, -0.1278);
    expect(Math.abs(sunrise - utc('2026-06-21T03:43:00Z'))).toBeLessThan(5 * M);
    expect(Math.abs(sunset - utc('2026-06-21T20:21:00Z'))).toBeLessThan(5 * M);
  });
});

describe('time zones', () => {
  it('turns a local clock time into an instant, across daylight saving', () => {
    expect(zonedTime('2026-12-24', '18:00', 'America/Chicago')).toBe(utc('2026-12-25T00:00:00Z')); // CST = UTC-6
    expect(zonedTime('2026-07-04', '21:30', 'America/Chicago')).toBe(utc('2026-07-05T02:30:00Z')); // CDT = UTC-5
    expect(zonedTime('2026-12-24', '18:00', 'UTC')).toBe(utc('2026-12-24T18:00:00Z'));
  });
});

describe('nightly window', () => {
  const sched = (over: Partial<ScheduleConfig> = {}): ScheduleConfig => ({
    enabled: true, timezone: 'America/New_York', latitude: 40.7128, longitude: -74.006,
    on: { kind: 'sunset', offsetMinutes: 0 }, off: { kind: 'time', time: '23:00' },
    run: { kind: 'scene', name: 'Warm white' }, ...over,
  });

  it('finds tonight’s window: sunset to 23:00 local', () => {
    const w = nextWindow(sched(), utc('2026-12-21T15:00:00Z'));
    expect(Math.abs(w.on - utc('2026-12-21T21:32:00Z'))).toBeLessThan(5 * M);
    expect(w.off).toBe(utc('2026-12-22T04:00:00Z')); // 23:00 EST
  });

  it('a fixed on time with an off time after midnight spans midnight', () => {
    const s = sched({ on: { kind: 'time', time: '17:00' }, off: { kind: 'time', time: '01:00' } });
    expect(inWindow(s, utc('2026-12-22T05:30:00Z'))).toBe(true); // 00:30 EST, still last night's window
    expect(inWindow(s, utc('2026-12-22T06:30:00Z'))).toBe(false); // 01:30 EST
    expect(inWindow(s, utc('2026-12-21T22:30:00Z'))).toBe(true); // 17:30 EST
    expect(inWindow(s, utc('2026-12-21T21:30:00Z'))).toBe(false); // 16:30 EST
  });

  it('an offset moves the on time relative to sunset', () => {
    const a = nextWindow(sched(), utc('2026-12-21T15:00:00Z')).on;
    const b = nextWindow(sched({ on: { kind: 'sunset', offsetMinutes: -15 } }), utc('2026-12-21T15:00:00Z')).on;
    expect(a - b).toBe(15 * M);
  });

  it('after tonight’s window has ended, the next window is tomorrow', () => {
    const w = nextWindow(sched(), utc('2026-12-22T05:00:00Z')); // 00:00 EST, after the 23:00 off
    expect(w.on).toBeGreaterThan(utc('2026-12-22T20:00:00Z'));
    expect(w.off).toBe(utc('2026-12-23T04:00:00Z'));
    expect(H).toBe(3600_000);
  });
});
