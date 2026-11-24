import { createRandom, type Random } from './random.js';

/**
 * Deterministic simulation for effects with state (particles, fire, cellular automata).
 *
 * The state at time t depends only on t: time is split into windows; each window starts from
 * `init` with a seed derived from the window number, then advances in fixed steps, one per frame.
 * So the server and the browser preview, which share the effect clock, compute identical frames even
 * if one of them started rendering minutes later. Normal playback steps forward incrementally; a jump
 * backwards or into another window re-simulates from that window's start.
 *
 * With `warmup`, each window's simulation starts that many seconds before the window (except the
 * first window, which starts at t = 0), so a window begins with a lived-in state instead of a blank
 * one. During the last `warmup` seconds of a window the next window's simulation is already stepped
 * alongside, so playback never pays for the warm-up in a single frame.
 */
export interface SimOptions<S> {
  /** Steps per second. */
  fps: number;
  /** Window length in seconds. Longer windows hide the reseed better but cost more on a cold start. */
  window: number;
  /** Seconds simulated before each window starts (default 0). */
  warmup?: number;
  seed: number;
  /** Fresh state for a window. `reuse` is a state from a finished window that may be recycled. */
  init: (rnd: Random, reuse?: S) => S;
  /** Advance one frame. `frame` is the absolute frame index being produced (its time is frame / fps). */
  step: (state: S, rnd: Random, dt: number, frame: number) => void;
}

interface Run<S> { w: number; next: number; state: S; rnd: Random }

export function simulation<S>(o: SimOptions<S>) {
  const spw = Math.max(1, Math.round(o.window * o.fps));
  const warm = Math.max(0, Math.round((o.warmup ?? 0) * o.fps));
  const dt = 1 / o.fps;
  let cur: Run<S> | null = null;
  let nxt: Run<S> | null = null;
  let spare: S | undefined;

  const startFrame = (w: number) => w * spw - Math.min(warm, w * spw);
  const open = (w: number): Run<S> => {
    const rnd = createRandom(o.seed * 7919 + w * 104729);
    const state = o.init(rnd, spare);
    spare = undefined;
    return { w, next: startFrame(w), state, rnd };
  };
  const drop = (r: Run<S> | null) => { if (r) spare = r.state; };
  const advance = (r: Run<S>, frame: number) => {
    while (r.next <= frame) { o.step(r.state, r.rnd, dt, r.next); r.next++; }
  };

  return {
    /** State after the frame at time t (seconds). The returned object is reused: read it, don't keep it. */
    at(t: number): S {
      const total = Math.max(0, Math.floor(t * o.fps + 1e-6));
      const w = Math.floor(total / spw);
      if (!cur || cur.w !== w || cur.next > total + 1) {
        if (nxt && nxt.w === w && nxt.next <= total + 1) { drop(cur); cur = nxt; nxt = null; }
        else { drop(cur); cur = open(w); }
      }
      advance(cur, total);
      if (warm > 0 && total >= startFrame(w + 1)) {
        if (!nxt || nxt.w !== w + 1 || nxt.next > total + 1) { drop(nxt); nxt = open(w + 1); }
        advance(nxt, total);
      }
      return cur.state;
    },
  };
}
