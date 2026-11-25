import FastNoiseLite from 'fastnoise-lite';
import { clamp01, hsv, lerp, parseColor } from './color.js';
import type { Layout } from './layout.js';
import { WLED_EFFECTS } from './wled/index.js';

export type ParamSpec =
  | { key: string; label: string; type: 'number'; min: number; max: number; step?: number; default: number }
  /** `when`: only shown in the editor while another setting's value starts with this text (it always applies). */
  | { key: string; label: string; type: 'color'; default: string; when?: { key: string; startsWith: string } }
  | { key: string; label: string; type: 'vec3'; default: [number, number, number] }
  | { key: string; label: string; type: 'select'; options: string[]; default: string; labels?: Record<string, string> }
  | { key: string; label: string; type: 'palette'; default: string }
  | { key: string; label: string; type: 'boolean'; default: boolean }
  /** Free text, cut to `maxLength` characters (default 64, WLED's WLED_MAX_SEGNAME_LEN). */
  | { key: string; label: string; type: 'text'; default: string; maxLength?: number };

/** Default maximum length of a `text` param (WLED_MAX_SEGNAME_LEN). */
export const TEXT_MAX_LENGTH = 64;

/** Groups for the effect picker. */
export type EffectCategory = 'Basic' | 'Chase & Running' | 'Twinkle & Sparkle' | 'Fire & Fireworks' | 'Noise & Flow' | 'Waves & Patterns' | '2D' | 'Particles';
export const EFFECT_CATEGORIES: EffectCategory[] = ['Basic', 'Chase & Running', 'Twinkle & Sparkle', 'Fire & Fireworks', 'Noise & Flow', 'Waves & Patterns', '2D', 'Particles'];

export type Params = Record<string, unknown>;

/** Writes linear RGB floats (0..1) for every pixel into `out` (length count*3). */
export type RenderFn = (t: number, out: Float32Array) => void;

export interface EffectDef {
  id: string;
  name: string;
  description: string;
  category: EffectCategory;
  /** Name of the WLED effect this one recreates or ports (ports live in src/wled/), if any. */
  wled?: string;
  params: ParamSpec[];
  create(params: Params, layout: Layout): RenderFn;
}

