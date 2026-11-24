// Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/colors.cpp, wled00/colors.h and wled00/src/dependencies/fastled_slim (FastLED-derived parts are MIT licensed, see that LICENSE.txt). Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.
//
// Colours are WLED's uint32 0xWWRRGGBB, always kept unsigned (`>>> 0`). CRGB values are the same
// uint32 with W = 0, so CRGB(c) and CRGBW(c) are just numbers here. The white channel is carried through
// the maths like WLED does but ignored on output.

import { qadd8, qsub8, scale8 } from './math.js';

export const RGBW32 = (r: number, g: number, b: number, w = 0): number =>
  (((w & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) >>> 0;
export const R = (c: number): number => (c >>> 16) & 0xff;
export const G = (c: number): number => (c >>> 8) & 0xff;
export const B = (c: number): number => c & 0xff;
export const W = (c: number): number => (c >>> 24) & 0xff;
/** CRGB(r, g, b) as a colour value (W = 0). */
export const CRGB = (r: number, g: number, b: number): number => RGBW32(r, g, b, 0);
/** Strip the white channel (what assigning a uint32 to a CRGB does). */
export const toCRGB = (c: number): number => (c & 0xffffff) >>> 0;

export const BLACK = 0x000000, WHITE = 0xffffff, RED = 0xff0000, GREEN = 0x00ff00, BLUE = 0x0000ff;
export const YELLOW = 0xffff00, CYAN = 0x00ffff, MAGENTA = 0xff00ff, PURPLE = 0x400080, ORANGE = 0xff3000;
export const PINK = 0xff1493, GREY = 0x808080, GRAY = GREY, DARKGREY = 0x333333, DARKGRAY = DARKGREY;
export const ULTRAWHITE = 0xffffffff, DARKSLATEGRAY = 0x2f4f4f, DARKSLATEGREY = DARKSLATEGRAY;

const MASK = 0x00ff00ff;

/** result = (c1*(256-blend) + c2 + c2*blend) / 256 per channel, with WLED's packed two-channel arithmetic. */
export function color_blend(color1: number, color2: number, blend: number): number {
  blend &= 0xff;
  const rb1 = color1 & MASK, wg1 = (color1 >>> 8) & MASK;
  const rb2 = color2 & MASK, wg2 = (color2 >>> 8) & MASK;
  // exact in doubles, then wrapped to uint32 exactly as the C uint32 arithmetic does
  const rb3 = ((((rb1 * 256 + rb2 + rb2 * blend - rb1 * blend) >>> 0) >>> 8) & MASK) >>> 0;
  const wg3 = (((wg1 * 256 + wg2 + wg2 * blend - wg1 * blend) >>> 0) & ~MASK) >>> 0;
  return (rb3 | wg3) >>> 0;
}
export const color_blend16 = (c1: number, c2: number, b: number): number => color_blend(c1, c2, (b & 0xffff) >> 8);

/** Adds two colours; preserveCR keeps the colour ratio on overflow instead of clipping each channel. */
export function color_add(c1: number, c2: number, preserveCR = false): number {
  c1 >>>= 0; c2 >>>= 0;
  if (c1 === 0) return c2;
  if (c2 === 0) return c1;
  let rb = (c1 & MASK) + (c2 & MASK);
  let wg = ((c1 >>> 8) & MASK) + ((c2 >>> 8) & MASK);
  if (preserveCR) {
    const overflow = (rb | wg) & 0x01000100;
    if (overflow) {
      const r = rb >>> 16, b = rb & 0xffff, w = wg >>> 16, g = wg & 0xffff;
      let maxval = r > g ? (r > b ? r : b) : g > b ? g : b;
      maxval = w > maxval ? w : maxval;
      const scale = Math.floor((255 << 8) / maxval);
      rb = (((rb * scale) >>> 0) >>> 8) & MASK;
      wg = ((wg * scale) >>> 0) & ~MASK;
    } else wg = (wg << 8) >>> 0;
  } else {
    rb |= ((rb & 0x01000100) - ((rb >>> 8) & 0x00010001)) & MASK;
    wg |= ((wg & 0x01000100) - ((wg >>> 8) & 0x00010001)) & MASK;
    wg = (wg << 8) >>> 0;
  }
  return (rb | wg) >>> 0;
}

/** Fades a colour towards black; "video" keeps non-zero channels from dropping to zero. */
export function color_fade(c1: number, amount: number, video = false): number {
  c1 >>>= 0; amount &= 0xff;
  if (c1 === 0 || amount === 0) return 0;
  if (amount === 255) return c1;
  const rb = c1 & MASK, wg = (c1 >>> 8) & MASK;
  let rbS: number, wgS: number;
  if (video) {
    rbS = ((rb * amount + 0x007f007f) >>> 8) & MASK;
    wgS = ((wg * amount + 0x007f007f) & ~MASK) >>> 0;
    const r = (rb >>> 16) & 0xff, g = wg & 0xff, b = rb & 0xff, w = (wg >>> 16) & 0xff;
    let maxc = r > g ? (r > b ? r : b) : g > b ? g : b;
    maxc = ((maxc >> 2) + 1) & 0xff;
    rbS |= r > maxc ? 0x00010000 : 0;
    wgS |= g > maxc ? 0x00000100 : 0;
    rbS |= b > maxc ? 0x00000001 : 0;
    wgS |= w ? 0x01000000 : 0;
  } else {
    rbS = ((rb * (amount + 1)) >>> 8) & MASK;
    wgS = ((wg * (amount + 1)) & ~MASK) >>> 0;
  }
  return (rbS | wgS) >>> 0;
}

/** colors.h fast_color_scale: color*scale/256 on all four channels. */
export function fast_color_scale(c: number, scale: number): number {
  scale &= 0xff;
  const rb = ((((c & MASK) * scale) >>> 8) & MASK) >>> 0;
  const wg = (((((c >>> 8) & MASK) * scale) >>> 0) & ~MASK) >>> 0;
  return (rb | wg) >>> 0;
}

// ---- CRGB operators (fastled_slim.h) on packed colours -------------------------------------------

/** CRGB + CRGB (saturating per channel). */
export const crgbAdd = (a: number, b: number): number => CRGB(qadd8(R(a), R(b)), qadd8(G(a), G(b)), qadd8(B(a), B(b)));
/** CRGB - CRGB (saturating per channel). */
export const crgbSub = (a: number, b: number): number => CRGB(qsub8(R(a), R(b)), qsub8(G(a), G(b)), qsub8(B(a), B(b)));
/** CRGB.nscale8(s): scale to (s+1)/256, can reach black. */
export const nscale8 = (c: number, s: number): number => {
  const k = (s & 0xff) + 1;
  return CRGB((R(c) * k) >> 8, (G(c) * k) >> 8, (B(c) * k) >> 8);
};
/** CRGB.nscale8_video(s): never scales a lit channel to zero. */
export const nscale8_video = (c: number, s: number): number => {
  s &= 0xff;
  const nz = s ? 1 : 0;
  const ch = (v: number) => (v === 0 ? 0 : ((v * s) >> 8) + nz);
  return CRGB(ch(R(c)), ch(G(c)), ch(B(c)));
};
/** CRGB.fadeToBlackBy(f). */
export const crgbFadeToBlackBy = (c: number, f: number): number => {
  const k = 256 - (f & 0xff);
  return CRGB((R(c) * k) >> 8, (G(c) * k) >> 8, (B(c) * k) >> 8);
};
/** CRGB.scale8(CRGB): per-channel scale8. */
export const crgbScale8 = (c: number, s: number): number => CRGB(scale8(R(c), R(s)), scale8(G(c), G(s)), scale8(B(c), B(s)));

// ---- HSV --------------------------------------------------------------------------------------

/** FastLED "rainbow" HSV → RGB with a 16-bit hue (fastled_slim.cpp hsv2rgb_rainbow). Returns 0x00RRGGBB. */
export function hsv2rgb_rainbow(h: number, s: number, v: number): number {
  h &= 0xffff; s &= 0xff; v &= 0xff;
  const hue = h >> 8;
  const offset = h & 0x1fff;
  const third16 = offset * 21846;
  const third = (third16 >>> 21) & 0xff;
  let r: number, g: number, b: number;
  if (!(hue & 0x80)) {
    if (!(hue & 0x40)) {
      if (!(hue & 0x20)) { r = 255 - third; g = third; b = 0; } else { r = 171; g = 85 + third; b = 0; }
    } else if (!(hue & 0x20)) { const twothirds = (third16 >>> 20) & 0xff; r = 171 - twothirds; g = 170 + third; b = 0; }
    else { r = 0; g = 255 - third; b = third; }
  } else if (!(hue & 0x40)) {
    if (!(hue & 0x20)) { r = 0; const twothirds = (third16 >>> 20) & 0xff; g = 171 - twothirds; b = 85 + twothirds; }
    else { r = third; g = 0; b = 255 - third; }
  } else if (!(hue & 0x20)) { r = 85 + third; g = 0; b = 171 - third; }
  else { r = 170 + third; g = 0; b = 85 - third; }
  r &= 0xff; g &= 0xff; b &= 0xff;
  if (s !== 255) {
    if (s === 0) { r = 255; g = 255; b = 255; } else {
      let desat = 255 - s;
      desat = desat * desat;
      const floor = desat >> 8;
      const satscale = 0xffff - desat;
      if (r) r = (r * satscale) >>> 16;
      if (g) g = (g * satscale) >>> 16;
      if (b) b = (b * satscale) >>> 16;
      r = (r + floor) & 0xff; g = (g + floor) & 0xff; b = (b + floor) & 0xff;
    }
  }
  if (v !== 255) {
    if (v === 0) { r = 0; g = 0; b = 0; } else {
      const val = v * v + 512;
      if (r) r = (((r * val) >>> 16) + 1) & 0xff;
      if (g) g = (((g * val) >>> 16) + 1) & 0xff;
      if (b) b = (((b * val) >>> 16) + 1) & 0xff;
    }
  }
  return RGBW32(r, g, b, 0);
}

/** CHSV32(h16, s, v) → colour, the way CRGBW(CHSV32) converts (rainbow method). */
export const CHSV32 = (h16: number, s: number, v: number): number => hsv2rgb_rainbow(h16, s, v);
/** CHSV(h8, s, v) → colour (rainbow method, hue << 8), as CRGB(CHSV) / CRGBW(CHSV) do. */
export const CHSV = (h: number, s: number, v: number): number => hsv2rgb_rainbow((h & 0xff) << 8, s, v);
/** Explicit hsv2rgb(CHSV32) from colors.h (rainbow method). */
export const hsv2rgb = CHSV32;

/** hsv2rgb_spectrum(CHSV32, CRGBW&): returns the colour; keeps `w` (CRGBW conversion keeps the target's white). */
export function hsv2rgb_spectrum(h: number, s: number, v: number, w = 0): number {
  h &= 0xffff; s &= 0xff; v &= 0xff;
  const region = (h * 6) >>> 16;
  const remainder = ((h - region * 10923) * 6) >>> 0; // unsigned in C
  if (s === 0) return RGBW32(v, v, v, w);
  const p = (v * (255 - s)) >>> 8;
  const q = (v * (255 - ((s * remainder) >>> 16))) >>> 8;
  const t = (v * (255 - ((s * (65535 - remainder)) >>> 16))) >>> 8;
  switch (region) {
    case 0: return RGBW32(v, t, p, w);
    case 1: return RGBW32(q, v, p, w);
    case 2: return RGBW32(p, v, t, w);
    case 3: return RGBW32(p, q, v, w);
    case 4: return RGBW32(t, p, v, w);
    default: return RGBW32(v, p, q, w);
  }
}

/** rgb2hsv(CRGBW, CHSV32&): returns { h: uint16, s, v }. */
export interface HSV32 { h: number; s: number; v: number }
export function rgb2hsv(c: number, out: HSV32 = { h: 0, s: 0, v: 0 }): HSV32 {
  const r = R(c), g = G(c), b = B(c);
  const maxval = r > g ? (r > b ? r : b) : g > b ? g : b;
  if (maxval === 0) { out.h = 0; out.s = 0; out.v = 0; return out; }
  const minval = r < g ? (r < b ? r : b) : g < b ? g : b;
  out.v = maxval;
  const delta = maxval - minval;
  if (delta !== 0) {
    out.s = Math.trunc((255 * delta) / maxval) & 0xff;
    if (maxval === r) out.h = Math.trunc((10923 * (g - b)) / delta) & 0xffff;
    else if (maxval === g) out.h = (21845 + Math.trunc((10923 * (b - r)) / delta)) & 0xffff;
    else out.h = (43690 + Math.trunc((10923 * (r - g)) / delta)) & 0xffff;
  } else { out.s = 0; out.h = 0; }
  return out;
}

/** adjust_color: shift hue (256 = full turn), saturation and value; white is kept. */
export function adjust_color(c: number, hueShift: number, satChange: number, valueChange: number): number {
  if (c >>> 0 === 0 && valueChange <= 0) return 0;
  const hsv = rgb2hsv(c);
  const h = (hsv.h + (hueShift << 8)) & 0xffff;
  const s = constrain255(hsv.s + satChange), v = constrain255(hsv.v + valueChange);
  return hsv2rgb_spectrum(h, s, v, W(c));
}
const constrain255 = (x: number): number => (x < 0 ? 0 : x > 255 ? 255 : x);

/** CRGBW.adjust_hue: input range 256 per turn, may be negative. */
export function adjust_hue(c: number, hueshift: number): number {
  const hsv = rgb2hsv(c);
  return hsv2rgb_spectrum((hsv.h + (hueshift << 8)) & 0xffff, hsv.s, hsv.v, W(c));
}

/** colorHStoRGB(hue16, sat) → colour at full value (spectrum method). */
export const colorHStoRGB = (hue: number, sat: number): number => hsv2rgb_spectrum(hue, sat, 255) & 0xffffff;

/** FastLED HeatColor (black-body ramp). */
export function HeatColor(temperature: number): number {
  temperature &= 0xff;
  const t192 = (((temperature * 191) >> 8) + (temperature ? 1 : 0)) & 0xff;
  const heatramp = ((t192 & 0x3f) << 2) & 0xff;
  if (t192 & 0x80) return CRGB(255, 255, heatramp);
  if (t192 & 0x40) return CRGB(255, heatramp, 0);
  return CRGB(heatramp, 0, 0);
}

/** CRGB.getAverageLight / CRGBW.getRGBaverage: (r+g+b)/3. */
export const getRGBaverage = (c: number): number => ((R(c) + G(c) + B(c)) * 21846) >>> 16;
/** CRGBW.getAverageLight: (r+g+b+w)/4. */
export const getAverageLight = (c: number): number => (R(c) + G(c) + B(c) + W(c)) >> 2;

// ---- Gamma (colors.cpp NeoGammaWLEDMethod), WLED default gamma 2.2 -------------------------------

const GAMMA = 2.2;
const gammaT = new Uint8Array(256), gammaTinv = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  const fr = Math.fround;
  gammaT[i] = Math.trunc(fr(fr(Math.pow(fr(i / 255), GAMMA)) * 255 + 0.5));
  gammaTinv[i] = Math.trunc(fr(fr(Math.pow(fr((i - 0.5) / 255), fr(1 / GAMMA))) * 255 + 0.5));
}
gammaT[0] = 0; gammaTinv[0] = 0;
/** gamma8(v): the controller's gamma table (2.2). Our engine applies output gamma itself, so effects only use this when the C code calls it. */
export const gamma8 = (v: number): number => gammaT[v & 0xff]!;
export const gamma8inv = (v: number): number => gammaTinv[v & 0xff]!;
export const gamma32 = (c: number): number => RGBW32(gammaT[R(c)]!, gammaT[G(c)]!, gammaT[B(c)]!, gammaT[W(c)]!);
export const gamma32inv = (c: number): number => RGBW32(gammaTinv[R(c)]!, gammaTinv[G(c)]!, gammaTinv[B(c)]!, gammaTinv[W(c)]!);
