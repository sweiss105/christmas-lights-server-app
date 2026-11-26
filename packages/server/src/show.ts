/**
 * Show automation logic: playlists and the nightly schedule. Pure functions of the time they're
 * given, so they're testable and survive restarts (a playlist's position comes from when it started).
 */

export interface PlaylistEntry {
  scene: string;
  seconds: number;
  /** Seconds to crossfade into this scene (0..60, like a WLED playlist step's transition); absent = the app's fade. */
  fade?: number;
}
export interface PlaylistConfig {
  name: string;
  entries: PlaylistEntry[];
  loop: boolean;
  /** Play the scenes in a random order, a new one each time round (like WLED's playlist shuffle). */
  shuffle?: boolean;
}

/** Small seeded generator (mulberry32), so a shuffled order can be worked out again after a restart. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The order of the entries in time round `cycle` of a shuffled playlist started at `startedAt`:
 * random, but the same every time it's asked (it depends only on those two numbers). A round
 * never starts with the scene the previous round ended on, when it can help it.
 */
export function shuffledOrder(count: number, startedAt: number, cycle: number): number[] {
  // Two scenes can only avoid a repeat by taking turns, so every round has the same order.
  if (count === 2) return rawShuffle(2, startedAt, 0);
  const order = rawShuffle(count, startedAt, cycle);
  // The fix-up below only swaps a round's first two places, so with three or more scenes the scene
  // a round ends on is its plain shuffle's last. That makes each round depend on the one before it
  // only, however long the playlist has been running (it used to walk back through every round).
  if (cycle > 0 && count > 2) {
    const prev = rawShuffle(count, startedAt, cycle - 1);
    if (order[0] === prev[count - 1]) [order[0], order[1]] = [order[1]!, order[0]!];
  }
  return order;
}

/** A plain seeded shuffle of 0..count-1 for one round. */
function rawShuffle(count: number, startedAt: number, cycle: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  const rand = seeded(Math.floor(startedAt) ^ Math.imul(cycle + 1, 0x9e3779b1));
  for (let i = count - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
  return order;
}

/**
 * Which entry is playing at `now` for a playlist started at `startedAt` (ms), and when it changes.
 * `index` is the entry's place in `entries`, whatever order it plays in.
 */
export function playlistPosition(entries: PlaylistEntry[], startedAt: number, now: number, loop: boolean, shuffle = false): { index: number; nextAt: number | null } {
  const total = entries.reduce((a, e) => a + e.seconds * 1000, 0);
  if (!entries.length || total <= 0) return { index: 0, nextAt: null };
  let t = Math.max(0, now - startedAt);
  const lastRound = !loop && t >= total;
  const cycles = lastRound ? 0 : Math.floor(t / total);
  const order = shuffle ? shuffledOrder(entries.length, startedAt, cycles) : entries.map((_, i) => i);
  if (lastRound) return { index: order[entries.length - 1]!, nextAt: null };
  t -= cycles * total;
  let at = startedAt + cycles * total;
  for (let k = 0; k < order.length; k++) {
    const i = order[k]!;
    const d = entries[i]!.seconds * 1000;
    if (t < d) {
      const nextAt = at + d;
      return { index: i, nextAt: !loop && k === order.length - 1 ? null : nextAt };
    }
    t -= d;
    at += d;
  }
  return { index: order[0]!, nextAt: at };
}

// ---- schedule ----------------------------------------------------------------------------------

export type OnAt = { kind: 'sunset'; offsetMinutes?: number } | { kind: 'time'; time: string };
export type OffAt = { kind: 'time'; time: string } | { kind: 'sunrise'; offsetMinutes?: number };

export interface ScheduleConfig {
  enabled: boolean;
  /** IANA time zone, e.g. "America/Chicago". */
  timezone: string;
  /** Needed for sunset/sunrise. */
  latitude?: number;
  longitude?: number;
  on: OnAt;
  off: OffAt;
  /** What to start when the lights come on. */
  run: { kind: 'scene' | 'playlist'; name: string };
}

const DAY = 86_400_000;
const rad = Math.PI / 180;

/**
 * Sunrise and sunset (ms) for the solar day around `when`, by the standard sunrise equation
 * (accurate to a minute or two away from the poles). Longitude east positive.
 */
export function sunTimes(when: number, latitude: number, longitude: number): { sunrise: number; sunset: number } {
  const jd = when / DAY + 2440587.5;
  const n = Math.round(jd - 2451545.0 + 0.0008 - longitude / 360);
  const jStar = n + 0.0009 - longitude / 360;
  const m = (357.5291 + 0.98560028 * jStar) % 360;
  const c = 1.9148 * Math.sin(m * rad) + 0.02 * Math.sin(2 * m * rad) + 0.0003 * Math.sin(3 * m * rad);
  const lambda = (m + c + 180 + 102.9372) % 360;
  const jTransit = 2451545.0 + jStar + 0.0053 * Math.sin(m * rad) - 0.0069 * Math.sin(2 * lambda * rad);
  const sinDec = Math.sin(lambda * rad) * Math.sin(23.4397 * rad);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosW = (Math.sin(-0.833 * rad) - Math.sin(latitude * rad) * sinDec) / (Math.cos(latitude * rad) * cosDec);
  const w = Math.acos(Math.max(-1, Math.min(1, cosW))) / rad; // polar day/night clamp
  const toMs = (j: number) => (j - 2440587.5) * DAY;
  return { sunrise: toMs(jTransit - w / 360), sunset: toMs(jTransit + w / 360) };
}

/** Local calendar date ("YYYY-MM-DD") of an instant in a time zone. */
export function localDate(when: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(when));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Offset (ms) of a time zone from UTC at an instant. */
function tzOffset(when: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(when));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(when / 1000) * 1000;
}

/** The instant a local clock in `timezone` shows `time` ("HH:MM") on `date` ("YYYY-MM-DD"). */
export function zonedTime(date: string, time: string, timezone: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  let t = guess - tzOffset(guess, timezone);
  t = guess - tzOffset(t, timezone); // second pass settles daylight-saving changes
  return t;
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** The on/off window that starts on local date `date`. */
function windowOn(s: ScheduleConfig, date: string): { on: number; off: number } {
  const noon = zonedTime(date, '12:00', s.timezone);
  const sun = (d: number) => sunTimes(d, s.latitude ?? 0, s.longitude ?? 0);
  const on = s.on.kind === 'sunset'
    ? sun(noon).sunset + (s.on.offsetMinutes ?? 0) * 60_000
    : zonedTime(date, s.on.time, s.timezone);
  let off = s.off.kind === 'sunrise'
    ? sun(noon + DAY).sunrise + (s.off.offsetMinutes ?? 0) * 60_000
    : zonedTime(date, s.off.time, s.timezone);
  if (off <= on) off = s.off.kind === 'time' ? zonedTime(addDays(date, 1), s.off.time, s.timezone) : off + DAY;
  return { on, off };
}

/** The window containing `now`, or the next one to come. */
export function nextWindow(s: ScheduleConfig, now: number): { on: number; off: number } {
  const today = localDate(now, s.timezone);
  for (const d of [addDays(today, -1), today, addDays(today, 1), addDays(today, 2)]) {
    const w = windowOn(s, d);
    if (now < w.off) return w;
  }
  return windowOn(s, addDays(today, 3));
}

export function inWindow(s: ScheduleConfig, now: number): boolean {
  const w = nextWindow(s, now);
  return now >= w.on && now < w.off;
}

/** A valid IANA time zone? */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
