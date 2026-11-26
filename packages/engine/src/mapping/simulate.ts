/**
 * A synthetic phone camera for testing mapping without lights or a phone: renders the coded
 * sequence as the camera would see it from a given spot. It models what makes real capture hard:
 * an unknown delay before the sequence starts, frame timing jitter and dropped frames, exposure
 * time and a rolling shutter (rows see a slot change at different moments), blur, sensor noise,
 * background light (including bright street lights that never change), auto-exposure drift, a
 * slightly unsteady hand, and lights hidden behind things.
 */
import type { Vec3 } from '../layout.js';
import { focalFromFov, lookAt, project, type Intrinsics, type Pose } from './camera.js';

export interface SimView {
  eye: Vec3;
  target: Vec3;
  /** Horizontal field of view, degrees. */
  hfovDeg: number;
  width: number;
  height: number;
}

export interface SimOptions {
  /** True position of every pixel (xyz per pixel; NaN where none). */
  positions: Float32Array;
  /** Which pixels are lit in each slot (from slotMasks). */
  masks: Uint8Array[];
  holdMs: number;
  view: SimView;
  /** Frame-clock time (ms) at which slot 0 truly starts, as the camera sees it. */
  startMs: number;
  /** Frame-clock times (ms) to film between. */
  fromMs: number;
  toMs: number;
  fps?: number;
  jitterMs?: number;
  dropRate?: number;
  exposureMs?: number;
  /** Time the rolling shutter takes from the top row to the bottom row. */
  rollingMs?: number;
  /** Gaussian blur of a light, picture pixels. */
  blurPx?: number;
  /** Brightness of a lit light's centre before clipping at 255. */
  ledPeak?: number;
  /** Background level (0..255) and noise (standard deviation). */
  ambient?: number;
  noise?: number;
  /** Share of lights hidden from this spot (behind a rail, a post, a bush). */
  occlusion?: number;
  /** Hand shake: largest drift of the whole picture, pixels. */
  shakePx?: number;
  /** Auto-exposure drift: brightness varies by up to this share. */
  gainDrift?: number;
  /**
   * A shiny floor or rail: every light also shows mirrored about picture row `y` (share of the
   * height), with `strength` times its light, spread over `blurPx`.
   */
  reflection?: { y: number; strength: number; blurPx: number };
  seed?: number;
}

