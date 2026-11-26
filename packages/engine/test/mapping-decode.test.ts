import { describe, expect, it } from 'vitest';
import { buildLayout } from '../src/index.js';
import { codeWord, decodeWord, findStart, fromGray, gray, planMapping, slotLevels, type SimView } from '../src/mapping/index.js';
import { filmAndDecode, roughLayout, spots } from './mapping-fixture.js';

describe('codes', () => {
  it('Gray code and parity round-trip, and a single flipped bit is caught', () => {
    for (let c = 1; c < 600; c++) {
      expect(fromGray(gray(c))).toBe(c);
      const w = codeWord(c, 10);
      expect(decodeWord(w, 10)).toBe(c);
      for (let b = 0; b <= 10; b++) expect(decodeWord(w ^ (1 << b), 10)).toBeNull();
    }
  });
});

describe('timing from the preamble', () => {
  it('finds the start to within a frame from a noisy brightness signal', () => {
    const plan = planMapping(buildLayout(roughLayout), { holdMs: 250 });
    const levels = slotLevels(plan);
    const trueStart = 5137;
    const sig: { t: number; s: number }[] = [];
    for (let t = 3000; t < 9000; t += 33.3) {
      const slot = Math.floor((t - 40 - trueStart) / 250); // 40 ms camera delay
      const lvl = slot < 0 || slot >= levels.length ? 0 : levels[slot]!;
      sig.push({ t, s: 50000 + 80000 * lvl + (Math.random() - 0.5) * 6000 });
    }
    const { start, score } = findStart(sig, levels, 250, 5000, 800);
    expect(score).toBeGreaterThan(0.9);
    expect(Math.abs(start - (trueStart + 40))).toBeLessThan(25);
  });
});

describe('decoding a filmed view', () => {
  it('reads the lights’ codes and finds their picture positions', () => {
    const view: SimView = { ...spots[1]!, hfovDeg: 68, width: 960, height: 540 };
    const { result, plan, proj } = filmAndDecode(view);
    expect(result.ok).toBe(true);
    expect(Math.abs(result.stats.offsetMs - -180)).toBeLessThan(30);
    const lit = plan.passes.reduce((a, p) => a + p.pixels.filter((px) => !Number.isNaN(proj[px * 2]!)).length, 0);
    const d = result.detections;
    // Most lights in view are read (some are hidden by design, some merge with a neighbour)...
    expect(d.length).toBeGreaterThan(lit * 0.7);
    // ...and almost none are wrong: a wrong one sits far from its pixel's true picture position.
    const errs = d.map((x) => Math.hypot(x.x - proj[x.pixel * 2]!, x.y - proj[x.pixel * 2 + 1]!));
    const wrong = errs.filter((e) => e > 3).length;
    expect(wrong).toBeLessThanOrEqual(Math.ceil(d.length * 0.01));
    const sorted = errs.filter((e) => e <= 3).sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]!).toBeLessThan(0.8); // sub-pixel centres (the simulated hand shakes up to 0.6 px)
  }, 60_000);

  it('copes with a bad clock guess and many dropped frames', () => {
    const view: SimView = { ...spots[0]!, hfovDeg: 68, width: 960, height: 540 };
    const { result, proj } = filmAndDecode(view, { clockErrorMs: -600, dropRate: 0.15, passes: 1, seed: 9 });
    expect(result.ok).toBe(true);
    const wrong = result.detections.filter((x) => Math.hypot(x.x - proj[x.pixel * 2]!, x.y - proj[x.pixel * 2 + 1]!) > 3);
    expect(result.detections.length).toBeGreaterThan(80);
    expect(wrong.length).toBeLessThanOrEqual(1);
  }, 60_000);

  it('says so when the lights are not in the picture', () => {
    const view: SimView = { eye: [0, 1, 12], target: [0, 30, -40], hfovDeg: 68, width: 320, height: 180 };
    const { result } = filmAndDecode(view, { passes: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  }, 60_000);
});

/** Lights in view, lights read, and how many of those are wrong (far from their pixel's true picture position). */
function score({ result, plan, proj }: ReturnType<typeof filmAndDecode>) {
  const lit = plan.passes.reduce((a, p) => a + p.pixels.filter((px) => !Number.isNaN(proj[px * 2]!)).length, 0);
  const d = result.detections;
  const wrong = d.filter((x) => Math.hypot(x.x - proj[x.pixel * 2]!, x.y - proj[x.pixel * 2 + 1]!) > 3).length;
  return { lit, read: d.length, wrong };
}

describe('what made the first night hard', () => {
  it('separates lights that touch, reading each from its own pixels', () => {
    // Out of focus: neighbouring lights blur into one spot.
    const view: SimView = { ...spots[1]!, hfovDeg: 68, width: 960, height: 540 };
    const film = filmAndDecode(view, { passes: 1, sim: { blurPx: 2.2 } });
    const { lit, read, wrong } = score(film);
    expect(film.result.stats.split).toBeGreaterThan(2);
    expect(read).toBeGreaterThan(lit * 0.7);
    expect(wrong).toBeLessThanOrEqual(Math.ceil(read * 0.01));
  }, 60_000);

  it('ignores reflections on a shiny floor', () => {
    const view: SimView = { ...spots[1]!, hfovDeg: 68, width: 960, height: 540 };
    const film = filmAndDecode(view, { passes: 1, sim: { reflection: { y: 0.62, strength: 0.5, blurPx: 3 } } });
    const { lit, read, wrong } = score(film);
    expect(read).toBeGreaterThan(lit * 0.75);
    expect(wrong).toBe(0); // no reflection taken for a light
  }, 60_000);

  it('restores a bit whose change the lights missed, from the parity', () => {
    // A Wi-Fi hiccup: the lights kept showing a bit's pattern through its inverse's slot.
    const view: SimView = { ...spots[1]!, hfovDeg: 68, width: 960, height: 540 };
    const film = filmAndDecode(view, {
      passes: 1,
      editMasks: (masks, plan) => {
        const slot = (kind: string) => plan.slots.findIndex((s) => s.kind === kind && s.pass === 0 && s.bit === 3);
        masks[slot('bit-inv')] = masks[slot('bit')]!;
      },
    });
    const { lit, read, wrong } = score(film);
    expect(read).toBeGreaterThan(lit * 0.75);
    expect(film.result.stats.repaired).toBeGreaterThan(read * 0.9);
    expect(wrong).toBeLessThanOrEqual(Math.ceil(read * 0.01));
  }, 60_000);
});
