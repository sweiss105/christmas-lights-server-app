import { createRandom, type Random } from './random.js';

/**
 * Deterministic simulation for effects with state (particles, fire, cellular automata).
 *
 * The state at time t depends only on t: time is split into windows; each window starts from
 * `init` with a seed derived from the window number, then advances in fixed steps. So the server
 * and the browser preview, which share the effect clock, compute identical frames even if one of
 * them started rendering minutes later. Normal playback steps forward incrementally; a jump
 * backwards or into another window re-simulates from that window's start.
 */
export interface SimOptions<S> {
  /** Steps per second. */
  fps: number;
  /** Window length in seconds. Longer windows hide the reseed better but cost more on a cold start. */
  window: number;
  seed: number;
  init: (rnd: Random) => S;
  step: (state: S, rnd: Random, dt: number) => void;
}

export function simulation<S>(o: SimOptions<S>) {
  let windowIndex = -1;
  let stepIndex = 0;
  let state!: S;
  let rnd!: Random;
  const stepsPerWindow = Math.max(1, Math.round(o.window * o.fps));
  const dt = 1 / o.fps;

  return {
    /** State at time t (seconds). The returned object is reused: read it, don't keep it. */
    at(t: number): S {
      const total = Math.max(0, Math.floor(t * o.fps));
      const w = Math.floor(total / stepsPerWindow);
      const target = total - w * stepsPerWindow;
      if (w !== windowIndex || target < stepIndex) {
        windowIndex = w;
        rnd = createRandom(o.seed * 7919 + w * 104729);
        state = o.init(rnd);
        stepIndex = 0;
      }
      while (stepIndex < target) { o.step(state, rnd, dt); stepIndex++; }
      return state;
    },
  };
}
