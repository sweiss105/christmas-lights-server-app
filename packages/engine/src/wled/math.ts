// Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/wled_math.cpp, wled00/util.cpp, wled00/fcn_declare.h, wled00/prng.h and wled00/src/dependencies/fastled_slim (FastLED-derived parts are MIT licensed, see that LICENSE.txt). Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.
//
// Integer maths used by WLED effects. Every function reproduces the C integer widths: arguments are
// truncated to the C parameter type on entry (uint8 `& 0xff`, uint16 `& 0xffff`, uint32 `>>> 0`) and
// results to the C return type. Products that can exceed 2^53 are split; uint32 products that wrap in C
// use Math.imul.

import type { Random } from '../fx/random.js';

// ---------------------------------------------------------------------------------------------
// Runtime hooks: the effect runner sets the clock and the random source before each frame.
// (WLED reads millis() and a hardware RNG register; we read these so frames are deterministic.)
// ---------------------------------------------------------------------------------------------

let nowMs = 0;
let rnd: Random = () => 0;

/** Set by the runner: current effect time in ms (uint32, wraps like millis()). */
export function setMillis(ms: number): void { nowMs = ms >>> 0; }
/** millis() as seen by effects (same value as strip.now). */
export function millis(): number { return nowMs; }
/** Set by the runner: the seeded random source (0..1, 32 bits of entropy). Never Math.random. */
export function setRandomSource(r: Random): void { rnd = r; }

// ---------------------------------------------------------------------------------------------
// C helpers
// ---------------------------------------------------------------------------------------------

