/** Playlist timing: pure functions of the time they're given, shared by the server and the browser demo. */

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