/** Fill in defaults and coerce/validate values against the spec. */
export function resolveParams(def: EffectDef, input: Params = {}): Params {
  const out: Params = {};
  for (const p of def.params) {
    const v = input[p.key];
    if (v === undefined) { out[p.key] = p.default; continue; }
    switch (p.type) {
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${def.id}.${p.key} must be a number`);
        out[p.key] = Math.min(p.max, Math.max(p.min, v));
        break;
      case 'color':
        if (typeof v !== 'string') throw new Error(`${def.id}.${p.key} must be a color string`);
        parseColor(v);
        out[p.key] = v;
        break;
      case 'vec3':
        if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new Error(`${def.id}.${p.key} must be [x,y,z]`);
        out[p.key] = v;
        break;
      case 'select':
        if (typeof v !== 'string' || !p.options.includes(v)) throw new Error(`${def.id}.${p.key} must be one of ${p.options.join(', ')}`);
        out[p.key] = v;
        break;
      case 'palette':
        // Any name is accepted: palettes imported from WLED live in the show state; unknown ones fall back to Rainbow.
        if (typeof v !== 'string' || !v) throw new Error(`${def.id}.${p.key} must be a palette name`);
        out[p.key] = v;
        break;
      case 'boolean':
        if (typeof v !== 'boolean') throw new Error(`${def.id}.${p.key} must be true or false`);
        out[p.key] = v;
        break;
      case 'text': {
        if (typeof v !== 'string') throw new Error(`${def.id}.${p.key} must be text`);
        const max = p.maxLength ?? TEXT_MAX_LENGTH;
        // Count characters (code points), so a cut never splits an emoji's surrogate pair.
        out[p.key] = v.length <= max ? v : Array.from(v).slice(0, max).join('');
        break;
      }
    }
  }
  return out;
}

const num = (p: Params, k: string) => p[k] as number;
const col = (p: Params, k: string) => parseColor(p[k] as string);
const vec = (p: Params, k: string) => {
  const [x, y, z] = p[k] as number[];
  const l = Math.hypot(x!, y!, z!) || 1;
  return [x! / l, y! / l, z! / l] as const;
};

/** Stable per-pixel pseudo-random 0..1 */
function hash(i: number, seed = 0): number {
  let x = (i * 374761393 + seed * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

const solid: EffectDef = {
  id: 'solid', category: 'Basic', name: 'Solid', description: 'One colour everywhere.',
  params: [{ key: 'color', label: 'Colour', type: 'color', default: '#ff2a00' }],
  create(p, layout) {
    const [r, g, b] = col(p, 'color');
    return (_t, out) => { for (let i = 0; i < layout.count; i++) { out[i * 3] = r; out[i * 3 + 1] = g; out[i * 3 + 2] = b; } };
  },
};

const rainbow: EffectDef = {
  id: 'rainbow', category: 'Waves & Patterns', name: 'Rainbow', description: 'Hue cycles through space along a direction.',
  params: [
    { key: 'direction', label: 'Direction', type: 'vec3', default: [1, 0, 0] },
    { key: 'scale', label: 'Bands across house', type: 'number', min: 0.1, max: 10, step: 0.1, default: 1 },
    { key: 'speed', label: 'Speed (cycles/s)', type: 'number', min: -2, max: 2, step: 0.01, default: 0.1 },
    { key: 'saturation', label: 'Saturation', type: 'number', min: 0, max: 1, step: 0.01, default: 1 },
  ],
  create(p, layout) {
    const [dx, dy, dz] = vec(p, 'direction');
    const scale = num(p, 'scale'), speed = num(p, 'speed'), sat = num(p, 'saturation');
    const n = layout.normalized;
    return (t, out) => {
      for (let i = 0; i < layout.count; i++) {
        const d = n[i * 3]! * dx + n[i * 3 + 1]! * dy + n[i * 3 + 2]! * dz;
        const c = hsv(d * scale - t * speed, sat, 1);
        out.set(c, i * 3);
      }
    };
  },
};

const sweep: EffectDef = {
  id: 'sweep', category: 'Chase & Running', name: 'Sweep', description: 'A band of colour travels across the house.',
  params: [
    { key: 'color', label: 'Colour', type: 'color', default: '#ffffff' },
    { key: 'background', label: 'Background', type: 'color', default: '#000000' },
    { key: 'direction', label: 'Direction', type: 'vec3', default: [1, 0, 0] },
    { key: 'period', label: 'Seconds per pass', type: 'number', min: 0.2, max: 30, step: 0.1, default: 3 },
    { key: 'width', label: 'Band width', type: 'number', min: 0.01, max: 1, step: 0.01, default: 0.15 },
    { key: 'softness', label: 'Edge softness', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
  ],
  create(p, layout) {
    const fg = col(p, 'color'), bg = col(p, 'background');
    const [dx, dy, dz] = vec(p, 'direction');
    const period = num(p, 'period'), width = num(p, 'width'), soft = num(p, 'softness');
    const n = layout.normalized;
    // Project the layout onto the direction so the band starts and ends just off the lights.
    let lo = Infinity, hi = -Infinity;
    const proj = new Float32Array(layout.count);
    for (let i = 0; i < layout.count; i++) {
      const d = n[i * 3]! * dx + n[i * 3 + 1]! * dy + n[i * 3 + 2]! * dz;
      proj[i] = d;
      if (layout.mapped[i]) { lo = Math.min(lo, d); hi = Math.max(hi, d); }
    }
    if (lo === Infinity) { lo = 0; hi = 1; }
    const span = hi - lo + width * 2;
    return (t, out) => {
      const head = lo - width + ((t / period) % 1) * span;
      for (let i = 0; i < layout.count; i++) {
        const dist = Math.abs(proj[i]! - head) / width; // 0 at centre, 1 at edge
        const core = 1 - soft;
        const f = dist <= core ? 1 : clamp01(1 - (dist - core) / (soft || 1e-6));
        out[i * 3] = lerp(bg[0], fg[0], f); out[i * 3 + 1] = lerp(bg[1], fg[1], f); out[i * 3 + 2] = lerp(bg[2], fg[2], f);
      }
    };
  },
};

const twinkle: EffectDef = {
  id: 'twinkle', category: 'Twinkle & Sparkle', name: 'Twinkle', description: 'Random pixels sparkle and fade.',
  params: [
    { key: 'color', label: 'Colour', type: 'color', default: '#fff4d6' },
    { key: 'background', label: 'Background', type: 'color', default: '#000000' },
    { key: 'density', label: 'Density', type: 'number', min: 0, max: 1, step: 0.01, default: 0.25 },
    { key: 'speed', label: 'Twinkles/s', type: 'number', min: 0.05, max: 5, step: 0.05, default: 0.6 },
  ],
  create(p, layout) {
    const fg = col(p, 'color'), bg = col(p, 'background');
    const density = num(p, 'density'), speed = num(p, 'speed');
    return (t, out) => {
      for (let i = 0; i < layout.count; i++) {
        const rate = speed * (0.6 + 0.8 * hash(i, 1));
        const x = t * rate + hash(i, 2);
        const cycle = Math.floor(x);
        const phase = x - cycle;
        // Each cycle the pixel decides afresh whether to light, so the pattern never repeats visibly.
        const on = hash(i * 7919 + cycle, 3) < density;
        const f = on ? Math.sin(phase * Math.PI) ** 2 : 0;
        out[i * 3] = lerp(bg[0], fg[0], f); out[i * 3 + 1] = lerp(bg[1], fg[1], f); out[i * 3 + 2] = lerp(bg[2], fg[2], f);
      }
    };
  },
};

const noise: EffectDef = {
  id: 'noise', category: 'Noise & Flow', name: 'Aurora', description: 'Smooth drifting 3D noise blended between two colours.',
  params: [
    { key: 'colorA', label: 'Colour A', type: 'color', default: '#00ff66' },
    { key: 'colorB', label: 'Colour B', type: 'color', default: '#0033ff' },
    { key: 'scale', label: 'Scale', type: 'number', min: 0.1, max: 20, step: 0.1, default: 3 },
    { key: 'speed', label: 'Speed', type: 'number', min: 0, max: 2, step: 0.01, default: 0.15 },
    { key: 'seed', label: 'Seed', type: 'number', min: 0, max: 9999, step: 1, default: 1337 },
  ],
  create(p, layout) {
    const a = col(p, 'colorA'), b = col(p, 'colorB');
    const scale = num(p, 'scale'), speed = num(p, 'speed');
    const fnl = new FastNoiseLite(num(p, 'seed'));
    fnl.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    fnl.SetFrequency(1);
    const n = layout.normalized;
    return (t, out) => {
      const drift = t * speed;
      for (let i = 0; i < layout.count; i++) {
        const v = fnl.GetNoise(n[i * 3]! * scale + drift, n[i * 3 + 1]! * scale, n[i * 3 + 2]! * scale + drift * 0.7);
        const f = clamp01(v * 0.5 + 0.5);
        out[i * 3] = lerp(a[0], b[0], f); out[i * 3 + 1] = lerp(a[1], b[1], f); out[i * 3 + 2] = lerp(a[2], b[2], f);
      }
    };
  },
};

const stripes: EffectDef = {
  id: 'stripes', category: 'Waves & Patterns', name: 'Candy cane', description: 'Moving diagonal stripes of two colours.',
  params: [
    { key: 'colorA', label: 'Colour A', type: 'color', default: '#ff0000' },
    { key: 'colorB', label: 'Colour B', type: 'color', default: '#ffffff' },
    { key: 'direction', label: 'Direction', type: 'vec3', default: [1, 1, 0] },
    { key: 'count', label: 'Stripes across house', type: 'number', min: 1, max: 100, step: 1, default: 12 },
    { key: 'speed', label: 'Speed', type: 'number', min: -5, max: 5, step: 0.05, default: 0.5 },
    { key: 'softness', label: 'Softness', type: 'number', min: 0, max: 1, step: 0.01, default: 0.1 },
  ],
  create(p, layout) {
    const a = col(p, 'colorA'), b = col(p, 'colorB');
    const [dx, dy, dz] = vec(p, 'direction');
    const count = num(p, 'count'), speed = num(p, 'speed'), soft = num(p, 'softness');
    const n = layout.normalized;
    return (t, out) => {
      for (let i = 0; i < layout.count; i++) {
        const d = (n[i * 3]! * dx + n[i * 3 + 1]! * dy + n[i * 3 + 2]! * dz) * count - t * speed;
        const ph = d - Math.floor(d); // 0..1
        const tri = Math.abs(ph * 2 - 1); // 1 at edges, 0 mid
        const f = soft === 0 ? (ph < 0.5 ? 1 : 0) : clamp01((tri - 0.5) / soft + 0.5);
        out[i * 3] = lerp(b[0], a[0], f); out[i * 3 + 1] = lerp(b[1], a[1], f); out[i * 3 + 2] = lerp(b[2], a[2], f);
      }
    };
  },
};

const ripple: EffectDef = {
  id: 'ripple', category: 'Waves & Patterns', name: 'Ripple', description: 'Rings expand outward from a point.',
  params: [
    { key: 'color', label: 'Colour', type: 'color', default: '#3fa9ff' },
    { key: 'background', label: 'Background', type: 'color', default: '#000000' },
    { key: 'center', label: 'Centre (0..1)', type: 'vec3', default: [0.5, 0.3, 0] },
    { key: 'wavelength', label: 'Ring spacing', type: 'number', min: 0.02, max: 1, step: 0.01, default: 0.2 },
    { key: 'speed', label: 'Speed', type: 'number', min: -2, max: 2, step: 0.01, default: 0.3 },
  ],
  create(p, layout) {
    const fg = col(p, 'color'), bg = col(p, 'background');
    const [cx, cy, cz] = p.center as number[];
    const wl = num(p, 'wavelength'), speed = num(p, 'speed');
    const n = layout.normalized;
    return (t, out) => {
      for (let i = 0; i < layout.count; i++) {
        const d = Math.hypot(n[i * 3]! - cx!, n[i * 3 + 1]! - cy!, n[i * 3 + 2]! - cz!);
        const f = (Math.cos(((d - t * speed) / wl) * Math.PI * 2) * 0.5 + 0.5) ** 3;
        out[i * 3] = lerp(bg[0], fg[0], f); out[i * 3 + 1] = lerp(bg[1], fg[1], f); out[i * 3 + 2] = lerp(bg[2], fg[2], f);
      }
    };
  },
};

export const EFFECTS: Record<string, EffectDef> = Object.fromEntries(
  [solid, rainbow, sweep, twinkle, noise, stripes, ripple, ...WLED_EFFECTS].map((e) => [e.id, e]),
);