/** Arduino map() (ESP32 core): long arithmetic with truncating division; returns -1 for an empty input range. */
export function map(x: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  const run = inMax - inMin;
  if (run === 0) return -1;
  return Math.trunc(((x - inMin) * (outMax - outMin)) / run) + outMin;
}
export function constrain(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }
/** WLED's mapf(): float version of map(). */
export function mapf(x: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return ((x - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
}
/** C integer division (truncates towards zero). */
export const idiv = (a: number, b: number): number => Math.trunc(a / b);
/** Floor of (a*b) / 2^32 for uint32 a, b (the high word of a 64-bit product), exact. */
export function mulhi32(a: number, b: number): number {
  a >>>= 0; b >>>= 0;
  const hi = (a >>> 16) * b, lo = (a & 0xffff) * b;
  return Math.floor((hi + Math.floor(lo / 65536)) / 65536) >>> 0;
}

// ---------------------------------------------------------------------------------------------
// FastLED-style scaling and saturating arithmetic (fastled_slim.h)
// ---------------------------------------------------------------------------------------------

export const scale8 = (i: number, scale: number): number => ((i & 0xff) * (1 + (scale & 0xff))) >> 8;
export const scale8_video = (i: number, scale: number): number => {
  i &= 0xff; scale &= 0xff;
  return ((i * scale) >> 8) + (i && scale ? 1 : 0);
};
export const scale16 = (i: number, scale: number): number => Math.floor(((i & 0xffff) * (1 + (scale & 0xffff))) / 65536);
export const qadd8 = (i: number, j: number): number => { const t = (i & 0xff) + (j & 0xff); return t > 255 ? 255 : t; };
export const qsub8 = (i: number, j: number): number => { const t = (i & 0xff) - (j & 0xff); return t < 0 ? 0 : t; };
export const qmul8 = (i: number, j: number): number => { const p = (i & 0xff) * (j & 0xff); return p > 255 ? 255 : p; };
/** int8 abs (abs8(-128) is -128 in C). */
export const abs8 = (i: number): number => { i = (i << 24) >> 24; return ((i < 0 ? -i : i) << 24) >> 24; };
/** Returns int8 as in fastled_slim (sic). */
export const lerp8by8 = (a: number, b: number, frac: number): number =>
  ((((a & 0xff) + ((((b & 0xff) - (a & 0xff)) * ((frac & 0xff) + 1)) >> 8)) << 24) >> 24);

export function ease8InOutCubic(i: number): number {
  i &= 0xff;
  const ii = i * i;
  const factor = (3 << 8) - (i << 1);
  return ((ii * factor) >>> 16) & 0xff;
}
export function ease16InOutCubic(i: number): number {
  i &= 0xffff;
  const ii = Math.floor((i * i) / 65536);
  const factor = (3 << 16) - (i << 1);
  return Math.floor((ii * factor) / 65536) & 0xffff;
}
export function ease8InOutQuad(i: number): number {
  i &= 0xff;
  let j = i;
  if (j & 0x80) j = 255 - j;
  const jj = (j * j) >> 7;
  return (i & 0x80 ? 255 - jj : jj) & 0xff;
}
export function triwave8(i: number): number {
  i &= 0xff;
  if (i & 0x80) i = 255 - i;
  return (i << 1) & 0xff;
}
export function triwave16(i: number): number {
  i &= 0xffff;
  if (i < 0x8000) return (i * 2) & 0xffff;
  return (0xffff - (i - 0x8000) * 2) & 0xffff;
}
export const quadwave8 = (i: number): number => ease8InOutQuad(triwave8(i));
export const cubicwave8 = (i: number): number => ease8InOutCubic(triwave8(i));

// ---------------------------------------------------------------------------------------------
// Trigonometry (wled_math.cpp)
// ---------------------------------------------------------------------------------------------

/** Bhaskara I sine: uint16 angle (65536 = 2π) → int16 (-32767..32767). */
export function sin16_t(theta: number): number {
  theta &= 0xffff;
  let scale = 1;
  if (theta > 0x7fff) { theta = 0xffff - theta; scale = -1; }
  const precal = theta * (0x7fff - theta);
  const numerator = precal * (4 * 0x7fff); // < 2^53, exact
  const denominator = 1342095361 - precal;
  const result = Math.trunc(numerator / denominator);
  return ((result * scale) << 16) >> 16;
}
export const cos16_t = (theta: number): number => sin16_t((theta & 0xffff) + 0x4000);
export function sin8_t(theta: number): number {
  let s = sin16_t((theta & 0xff) * 257);
  s += 0x7fff + 128;
  return (s < 0xffff ? s : 0xffff) >> 8;
}
export const cos8_t = (theta: number): number => sin8_t((theta & 0xff) + 64);

const f = Math.fround;
const TWO_PI_SCALE = f(0xffff / (2 * Math.PI));
/** sin_t / sin_approx: float wrapper over sin16_t. */
export function sin_t(theta: number): number {
  const scaled = Math.trunc(f(f(theta) * TWO_PI_SCALE)) & 0xffff;
  return f(sin16_t(scaled) / 0x7fff);
}
export function cos_t(theta: number): number {
  const scaled = Math.trunc(f(f(theta) * TWO_PI_SCALE)) & 0xffff;
  return f(sin16_t(scaled + 0x4000) / 0x7fff);
}
export const sin_approx = sin_t;
export const cos_approx = cos_t;
export function tan_t(x: number): number { const c = cos_t(x); if (c === 0) return 0; return f(sin_t(x) / c); }

export function atan2_t(y: number, x: number): number {
  const ay = Math.abs(y), ax = Math.abs(x);
  let r = f(f(ax - ay) / f(ay + ax + 1e-10));
  let angle: number;
  if (x < 0) { r = -r; angle = Math.PI / 2 + Math.PI / 4; } else angle = Math.PI / 2 - Math.PI / 4;
  const add = f(f(f(0.1963 * f(r * r)) - 0.9817) * r);
  angle = f(angle + add);
  return y < 0 ? -angle : angle;
}
export function acos_t(x: number): number {
  const negate = x < 0 ? 1 : 0;
  const xabs = Math.abs(x);
  let ret = -0.0187293;
  ret = ret * xabs + 0.074261;
  ret = ret * xabs - 0.2121144;
  ret = ret * xabs + Math.PI / 2;
  ret = ret * Math.sqrt(1 - xabs);
  ret = ret - 2 * negate * ret;
  return f(negate * Math.PI + ret);
}
export const asin_t = (x: number): number => f(Math.PI / 2 - acos_t(x));
export function atan_t(x: number): number {
  const A = 0.0776509570923569, B = -0.287434475393028, C = Math.PI / 4 - A - B;
  const neg = x < 0;
  x = Math.abs(x);
  let res: number;
  if (x > 5) res = Math.PI / 2 - 1 / x;
  else if (x > 1) { const xx = x * x; res = -0.003445 * xx * xx + 0.05375 * xx * x - 0.326175 * xx + 0.974207 * x + 0.089494; }
  else { const xx = x * x; res = ((A * xx + B) * xx + C) * x; }
  return f(neg ? -res : res);
}
export function floor_t(x: number): number { let v = Math.trunc(x); if (x < 0) v--; return v; }
export function fmod_t(num: number, denom: number): number { const q = Math.trunc(num / denom); return f(num - q * denom); }

/** Exact integer square root of a uint32. */
export function sqrt32_bw(x: number): number {
  let num = x >>> 0;
  let res = 0;
  let bit: number;
  if (num < 1 << 10) bit = 1 << 10;
  else if (num < 1 << 20) bit = 1 << 20;
  else bit = 1 << 30;
  while (bit > num) bit = bit >>> 2;
  while (bit !== 0) {
    if (num >= res + bit) { num -= res + bit; res = (res >>> 1) + bit; } else res >>>= 1;
    bit >>>= 2;
  }
  return res >>> 0;
}

// ---------------------------------------------------------------------------------------------
// Beat generators (util.cpp, FastLED-derived). They read millis(), i.e. the effect clock.
// ---------------------------------------------------------------------------------------------

/** 16-bit sawtooth at BPM in Q8.8. All arithmetic is uint32 and wraps, as in C. */
export function beat88(bpm88: number, timebase = 0): number {
  const dt = (millis() - timebase) >>> 0;
  return (Math.imul(Math.imul(dt, bpm88 & 0xffff), 280) >>> 16) & 0xffff;
}
export function beat16(bpm: number, timebase = 0): number {
  bpm &= 0xffff;
  if (bpm < 256) bpm = (bpm << 8) & 0xffff;
  return beat88(bpm, timebase);
}
export const beat8 = (bpm: number, timebase = 0): number => beat16(bpm, timebase) >> 8;

export function beatsin88_t(bpm88: number, lowest = 0, highest = 65535, timebase = 0, phaseOffset = 0): number {
  const beat = beat88(bpm88, timebase);
  const beatsin = (sin16_t(beat + (phaseOffset & 0xffff)) + 32768) & 0xffff;
  const rangewidth = (highest - lowest) & 0xffff;
  return ((lowest & 0xffff) + scale16(beatsin, rangewidth)) & 0xffff;
}
export function beatsin16_t(bpm: number, lowest = 0, highest = 65535, timebase = 0, phaseOffset = 0): number {
  const beat = beat16(bpm, timebase);
  const beatsin = (sin16_t(beat + (phaseOffset & 0xffff)) + 32768) & 0xffff;
  const rangewidth = (highest - lowest) & 0xffff;
  return ((lowest & 0xffff) + scale16(beatsin, rangewidth)) & 0xffff;
}
export function beatsin8_t(bpm: number, lowest = 0, highest = 255, timebase = 0, phaseOffset = 0): number {
  const beat = beat8(bpm, timebase);
  const beatsin = sin8_t(beat + (phaseOffset & 0xff));
  const rangewidth = (highest - lowest) & 0xff;
  return ((lowest & 0xff) + scale8(beatsin, rangewidth)) & 0xff;
}

// ---------------------------------------------------------------------------------------------
// Random numbers (fcn_declare.h / util.cpp). hw_random* read the runner's seeded source.
// ---------------------------------------------------------------------------------------------

/** One 32-bit draw from the seeded source (HW_RND_REGISTER). */
const draw32 = (): number => Math.floor(rnd() * 4294967296) >>> 0;

/**
 * hw_random() → uint32; hw_random(upper) → 0..upper-1; hw_random(lo, hi) → lo..hi-1 (returns lo if lo >= hi).
 */
export function hw_random(a?: number, b?: number): number {
  if (a === undefined) return draw32();
  if (b === undefined) return mulhi32(draw32(), a);
  const lo = a | 0, hi = b | 0;
  if (lo >= hi) return lo;
  return (mulhi32(draw32(), (hi - lo) >>> 0) + lo) | 0;
}
/** hw_random16() → uint16; (upper) → (r16*upper)>>16; (lo, hi) → int16 lo + hw_random16(hi-lo). */
export function hw_random16(a?: number, b?: number): number {
  const r = draw32() & 0xffff;
  if (a === undefined) return r;
  if (b === undefined) return (((r * (a >>> 0)) >>> 0) >>> 16) & 0xffff;
  const range = ((b | 0) - (a | 0)) | 0;
  return ((((a | 0) + ((((r * (range >>> 0)) >>> 0) >>> 16) & 0xffff)) << 16) >> 16);
}
/** hw_random8() → uint8; (upper) → (r8*upper)>>8; (lo, hi) → lo + hw_random8(hi-lo), uint8. */
export function hw_random8(a?: number, b?: number): number {
  const r = draw32() & 0xff;
  if (a === undefined) return r;
  if (b === undefined) return (((r * (a >>> 0)) >>> 0) >>> 8) & 0xff;
  const range = ((b >>> 0) - (a >>> 0)) >>> 0;
  return ((a >>> 0) + ((((r * range) >>> 0) >>> 8) & 0xff)) & 0xff;
}
/** Arduino random() is #defined to hw_random in WLED. */
export const random = hw_random;
/** FastLED-style names, mapped like WLED maps them. */
export const random8 = hw_random8;
export const random16 = hw_random16;

/** prng.h: WLED's small seeded 16-bit PRNG (used where effects need repeatable sequences). */
export class PRNG {
  constructor(private seed = 0x1234) { this.seed &= 0xffff; }
  setSeed(s: number): void { this.seed = s & 0xffff; }
  getSeed(): number { return this.seed; }
  random16(min?: number, lim?: number): number {
    if (min === undefined) {
      let s = (Math.imul(this.seed, 3001) + 31683) & 0xffff;
      s ^= s >> 7;
      this.seed = s & 0xffff;
      return this.seed;
    }
    if (lim === undefined) return ((this.random16() * (min & 0xffff)) >>> 16) & 0xffff;
    const delta = ((lim & 0xffff) - (min & 0xffff)) & 0xffff;
    return (this.random16(delta) + (min & 0xffff)) & 0xffff;
  }
  random8(min?: number, lim?: number): number {
    if (min === undefined) return this.random16() & 0xff;
    if (lim === undefined) return ((this.random8() * (min & 0xff)) >> 8) & 0xff;
    const delta = ((lim & 0xff) - (min & 0xff)) & 0xff;
    return (this.random8(delta) + (min & 0xff)) & 0xff;
  }
}

export function hashInt(s: number): number {
  s >>>= 0;
  s = Math.imul((s >>> 16) ^ s, 0x45d9f3b) >>> 0;
  s = Math.imul((s >>> 16) ^ s, 0x45d9f3b) >>> 0;
  return ((s >>> 16) ^ s) >>> 0;
}

/** A random wheel index at least 42 away from pos. */
export function get_random_wheel_index(pos: number): number {
  let r = 0, d = 0;
  pos &= 0xff;
  while (d < 42) {
    r = hw_random8();
    const x = Math.abs(pos - r) & 0xff;
    const y = (255 - x) & 0xff;
    d = Math.min(x, y);
  }
  return r;
}

// ---------------------------------------------------------------------------------------------
// Perlin noise (util.cpp, fixed point, by @dedehai)
// ---------------------------------------------------------------------------------------------

const hashToGradient = (h: number): number => (h & 0x03) - 2;

function gradient1D(x0: number, dx: number): number {
  let h = Math.imul(x0, 0x27d4eb2d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x92c3412b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h ^ (h >>> 7)) >>> 0;
  return (hashToGradient(h) * dx) >> 1;
}
function gradient2D(x0: number, dx: number, y0: number, dy: number): number {
  let h = (Math.imul(x0, 0x27d4eb2d) ^ Math.imul(y0, 0xb5297a4d)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x92c3412b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return (hashToGradient(h) * dx + hashToGradient(h >>> 1) * dy) >> 2;
}
function gradient3D(x0: number, dx: number, y0: number, dy: number, z0: number, dz: number): number {
  let h = (Math.imul(x0, 0x27d4eb2d) ^ Math.imul(y0, 0xb5297a4d) ^ Math.imul(z0, 0x1b56c4e9)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x92c3412b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  // values stay well inside int32, so `| 0` and `>>` match C
  return ((hashToGradient(h) * dx + hashToGradient(h >>> 2) * dy + hashToGradient(h >>> 3) * dz) * 85) >> 9;
}
function smoothstep(t: number): number {
  const tSquared = Math.floor((t * t) / 65536); // t <= 0xffff
  const factor = (3 << 16) - (t << 1);
  return Math.floor((tSquared * factor) / 262144); // >> 18 (product < 2^34, exact)
}
/** a + (((b - a) * t) >> 14) with int32 wrap of the product, as in C. */
const lerpPerlin = (a: number, b: number, t: number): number => (a + (Math.imul(b - a, t) >> 14)) | 0;

export function perlin1D_raw(x: number, is16bit = false): number {
  x >>>= 0;
  const x0 = x >>> 16;
  let x1 = x0 + 1;
  if (is16bit) x1 &= 0xff;
  const dx0 = x & 0xffff, dx1 = dx0 - 0x10000;
  const g0 = gradient1D(x0, dx0), g1 = gradient1D(x1, dx1);
  return lerpPerlin(g0, g1, smoothstep(dx0));
}
export function perlin2D_raw(x: number, y: number, is16bit = false): number {
  x >>>= 0; y >>>= 0;
  const x0 = x >>> 16, y0 = y >>> 16;
  let x1 = x0 + 1, y1 = y0 + 1;
  if (is16bit) { x1 &= 0xff; y1 &= 0xff; }
  const dx0 = x & 0xffff, dy0 = y & 0xffff, dx1 = dx0 - 0x10000, dy1 = dy0 - 0x10000;
  const g00 = gradient2D(x0, dx0, y0, dy0), g10 = gradient2D(x1, dx1, y0, dy0);
  const g01 = gradient2D(x0, dx0, y1, dy1), g11 = gradient2D(x1, dx1, y1, dy1);
  const tx = smoothstep(dx0), ty = smoothstep(dy0);
  return lerpPerlin(lerpPerlin(g00, g10, tx), lerpPerlin(g01, g11, tx), ty);
}
export function perlin3D_raw(x: number, y: number, z: number, is16bit = false): number {
  x >>>= 0; y >>>= 0; z >>>= 0;
  const x0 = x >>> 16, y0 = y >>> 16, z0 = z >>> 16;
  let x1 = x0 + 1, y1 = y0 + 1, z1 = z0 + 1;
  if (is16bit) { x1 &= 0xff; y1 &= 0xff; z1 &= 0xff; }
  const dx0 = x & 0xffff, dy0 = y & 0xffff, dz0 = z & 0xffff;
  const dx1 = dx0 - 0x10000, dy1 = dy0 - 0x10000, dz1 = dz0 - 0x10000;
  const g000 = gradient3D(x0, dx0, y0, dy0, z0, dz0);
  const g001 = gradient3D(x0, dx0, y0, dy0, z1, dz1);
  const g010 = gradient3D(x0, dx0, y1, dy1, z0, dz0);
  const g011 = gradient3D(x0, dx0, y1, dy1, z1, dz1);
  const g100 = gradient3D(x1, dx1, y0, dy0, z0, dz0);
  const g101 = gradient3D(x1, dx1, y0, dy0, z1, dz1);
  const g110 = gradient3D(x1, dx1, y1, dy1, z0, dz0);
  const g111 = gradient3D(x1, dx1, y1, dy1, z1, dz1);
  const tx = smoothstep(dx0), ty = smoothstep(dy0), tz = smoothstep(dz0);
  const nx0 = lerpPerlin(g000, g100, tx), nx1 = lerpPerlin(g010, g110, tx);
  const nx2 = lerpPerlin(g001, g101, tx), nx3 = lerpPerlin(g011, g111, tx);
  return lerpPerlin(lerpPerlin(nx0, nx1, ty), lerpPerlin(nx2, nx3, ty), tz);
}

/** perlin16(x[, y[, z]]): uint32 coordinates (16.16 fixed point) → uint16. */
export function perlin16(x: number, y?: number, z?: number): number {
  if (y === undefined) return (((perlin1D_raw(x) * 1159) >> 10) + 32803) & 0xffff;
  if (z === undefined) return (((perlin2D_raw(x, y) * 1537) >> 10) + 32725) & 0xffff;
  return (((perlin3D_raw(x, y, z) * 1731) >> 10) + 33147) & 0xffff;
}
/** perlin8(x[, y[, z]]): uint16 coordinates (8.8 fixed point) → uint8. */
export function perlin8(x: number, y?: number, z?: number): number {
  if (y === undefined) return ((((perlin1D_raw((x & 0xffff) * 256, true) * 1353) >> 10) + 32769) >> 8) & 0xff;
  if (z === undefined) return ((((perlin2D_raw((x & 0xffff) * 256, (y & 0xffff) * 256, true) * 1620) >> 10) + 32771) >> 8) & 0xff;
  return ((((perlin3D_raw((x & 0xffff) * 256, (y & 0xffff) * 256, (z & 0xffff) * 256, true) * 2015) >> 10) + 33168) >> 8) & 0xff;
}
export const inoise8 = perlin8;
export const inoise16 = perlin16;