/** A small fast seeded random generator (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function simCamera(view: SimView): { pose: Pose; k: Intrinsics } {
  return { pose: lookAt(view.eye, view.target), k: { f: focalFromFov(view.width, view.hfovDeg), cx: view.width / 2, cy: view.height / 2 } };
}

/** True picture position of each pixel from this view (NaN if behind the camera). */
export function trueProjection(positions: Float32Array, view: SimView): Float32Array {
  const { pose, k } = simCamera(view);
  const n = positions.length / 3;
  const out = new Float32Array(n * 2).fill(NaN);
  for (let i = 0; i < n; i++) {
    const X: Vec3 = [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
    if (Number.isNaN(X[0])) continue;
    const p = project(pose, k, X);
    if (p) { out[i * 2] = p[0]; out[i * 2 + 1] = p[1]; }
  }
  return out;
}

/** Frames as the phone would record them, one at a time. */
export function* simulateFrames(o: SimOptions): Generator<{ t: number; lum: Uint8Array }> {
  const { width: w, height: h } = o.view;
  const fps = o.fps ?? 30, jitter = o.jitterMs ?? 3, drop = o.dropRate ?? 0.03, exposure = o.exposureMs ?? 20, rolling = o.rollingMs ?? 22;
  const blur = o.blurPx ?? 1.2, peak = o.ledPeak ?? 600, ambient = o.ambient ?? 14, noise = o.noise ?? 3;
  const occl = o.occlusion ?? 0.08, shake = o.shakePx ?? 0.6, drift = o.gainDrift ?? 0.08;
  const rand = rng(o.seed ?? 1);
  const proj = trueProjection(o.positions, o.view);
  const n = o.positions.length / 3;
  const visible: number[] = [];
  for (let i = 0; i < n; i++) if (!Number.isNaN(proj[i * 2]!) && rand() >= occl) visible.push(i);

  // Background: a dim gradient (sky to ground), a lit window and two street lights that never change.
  const bg = new Float32Array(w * h);
  const lamps = [[0.08, 0.3, 18], [0.93, 0.25, 14]].map(([x, y, r]) => [x! * w, y! * h, (r! * w) / 960]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = ambient * (0.6 + 0.8 * (y / h));
    for (const [lx, ly, r] of lamps) { const d2 = ((x - lx!) ** 2 + (y - ly!) ** 2) / (r! * r!); if (d2 < 9) v += 400 * Math.exp(-d2); }
    if (x > w * 0.42 && x < w * 0.5 && y > h * 0.12 && y < h * 0.22) v += 40;
    bg[y * w + x] = v;
  }

  const acc = new Float32Array(w * h);
  /** Add a blurred spot of light centred at (px, py). */
  const splat = (px: number, py: number, amp: number, sigma: number) => {
    const R = Math.ceil(sigma * 3);
    const x0 = Math.floor(px), y0 = Math.floor(py);
    for (let dy = -R; dy <= R; dy++) {
      const yy = y0 + dy;
      for (let dx = -R; dx <= R; dx++) {
        const xx = x0 + dx;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        // Picture pixel (xx, yy) covers xx..xx+1, so its centre is half a pixel in.
        const ex = xx + 0.5 - px, ey = yy + 0.5 - py;
        acc[yy * w + xx]! += amp * Math.exp(-(ex * ex + ey * ey) / (2 * sigma * sigma));
      }
    }
  };
  /** Share of the exposure window [a, b] during which pixel i is lit. */
  const litShare = (i: number, a: number, b: number) => {
    let on = 0;
    for (let s = Math.floor((a - o.startMs) / o.holdMs); ; s++) {
      const s0 = o.startMs + s * o.holdMs, s1 = s0 + o.holdMs;
      const lo = Math.max(a, s0), hi = Math.min(b, s1);
      if (hi > lo && s >= 0 && s < o.masks.length && o.masks[s]![i]) on += hi - lo;
      if (s1 >= b) break;
    }
    return on / (b - a);
  };

  const period = 1000 / fps;
  const phase = rand() * 2 * Math.PI;
  for (let k = 0; ; k++) {
    const t = o.fromMs + k * period + (rand() - 0.5) * 2 * jitter;
    if (t > o.toMs) return;
    if (rand() < drop) continue;
    const gain = 1 + drift * Math.sin(t / 1700 + phase);
    const sx = shake * Math.sin(t / 2300 + phase), sy = shake * Math.cos(t / 3100 + phase * 2);
    acc.fill(0);
    for (const i of visible) {
      const px = proj[i * 2]! + sx, py = proj[i * 2 + 1]! + sy;
      // The row's exposure ends a little later the lower it is in the picture (rolling shutter).
      const end = t - rolling * (1 - py / h);
      const share = litShare(i, end - exposure, end);
      if (share <= 0) continue;
      const amp = peak * share * gain;
      splat(px, py, amp, blur);
      // The same total light, spread wider.
      if (o.reflection) splat(px, 2 * o.reflection.y * h - py, amp * o.reflection.strength * (blur / o.reflection.blurPx) ** 2, o.reflection.blurPx);
    }
    const lum = new Uint8Array(w * h);
    for (let j = 0; j < lum.length; j++) {
      // Cheap near-Gaussian noise: sum of two uniforms.
      const nz = (rand() + rand() - 1) * noise * 2.45;
      const v = bg[j]! * gain + acc[j]! + nz;
      lum[j] = v <= 0 ? 0 : v >= 255 ? 255 : v;
    }
    yield { t, lum };
  }
}
