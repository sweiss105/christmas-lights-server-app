// Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/FX.cpp. Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.

import type { EffectDef } from '../../effects.js';
import { B, BLACK, CHSV, color_blend, color_fade, G, gamma32inv, gamma8, gamma8inv, getRGBaverage, R, RGBW32, ULTRAWHITE, W } from '../color.js';
import { wledEffect } from '../define.js';
import {
  beatsin88_t, beatsin8_t, constrain, cos8_t, cubicwave8, hw_random, hw_random16, hw_random8, map, perlin16, perlin8,
  PRNG, qsub8, scale8, sin16_t, sin8_t, triwave16,
} from '../math.js';
import { ColorFromPalette, NOBLEND } from '../palettes.js';
import { FRAMETIME, PALETTE_SOLID_WRAP, SEGCOLOR, SEGENV, SEGLEN, SEGMENT, SEGPALETTE, strip } from '../segment.js';

// Note: in WLED 16, Segment::color_from_palette takes a uint16_t index and ColorFromPalette an
// unsigned one, so indices above 255 are NOT truncated to 8 bits (with LINEARBLEND_NOWRAP the full
// value is rescaled). The runtime reproduces that; don't mask palette indices with `& 0xff`.

const FX_FALLBACK_STATIC = (): void => SEGMENT.fill(SEGCOLOR(0));

/** static PRNG prng(hw_random()) in FX.cpp (only Stream 2 uses it here; it is re-seeded on its first call). */
const prng = new PRNG();

// effect utility functions
function sin_gap(inp: number): number {
  inp &= 0xffff;
  if (inp & 0x100) return 0;
  return sin8_t(inp + 192); // correct phase shift of sine so that it starts and stops at 0
}

/*
 * K.I.T.T.
 */
function mode_larson_scanner(): void {
  if (SEGLEN <= 1) return FX_FALLBACK_STATIC();

  const speed = (FRAMETIME * map(SEGMENT.speed, 0, 255, 96, 2)) >>> 0; // map into useful range
  const pixels = Math.trunc(SEGLEN / speed); // how many pixels to advance per frame

  SEGMENT.fade_out(255 - SEGMENT.intensity);

  if (SEGENV.step > strip.now) return; // we have a pause

  let index = SEGENV.aux1 + pixels;
  // are we slow enough to use frames per pixel?
  if (pixels === 0) {
    const frames = Math.trunc(speed / SEGLEN); // how many frames per 1 pixel
    const s = SEGENV.step;
    SEGENV.step = s + 1;
    if (s < frames) return;
    SEGENV.step = 0;
    index++;
  }

  if (index > SEGLEN) {
    SEGENV.aux0 = SEGENV.aux0 ? 0 : 1; // change direction
    SEGENV.aux1 = 0; // reset position
    // set delay
    if (SEGENV.aux0 || SEGMENT.check2) SEGENV.step = strip.now + SEGMENT.custom1 * 25; // multiply by 25ms
    else SEGENV.step = 0;
  } else {
    // paint as many pixels as needed
    for (let i = SEGENV.aux1; i < index; i++) {
      const j = SEGENV.aux0 ? i : SEGLEN - 1 - i;
      const c = SEGMENT.color_from_palette(j, true, PALETTE_SOLID_WRAP, 0);
      SEGMENT.setPixelColor(j, c);
      if (SEGMENT.check1) {
        SEGMENT.setPixelColor(SEGLEN - 1 - j, SEGCOLOR(2) ? SEGCOLOR(2) : c);
      }
    }
    SEGENV.aux1 = index;
  }
}

/*
 * Creates two Larson scanners moving in opposite directions
 * Custom mode by Keith Lord: https://github.com/kitesurfer1404/WS2812FX/blob/master/src/custom/DualLarson.h
 */
function mode_dual_larson_scanner(): void {
  SEGMENT.check1 = true;
  mode_larson_scanner();
}

/*
 * Firing comets from one end. "Lighthouse"
 */
function mode_comet(): void {
  if (SEGLEN <= 1) return FX_FALLBACK_STATIC();
  const counter = Math.imul(strip.now, (SEGMENT.speed >> 2) + 1) & 0xffff;
  const index = (counter * SEGLEN) >>> 16;
  if (SEGENV.call === 0) SEGENV.aux0 = index;

  SEGMENT.fade_out(SEGMENT.intensity);

  SEGMENT.setPixelColor(index, SEGMENT.color_from_palette(index, true, PALETTE_SOLID_WRAP, 0));
  if (index > SEGENV.aux0) {
    for (let i = SEGENV.aux0; i < index; i++) {
      SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 0));
    }
  } else if (index < SEGENV.aux0 && index < 10) {
    for (let i = 0; i < index; i++) {
      SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 0));
    }
  }
  SEGENV.aux0 = index; // C: index++ (unused afterwards)
}

/*
 * Fire flicker function
 */
function mode_fire_flicker(): void {
  const cycleTime = 40 + (255 - SEGMENT.speed);
  const it = Math.trunc(strip.now / cycleTime) >>> 0;
  if (SEGENV.step === it) return;

  const c0 = SEGCOLOR(0);
  const w = W(c0), r = R(c0), g = G(c0), b = B(c0);
  let lum = SEGMENT.palette === 0 ? Math.max(w, r, g, b) : 255;
  lum = Math.trunc(lum / (Math.trunc((256 - SEGMENT.intensity) / 16) + 1)) & 0xff;
  for (let i = 0; i < SEGLEN; i++) {
    const flicker = hw_random8(lum);
    if (SEGMENT.palette === 0) {
      SEGMENT.setPixelColor(i, RGBW32(Math.max(r - flicker, 0), Math.max(g - flicker, 0), Math.max(b - flicker, 0), Math.max(w - flicker, 0)));
    } else {
      SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 0, 255 - flicker));
    }
  }

  SEGENV.step = it;
}

/*
 * Gradient run base function
 */
function gradient_base(loading: boolean): void {
  if (SEGLEN <= 1) return FX_FALLBACK_STATIC();
  const counter = Math.imul(strip.now, (SEGMENT.speed >> 2) + 1) & 0xffff;
  let pp = ((counter * SEGLEN) >>> 16) & 0xffff;
  if (SEGENV.call === 0) pp = 0;
  let val: number; // 0 = sec 1 = pri
  // C: `int brd = 1 + loading ? SEGMENT.intensity/2 : SEGMENT.intensity/4;` parses as `(1 + loading) ? ...`,
  // which is always true, so brd is always intensity/2 (kept as in WLED)
  const brd = Math.trunc(SEGMENT.intensity / 2);
  const p1 = pp - SEGLEN;
  const p2 = pp + SEGLEN;

  for (let i = 0; i < SEGLEN; i++) {
    if (loading) {
      val = Math.abs((i > pp ? p2 : pp) - i);
    } else {
      val = Math.min(Math.abs(pp - i), Math.min(Math.abs(p1 - i), Math.abs(p2 - i)));
    }
    val = brd > val ? Math.trunc((val * 255) / brd) : 255;
    SEGMENT.setPixelColor(i, color_blend(SEGCOLOR(0), SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 1), val & 0xff));
  }
}

/*
 * Gradient run
 */
function mode_gradient(): void {
  gradient_base(false);
}

/*
 * Gradient run with hard transition
 */
function mode_loading(): void {
  gradient_base(true);
}

/*
 * Two dots running
 */
function mode_two_dots(): void {
  if (SEGLEN <= 1) return FX_FALLBACK_STATIC();
  const delay = 1 + Math.trunc((FRAMETIME << 3) / SEGLEN); // longer segments should change faster
  const it = Math.trunc(strip.now / map(SEGMENT.speed, 0, 255, delay << 4, delay)) >>> 0;
  const offset = it % SEGLEN;
  let width = (SEGLEN * (SEGMENT.intensity + 1)) >>> 9; // max width is half the strip
  if (!width) width = 1;
  if (!SEGMENT.check2) SEGMENT.fill(SEGCOLOR(2));
  const color1 = SEGCOLOR(0);
  const color2 = SEGCOLOR(1) === SEGCOLOR(2) ? color1 : SEGCOLOR(1);
  for (let i = 0; i < width; i++) {
    const indexR = (offset + i) % SEGLEN;
    const indexB = (offset + i + (SEGLEN >> 1)) % SEGLEN;
    SEGMENT.setPixelColor(indexR, color1);
    SEGMENT.setPixelColor(indexB, color2);
  }
}

/*
 * Fairy, inspired by https://www.youtube.com/watch?v=zeOw5MZWq24
 */
// struct Flasher { uint16_t stateStart; uint8_t stateDur; bool stateOn; } -> 4 bytes:
// uint16 at index 2f = stateStart, byte 4f+2 = stateDur, byte 4f+3 = stateOn
const FLASHERS_PER_ZONE = 6;
const MAX_SHIMMER = 92;
const flasherBri = new Uint8Array(FLASHERS_PER_ZONE * 2 - 1); // stack array in C, fully rewritten before use

function mode_fairy(): void {
  // set every pixel to a 'random' color from palette (using seed so it doesn't change between frames)
  let PRNG16 = (5100 + strip.getCurrSegmentId()) & 0xffff;
  for (let i = 0; i < SEGLEN; i++) {
    PRNG16 = (PRNG16 * 2053 + 1384) & 0xffff; // next 'random' number
    SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(PRNG16 >> 8, false, false, 0));
  }

  // amount of flasher pixels depending on intensity (0: none, 255: every LED)
  if (SEGMENT.intensity === 0) return;
  const flasherDistance = Math.trunc((255 - SEGMENT.intensity) / 28) + 1; // 1-10
  const numFlashers = Math.trunc(SEGLEN / flasherDistance) + 1;

  const dataSize = 4 * numFlashers;
  if (!SEGENV.allocateData(dataSize)) return; // allocation failed
  const u8 = SEGENV.data;
  const u16 = SEGENV.view(Uint16Array);
  const now16 = strip.now & 0xffff;

  // Up to 11 flashers in one brightness zone, afterwards a new zone for every 6 flashers
  let zones = Math.trunc(numFlashers / FLASHERS_PER_ZONE);
  if (!zones) zones = 1;
  let flashersInZone = Math.trunc(numFlashers / zones);

  for (let z = 0; z < zones; z++) {
    let flasherBriSum = 0;
    const firstFlasher = z * flashersInZone;
    if (z === zones - 1) flashersInZone = numFlashers - flashersInZone * (zones - 1);

    for (let f = firstFlasher; f < firstFlasher + flashersInZone; f++) {
      let stateTime = (now16 - u16[f * 2]!) & 0xffff;
      // random on/off time reached, switch state
      if (stateTime > u8[f * 4 + 2]! * 10) {
        u8[f * 4 + 3] = u8[f * 4 + 3] ? 0 : 1;
        if (u8[f * 4 + 3]) {
          u8[f * 4 + 2] = 12 + hw_random8(12 + ((255 - SEGMENT.speed) >> 2)); // *10, 250ms to 1250ms
        } else {
          u8[f * 4 + 2] = 20 + hw_random8(6 + ((255 - SEGMENT.speed) >> 2)); // *10, 250ms to 1250ms
        }
        u16[f * 2] = now16;
        if (stateTime < 255) {
          u16[f * 2] = u16[f * 2]! - (255 - stateTime); // start early to get correct bri
          u8[f * 4 + 2] = u8[f * 4 + 2]! + 26 - Math.trunc(stateTime / 10);
          stateTime = 255 - stateTime;
        } else {
          stateTime = 0;
        }
      }
      if (stateTime > 255) stateTime = 255; // for flasher brightness calculation, fades in first 255 ms of state
      flasherBri[f - firstFlasher] = u8[f * 4 + 3] ? stateTime : 255 - (stateTime >> 0);
      flasherBriSum += flasherBri[f - firstFlasher]!;
    }
    // dim factor, to create "shimmer" as other pixels get less voltage if a lot of flashers are on
    const avgFlasherBri = Math.trunc(flasherBriSum / flashersInZone);
    const globalPeakBri = 255 - ((avgFlasherBri * MAX_SHIMMER) >> 8); // 183-255, suitable for 1/5th of LEDs flashers

    for (let f = firstFlasher; f < firstFlasher + flashersInZone; f++) {
      const bri = Math.trunc((flasherBri[f - firstFlasher]! * globalPeakBri) / 255) & 0xff;
      PRNG16 = (PRNG16 * 2053 + 1384) & 0xffff; // next 'random' number
      const flasherPos = f * flasherDistance;
      SEGMENT.setPixelColor(flasherPos, color_blend(SEGCOLOR(1), SEGMENT.color_from_palette(PRNG16 >> 8, false, false, 0), bri));
      for (let i = flasherPos + 1; i < flasherPos + flasherDistance && i < SEGLEN; i++) {
        PRNG16 = (PRNG16 * 2053 + 1384) & 0xffff; // next 'random' number
        SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(PRNG16 >> 8, false, false, 0, globalPeakBri));
      }
    }
  }
}

/*
 * Fairytwinkle. Like Colortwinkle, but starting from all lit and not relying on strip.getPixelColor
 * Warning: Uses 4 bytes of segment data per pixel
 */
function mode_fairytwinkle(): void {
  const dataSize = 4 * SEGLEN;
  if (!SEGENV.allocateData(dataSize)) return FX_FALLBACK_STATIC(); // allocation failed
  const u8 = SEGENV.data;
  const u16 = SEGENV.view(Uint16Array);
  const now16 = strip.now & 0xffff;
  let PRNG16 = (5100 + strip.getCurrSegmentId()) & 0xffff;

  const riseFallTime = 400 + (255 - SEGMENT.speed) * 3;
  const maxDur = Math.trunc(riseFallTime / 100) + ((255 - SEGMENT.intensity) >> 2) + 13 + ((255 - SEGMENT.intensity) >> 1);

  for (let f = 0; f < SEGLEN; f++) {
    let stateTime = (now16 - u16[f * 2]!) & 0xffff;
    // random on/off time reached, switch state
    if (stateTime > u8[f * 4 + 2]! * 100) {
      u8[f * 4 + 3] = u8[f * 4 + 3] ? 0 : 1;
      const init = !u8[f * 4 + 2];
      if (u8[f * 4 + 3]) {
        u8[f * 4 + 2] = Math.trunc(riseFallTime / 100) + ((255 - SEGMENT.intensity) >> 2) + hw_random8(12 + ((255 - SEGMENT.intensity) >> 1)) + 1;
      } else {
        u8[f * 4 + 2] = Math.trunc(riseFallTime / 100) + hw_random8(3 + ((255 - SEGMENT.speed) >> 6)) + 1;
      }
      u16[f * 2] = now16;
      stateTime = 0;
      if (init) {
        u16[f * 2] = u16[f * 2]! - riseFallTime; // start lit
        u8[f * 4 + 2] = Math.trunc(riseFallTime / 100) + hw_random8(12 + ((255 - SEGMENT.intensity) >> 1)) + 5; // fire up a little quicker
        stateTime = riseFallTime & 0xffff;
      }
    }
    if (u8[f * 4 + 3] && u8[f * 4 + 2]! > maxDur) u8[f * 4 + 2] = maxDur; // react more quickly on intensity change
    if (stateTime > riseFallTime) stateTime = riseFallTime; // for flasher brightness calculation, fades in first 255 ms of state
    const fadeprog = 255 - Math.trunc((stateTime * 255) / riseFallTime);
    const flasherBri = (u8[f * 4 + 3] ? 255 - gamma8(fadeprog) : gamma8(fadeprog)) & 0xff;
    const lastR = PRNG16;
    let diff = 0;
    while (diff < 0x4000) { // make sure colors of two adjacent LEDs differ enough
      PRNG16 = (PRNG16 * 2053 + 1384) & 0xffff; // next 'random' number
      diff = PRNG16 > lastR ? PRNG16 - lastR : lastR - PRNG16;
    }
    SEGMENT.setPixelColor(f, color_blend(SEGCOLOR(1), SEGMENT.color_from_palette(PRNG16 >> 8, false, false, 0), flasherBri));
  }
}

/*
 * Running lights effect with smooth sine transition base (only the dual variant is in this batch).
 */
function running_base(saw: boolean, dual = false): void {
  const x_scale = SEGMENT.intensity >> 2;
  const counter = (Math.imul(strip.now, SEGMENT.speed) >>> 0) >>> 9;

  for (let i = 0; i < SEGLEN; i++) {
    let a = (i * x_scale - counter) >>> 0;
    if (saw) {
      a &= 0xff;
      if (a < 16) {
        a = 192 + a * 8;
      } else {
        a = map(a, 16, 255, 64, 192);
      }
      a = 255 - a;
    }
    const s = dual ? sin_gap(a) : sin8_t(a);
    let ca = color_blend(SEGCOLOR(1), SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 0), s);
    if (dual) {
      const b = ((SEGLEN - 1 - i) * x_scale - counter) >>> 0;
      const t = sin_gap(b);
      const cb = color_blend(SEGCOLOR(1), SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 2), t);
      ca = color_blend(ca, cb, 127);
    }
    SEGMENT.setPixelColor(i, ca);
  }
}

/*
 * Running lights in opposite directions.
 */
function mode_running_dual(): void {
  running_base(false, true);
}

/*
 * Tricolor chase function
 */
function tricolor_chase(color1: number, color2: number): void {
  const cycleTime = 50 + ((255 - SEGMENT.speed) << 1);
  const it = Math.trunc(strip.now / cycleTime) >>> 0; // iterator
  const width = 1 + (SEGMENT.intensity >> 4); // value of 1-16 for each colour
  let index = it % (width * 3);

  for (let i = 0; i < SEGLEN; i++, index++) {
    if (index > width * 3 - 1) index = 0;

    let color = color1;
    if (index > (width << 1) - 1) color = SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 1);
    else if (index > width - 1) color = color2;

    SEGMENT.setPixelColor(SEGLEN - i - 1, color);
  }
}

/*
 * Tricolor chase mode
 */
function mode_tricolor_chase(): void {
  tricolor_chase(SEGCOLOR(2), SEGCOLOR(0));
}

/*
 * ICU mode
 */
function mode_icu(): void {
  // states: 0 = pause1, 1 = blink, 2 = pause2, 3 = move

  const now = strip.now & 0xffff; // save time for delay calculation, use low16 bits only
  let dest = SEGENV.aux1;
  const space = (SEGMENT.intensity >> 3) + 2;
  let state = (SEGENV.step >>> 16) & 0xffff; // upper bytes of step store current state
  let nextUpdate = SEGENV.step & 0xffff; // lower bytes store time for next update

  const pindex = map(dest, 0, SEGLEN - Math.trunc(SEGLEN / space), 0, 255) & 0xff;
  const col = SEGMENT.color_from_palette(pindex, false, false, 0);
  const bgcol = SEGMENT.check2 ? BLACK : SEGCOLOR(1);
  SEGMENT.fill(bgcol); // apply background color or clear
  // draw eyes if not blinking
  if (state !== 1) {
    SEGMENT.setPixelColor(dest, col);
    SEGMENT.setPixelColor(dest + Math.trunc(SEGLEN / space), col);
    // render next position if moving
    if (state === 3) {
      if (SEGENV.aux0 > SEGENV.aux1) {
        dest++;
      } else if (SEGENV.aux0 < SEGENV.aux1) {
        dest--;
      }
      SEGMENT.setPixelColor(dest, col);
      SEGMENT.setPixelColor(dest + Math.trunc(SEGLEN / space), col);
    }
  }

  // update state
  if ((((now - nextUpdate) << 16) >> 16) >= 0) { // time to update, cast to int to handle wraparound properly
    switch (state) {
      case 0: // pause part 1
        // first pause part finished, blink or pause some more
        state++;
        if (hw_random8(6) === 0) { // blink once in a while
          nextUpdate = (now + 200) & 0xffff;
          break;
        }
      // falls through if not blinking
      case 1: // blink
        // not blinking or finished blinking -> pause part 2
        nextUpdate = (now + 500 + hw_random16(1000)) & 0xffff;
        state++;
        break;
      case 2: // pause part 2
        // pause finished, move
        SEGENV.aux0 = hw_random16(SEGLEN - Math.trunc(SEGLEN / space)); // choose a new destination
        nextUpdate = now;
        state++;
        break;
      default: // move (state 3)
        SEGENV.aux1 = dest; // update destination to moved position
        nextUpdate = (now + SPEED_FORMULA_L()) & 0xffff;
        if (SEGENV.aux0 === dest) {
          // reached destination
          nextUpdate = (now + 500 + hw_random16(1000)) & 0xffff;
          state = 0;
        }
        break;
    }
  }

  // use upper bits of SEGENV.step to store current state, lower bits for next update time
  SEGENV.step = ((state << 16) | nextUpdate) >>> 0;
}

/** FX.h SPEED_FORMULA_L: (5U + (50U*(255U - SEGMENT.speed))/SEGLEN) */
const SPEED_FORMULA_L = (): number => 5 + Math.trunc((50 * (255 - SEGMENT.speed)) / SEGLEN);

/*
 * Custom mode by Aircoookie. Color Wipe, but with 3 colors
 */
function mode_tricolor_wipe(): void {
  const cycleTime = 1000 + (255 - SEGMENT.speed) * 200;
  const perc = strip.now % cycleTime;
  const prog = Math.trunc((perc * 65535) / cycleTime);
  const ledIndex = ((prog * SEGLEN * 3) >>> 0) >>> 16;
  let ledOffset = ledIndex;

  for (let i = 0; i < SEGLEN; i++) {
    SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 2));
  }

  if (ledIndex < SEGLEN) { // wipe from 0 to 1
    for (let i = 0; i < SEGLEN; i++) {
      SEGMENT.setPixelColor(i, i > ledOffset ? SEGCOLOR(0) : SEGCOLOR(1));
    }
  } else if (ledIndex < SEGLEN * 2) { // wipe from 1 to 2
    ledOffset = ledIndex - SEGLEN;
    for (let i = ledOffset + 1; i < SEGLEN; i++) {
      SEGMENT.setPixelColor(i, SEGCOLOR(1));
    }
  } else { // wipe from 2 to 0
    ledOffset = ledIndex - SEGLEN * 2;
    for (let i = 0; i <= ledOffset; i++) {
      SEGMENT.setPixelColor(i, SEGCOLOR(0));
    }
  }
}

/*
 * Fades between 3 colors
 * Custom mode by Keith Lord: https://github.com/kitesurfer1404/WS2812FX/blob/master/src/custom/TriFade.h
 * Modified by Aircoookie
 */
function mode_tricolor_fade(): void {
  const counter = Math.imul(strip.now, (SEGMENT.speed >> 3) + 1) & 0xffff;
  const prog = (counter * 768) >>> 16;

  let color1 = 0, color2 = 0;
  let stage = 0;

  if (prog < 256) {
    color1 = SEGCOLOR(0);
    color2 = SEGCOLOR(1);
    stage = 0;
  } else if (prog < 512) {
    color1 = SEGCOLOR(1);
    color2 = SEGCOLOR(2);
    stage = 1;
  } else {
    color1 = SEGCOLOR(2);
    color2 = SEGCOLOR(0);
    stage = 2;
  }

  const stp = prog & 0xff; // % 256
  for (let i = 0; i < SEGLEN; i++) {
    let color: number;
    if (stage === 2) {
      color = color_blend(SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 2), color2, stp);
    } else if (stage === 1) {
      color = color_blend(color1, SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 2), stp);
    } else {
      color = color_blend(color1, color2, stp);
    }
    SEGMENT.setPixelColor(i, color);
  }
}

/*
 * Running random pixels ("Stream 2")
 * Custom mode by Keith Lord: https://github.com/kitesurfer1404/WS2812FX/blob/master/src/custom/RandomChase.h
 */
function mode_random_chase(): void {
  if (SEGENV.call === 0) {
    // FX.cpp's global prng was seeded with hw_random() at boot and its state on this first call is
    // whatever earlier effects left; we seed it from the (deterministic) random source instead.
    prng.setSeed(hw_random());
    const r = prng.random8(), g = prng.random8(), b = prng.random8();
    SEGENV.step = RGBW32(r, g, b, 0);
    SEGENV.aux0 = prng.random16();
  }
  const prevSeed = prng.getSeed(); // save seed so we can restore it at the end of the function
  const cycleTime = 25 + 3 * (255 - SEGMENT.speed);
  const it = Math.trunc(strip.now / cycleTime) >>> 0;
  let color = SEGENV.step;
  prng.setSeed(SEGENV.aux0);

  for (let i = SEGLEN - 1; i >= 0; i--) {
    const r = prng.random8(6) !== 0 ? (color >>> 16) & 0xff : prng.random8();
    const g = prng.random8(6) !== 0 ? (color >>> 8) & 0xff : prng.random8();
    const b = prng.random8(6) !== 0 ? color & 0xff : prng.random8();
    color = RGBW32(r, g, b, 0);
    SEGMENT.setPixelColor(i, color);
    if (i === SEGLEN - 1 && SEGENV.aux1 !== (it & 0xffff)) { // new first color in next frame
      SEGENV.step = color;
      SEGENV.aux0 = prng.getSeed();
    }
  }

  SEGENV.aux1 = it & 0xffff;

  prng.setSeed(prevSeed); // restore original seed so other effects can use "random" PRNG
}

// struct Oscillator { uint16_t pos; uint8_t size; int8_t dir; uint8_t speed; } -> sizeof 6 (padded):
// uint16 at index 3i = pos, byte 6i+2 = size, int8 at 6i+3 = dir, byte 6i+4 = speed
/*
/  Oscillating bars of color, updated with standard framerate
*/
function mode_oscillate(): void {
  const numOscillators = 3;
  const dataSize = 6 * numOscillators;

  if (!SEGENV.allocateData(dataSize)) return FX_FALLBACK_STATIC(); // allocation failed

  const u8 = SEGENV.data;
  const i8 = SEGENV.view(Int8Array);
  const u16 = SEGENV.view(Uint16Array);

  if (SEGENV.call === 0) {
    const q = Math.trunc(SEGLEN / 4), e = Math.trunc(SEGLEN / 8);
    u16[0] = q; u8[2] = e; i8[3] = 1; u8[4] = 1;
    u16[3] = q * 3; u8[8] = e; i8[9] = 1; u8[10] = 2;
    u16[6] = q * 2; u8[14] = e; i8[15] = -1; u8[16] = 1;
  }

  const cycleTime = 20 + 2 * (255 - SEGMENT.speed);
  const it = Math.trunc(strip.now / cycleTime) >>> 0;

  for (let i = 0; i < numOscillators; i++) {
    // if the counter has increased, move the oscillator by the random step
    if (it !== SEGENV.step) u16[i * 3] = u16[i * 3]! + i8[i * 6 + 3]! * u8[i * 6 + 4]!;
    u8[i * 6 + 2] = Math.trunc(SEGLEN / (3 + Math.trunc(SEGMENT.intensity / 8)));
    if (i8[i * 6 + 3] === -1 && u16[i * 3]! > SEGLEN << 1) { // use integer overflow
      u16[i * 3] = 0;
      i8[i * 6 + 3] = 1;
      // make bigger steps for faster speeds
      u8[i * 6 + 4] = SEGMENT.speed > 100 ? hw_random8(2, 4) : hw_random8(1, 3);
    }
    if (i8[i * 6 + 3] === 1 && u16[i * 3]! >= SEGLEN - 1) {
      u16[i * 3] = SEGLEN - 1;
      i8[i * 6 + 3] = -1;
      u8[i * 6 + 4] = SEGMENT.speed > 100 ? hw_random8(2, 4) : hw_random8(1, 3);
    }
  }

  for (let i = 0; i < SEGLEN; i++) {
    let color = BLACK;
    for (let j = 0; j < numOscillators; j++) {
      const pos = u16[j * 3]!, size = u8[j * 6 + 2]!;
      if (i >= pos - size && i <= pos + size) {
        color = color === BLACK ? SEGCOLOR(j) : color_blend(color, SEGCOLOR(j), 128);
      }
    }
    SEGMENT.setPixelColor(i, color);
  }

  SEGENV.step = it;
}

function mode_lightning(): void {
  if (SEGLEN <= 1) return FX_FALLBACK_STATIC();
  const ledstart = hw_random16(SEGLEN); // Determine starting location of flash
  const ledlen = 1 + hw_random16(SEGLEN - ledstart); // Determine length of flash (not to go beyond NUM_LEDS-1)
  let bri = Math.trunc(255 / hw_random8(1, 3)) & 0xff;

  if (SEGENV.aux1 === 0) { // init, leader flash
    SEGENV.aux1 = hw_random8(4, 4 + Math.trunc(SEGMENT.intensity / 20)); // number of flashes
    SEGENV.aux1 *= 2;

    bri = 52; // leader has lower brightness
    SEGENV.aux0 = 200; // 200ms delay after leader
  }

  if (!SEGMENT.check2) SEGMENT.fill(SEGCOLOR(1));

  if (SEGENV.aux1 > 3 && !(SEGENV.aux1 & 0x01)) { // flash on even number >2
    for (let i = ledstart; i < ledstart + ledlen; i++) {
      SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 0, bri));
    }
    SEGENV.aux1--;

    SEGENV.step = strip.now;
  } else {
    if (((strip.now - SEGENV.step) >>> 0) > SEGENV.aux0) {
      SEGENV.aux1--;
      if (SEGENV.aux1 < 2) SEGENV.aux1 = 0;

      SEGENV.aux0 = 50 + hw_random8(100); // delay between flashes
      if (SEGENV.aux1 === 2) {
        SEGENV.aux0 = hw_random8(255 - SEGMENT.speed) * 100; // delay between strikes
      }
      SEGENV.step = strip.now;
    }
  }
}

// combined function from original pride and colorwaves
function mode_colorwaves_pride_base(isPride2015: boolean): void {
  const duration = 10 + SEGMENT.speed;
  let sPseudotime = SEGENV.step;
  let sHue16 = SEGENV.aux0;

  const sat8 = isPride2015 ? beatsin88_t(87, 220, 250) & 0xff : 255;
  const brightdepth = beatsin88_t(341, 96, 224);
  const brightnessthetainc16 = beatsin88_t(203, 25 * 256, 40 * 256);
  const msmultiplier = beatsin88_t(147, 23, 60);

  let hue16 = sHue16;
  const hueinc16 = isPride2015 ? beatsin88_t(113, 1, 3000)
    : Math.trunc((beatsin88_t(113, 60, 300) * SEGMENT.intensity * 10) / 255);

  sPseudotime = (sPseudotime + duration * msmultiplier) >>> 0;
  sHue16 = (sHue16 + duration * beatsin88_t(400, 5, 9)) >>> 0;
  let brightnesstheta16 = sPseudotime;

  for (let i = 0; i < SEGLEN; i++) {
    hue16 = (hue16 + hueinc16) >>> 0;
    let hue8: number;

    if (isPride2015) {
      hue8 = (hue16 >>> 8) & 0xff;
    } else {
      const h16_128 = hue16 >>> 7;
      hue8 = (h16_128 & 0x100 ? 255 - (h16_128 >>> 1) : h16_128 >>> 1) & 0xff;
    }

    brightnesstheta16 = (brightnesstheta16 + brightnessthetainc16) >>> 0;
    const b16 = sin16_t(brightnesstheta16) + 32768;
    const bri16 = Math.floor((b16 * b16) / 65536);
    let bri8 = Math.floor((bri16 * brightdepth) / 65536) & 0xff;
    bri8 = (bri8 + (255 - brightdepth)) & 0xff;

    if (isPride2015) {
      const newcolor = gamma32inv(CHSV(hue8, sat8, bri8) & 0xffffff);
      SEGMENT.blendPixelColor(i, newcolor, 64);
    } else {
      SEGMENT.blendPixelColor(i, SEGMENT.color_from_palette(hue8, false, PALETTE_SOLID_WRAP, 0, bri8), 128);
    }
  }

  SEGENV.step = sPseudotime;
  SEGENV.aux0 = sHue16;
}

// Pride2015
// Animated, ever-changing rainbows.
// by Mark Kriegsman: https://gist.github.com/kriegsman/964de772d64c502760e5
function mode_pride_2015(): void {
  mode_colorwaves_pride_base(true);
}

// ColorWavesWithPalettes by Mark Kriegsman: https://gist.github.com/kriegsman/8281905786e8b2632aeb
// This function draws color waves with an ever-changing,
// widely-varying set of parameters, using a color palette.
function mode_colorwaves(): void {
  mode_colorwaves_pride_base(false);
}

// eight colored dots, weaving in and out of sync with each other
function mode_juggle(): void {
  if (SEGLEN <= 1) return FX_FALLBACK_STATIC();

  SEGMENT.fadeToBlackBy(192 - Math.trunc((3 * SEGMENT.intensity) / 4));
  let dothue = 0;
  for (let i = 0; i < 8; i++) {
    const index = 0 + beatsin88_t((16 + SEGMENT.speed) * (i + 7), 0, SEGLEN - 1);
    const cur = SEGMENT.getPixelColor(index);
    const add = SEGMENT.palette === 0 ? CHSV(dothue, 220, 255) : ColorFromPalette(SEGPALETTE, dothue, 255);
    // CRGB |= CRGB: per-channel maximum (W is dropped by the CRGB conversion)
    SEGMENT.setPixelColor(index, RGBW32(Math.max(R(cur), R(add)), Math.max(G(cur), G(add)), Math.max(B(cur), B(add))));
    dothue = (dothue + 32) & 0xff;
  }
}

// colored stripes pulsing at a defined Beats-Per-Minute (BPM)
function mode_bpm(): void {
  const stp = Math.trunc(strip.now / 20) & 0xff;
  const beat = beatsin8_t(SEGMENT.speed, 64, 255);
  for (let i = 0; i < SEGLEN; i++) {
    // palette index stays 16-bit, as in C (see the note at the top)
    SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(stp + i * 2, false, PALETTE_SOLID_WRAP, 0, (beat - stp + i * 10) & 0xff));
  }
}

/*
 * Tetris or Stacking (falling bricks) Effect
 * by Blaz Kristan (AKA blazoncek) (https://github.com/blazoncek, https://blaz.at/home)
 */
// struct Tetris { float pos; float speed; uint8_t col; uint16_t brick; uint16_t stack; uint32_t step; } -> 20 bytes:
// float [0] = pos, float [1] = speed, byte 8 = col, uint16 [5] = brick, uint16 [6] = stack, uint32 [4] = step
function mode_tetrix(): void {
  if (SEGLEN <= 1) return FX_FALLBACK_STATIC();
  const strips = SEGMENT.nrOfVStrips(); // allow running on virtual strips (columns in 2D segment)
  const dataSize = 20;
  if (!SEGENV.allocateData(dataSize * strips)) return FX_FALLBACK_STATIC(); // allocation failed

  // nrOfVStrips() is always 1 here, so only one Tetris struct (indexToVStrip(i, 0) === i)
  const f32 = SEGENV.view(Float32Array);
  const u8 = SEGENV.data;
  const u16 = SEGENV.view(Uint16Array);
  const u32 = SEGENV.view(Uint32Array);

  // initialize dropping on first call or segment full
  if (SEGENV.call === 0) {
    u16[6] = 0; // reset brick stack size
    u32[4] = strip.now + 2000; // start by fading out strip
    if (SEGMENT.check1) u8[8] = 0; // use only one color from palette
  }

  if (u32[4] === 0) { // init brick
    // speed calculation: a single brick should reach bottom of strip in X seconds
    // if the speed is set to 1 this should take 5s and at 255 it should take 0.25s
    // as this is dependant on SEGLEN it should be taken into account and the fact that effect runs every FRAMETIME s
    let speed = SEGMENT.speed ? SEGMENT.speed : hw_random8(1, 255);
    speed = map(speed, 1, 255, 5000, 250); // time taken for full (SEGLEN) drop
    f32[1] = Math.fround(SEGLEN * FRAMETIME) / Math.fround(speed); // set speed
    f32[0] = SEGLEN; // start at end of segment (no need to subtract 1)
    if (!SEGMENT.check1) u8[8] = hw_random8(0, 15) << 4; // limit color choices so there is enough HUE gap
    u32[4] = 1; // drop state (0 init, 1 forming, 2 falling)
    u16[5] = (SEGMENT.intensity ? (SEGMENT.intensity >> 5) + 1 : hw_random8(1, 5)) * (1 + (SEGLEN >> 6)); // size of brick
  }

  if (u32[4] === 1) { // forming
    if (hw_random8() >> 6) { // random drop
      u32[4] = 2; // fall
    }
  }

  if (u32[4] === 2) { // falling
    if (f32[0]! > u16[6]!) { // fall until top of stack
      f32[0] = f32[0]! - f32[1]!; // may add gravity as: speed += gravity
      if (Math.trunc(f32[0]!) < u16[6]!) f32[0] = u16[6]!;
      const pos = Math.trunc(f32[0]!) >>> 0;
      for (let i = pos; i < SEGLEN; i++) {
        const col = i < pos + u16[5]! ? SEGMENT.color_from_palette(u8[8]!, false, false, 0) : SEGCOLOR(1);
        SEGMENT.setPixelColor(i, col);
      }
    } else { // we hit bottom
      u32[4] = 0; // proceed with next brick, go back to init
      u16[6] = u16[6]! + u16[5]!; // increase the stack size
      if (u16[6]! >= SEGLEN) u32[4] = strip.now + 2000; // fade out stack
    }
  }

  if (u32[4]! > 2) { // fade strip
    u16[5] = 0; // reset brick size (no more growing)
    if (u32[4]! > strip.now) {
      // allow fading of virtual strip
      for (let i = 0; i < SEGLEN; i++) SEGMENT.blendPixelColor(i, SEGCOLOR(1), 25); // 10% blend
    } else {
      u16[6] = 0; // reset brick size
      u32[4] = 0; // proceed with next brick
      if (SEGMENT.check1) u8[8] = u8[8]! + 8; // gradually increase palette index
    }
  }
}

function mode_fillnoise8(): void {
  if (SEGENV.call === 0) SEGENV.step = hw_random();
  for (let i = 0; i < SEGLEN; i++) {
    const index = perlin8(i * SEGLEN, SEGENV.step + i * SEGLEN);
    SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(index, false, PALETTE_SOLID_WRAP, 0));
  }
  SEGENV.step += beatsin8_t(SEGMENT.speed, 1, 6); // 10,1,4
}

function mode_noise16_1(): void {
  const scale = 320; // the "zoom factor" for the noise
  SEGENV.step += 1 + Math.trunc(SEGMENT.speed / 16);

  for (let i = 0; i < SEGLEN; i++) {
    const shift_x = beatsin8_t(11); // the x position of the noise field swings @ 17 bpm
    const shift_y = Math.trunc(SEGENV.step / 42); // the y position becomes slowly incremented
    const real_x = Math.imul(i + shift_x, scale) >>> 0; // the x position of the noise field swings @ 17 bpm
    const real_y = Math.imul(i + shift_y, scale) >>> 0; // the y position becomes slowly incremented
    const real_z = SEGENV.step; // the z position becomes quickly incremented
    const noise = perlin16(real_x, real_y, real_z) >> 8; // get the noise data and scale it down
    const index = sin8_t(noise * 3); // map LED color based on noise data

    SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(index, false, PALETTE_SOLID_WRAP, 0));
  }
}

function mode_noise16_2(): void {
  const scale = 1000; // the "zoom factor" for the noise
  SEGENV.step += 1 + (SEGMENT.speed >> 1);

  for (let i = 0; i < SEGLEN; i++) {
    const shift_x = SEGENV.step >>> 6; // x as a function of time
    const real_x = Math.imul(i + shift_x, scale) >>> 0; // calculate the coordinates within the noise field
    const noise = perlin16(real_x, 0, 4223) >> 8; // get the noise data and scale it down
    const index = sin8_t(noise * 3); // map led color based on noise data

    SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(index, false, PALETTE_SOLID_WRAP, 0, noise));
  }
}

function mode_noise16_3(): void {
  const scale = 800; // the "zoom factor" for the noise
  SEGENV.step += 1 + SEGMENT.speed;

  for (let i = 0; i < SEGLEN; i++) {
    const shift_x = 4223; // no movement along x and y
    const shift_y = 1234;
    const real_x = Math.imul(i + shift_x, scale) >>> 0; // calculate the coordinates within the noise field
    const real_y = Math.imul(i + shift_y, scale) >>> 0; // based on the precalculated positions
    const real_z = Math.imul(SEGENV.step, 8) >>> 0;
    const noise = perlin16(real_x, real_y, real_z) >> 8; // get the noise data and scale it down
    const index = sin8_t(noise * 3); // map led color based on noise data

    SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(index, false, PALETTE_SOLID_WRAP, 0, noise));
  }
}

// https://github.com/aykevl/ledstrip-spark/blob/master/ledstrip.ino
function mode_noise16_4(): void {
  const stp = (Math.imul(strip.now, SEGMENT.speed) >>> 0) >>> 7;
  for (let i = 0; i < SEGLEN; i++) {
    const index = perlin16((i << 12) >>> 0, stp);
    // palette index stays 16-bit, as in C (see the note at the top)
    SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(index, false, PALETTE_SOLID_WRAP, 0));
  }
}

// Calm effect, like a lake at night
function mode_lake(): void {
  const sp = Math.trunc(SEGMENT.speed / 10);
  const wave1 = beatsin8_t(sp + 2, -64, 64);
  const wave2 = beatsin8_t(sp + 1, -64, 64);
  const wave3 = beatsin8_t(sp + 2, 0, 80);

  for (let i = 0; i < SEGLEN; i++) {
    const index = (cos8_t(i * 15 + wave1) >> 1) + (cubicwave8(i * 23 + wave2) >> 1);
    const lum = index > wave3 ? (index - wave3) & 0xff : 0;
    SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(index, false, false, 0, lum));
  }
}

// meteor effect & meteor smooth (merged by @dedehai)
// send a meteor from begining to to the end of the strip with a trail that randomly decays.
// adapted from https://www.tweaking4all.com/hardware/arduino/adruino-led-strip-effects/#LEDStripEffectMeteorRain
function mode_meteor(): void {
  if (SEGLEN <= 1) return FX_FALLBACK_STATIC();
  if (!SEGENV.allocateData(SEGLEN)) return FX_FALLBACK_STATIC(); // allocation failed
  const meteorSmooth = SEGMENT.check3;
  const trail = SEGENV.data;

  const meteorSize = 1 + Math.trunc(SEGLEN / 20); // 5%
  let meteorstart: number;
  if (meteorSmooth) meteorstart = map((SEGENV.step >>> 6) & 0xff, 0, 255, 0, SEGLEN - 1) & 0xffff;
  else {
    const counter = Math.imul(strip.now, (SEGMENT.speed >> 2) + 8) >>> 0;
    meteorstart = ((Math.imul(counter, SEGLEN) >>> 0) >>> 16) & 0xffff;
  }

  const max = SEGMENT.palette === 5 || !SEGMENT.check1 ? 240 : 255;
  // fade all leds to colors[1] in LEDs one step
  for (let i = 0; i < SEGLEN; i++) {
    let col: number;
    if (hw_random8() <= 255 - SEGMENT.intensity) {
      if (meteorSmooth) {
        if (trail[i]! > 0) {
          const change = trail[i]! + 4 - hw_random8(24); // change each time between -20 and +4
          trail[i] = constrain(change, 0, max);
        }
        col = SEGMENT.check1 ? SEGMENT.color_from_palette(i, true, false, 0, trail[i]!) : SEGMENT.color_from_palette(trail[i]!, false, true, 255);
      } else {
        trail[i] = scale8(trail[i]!, 128 + hw_random8(127));
        let index = trail[i]!;
        let idx = 255;
        let bri = SEGMENT.palette === 35 || SEGMENT.palette === 36 ? 255 : trail[i]!;
        if (!SEGMENT.check1) {
          idx = 0;
          index = map(i, 0, SEGLEN, 0, max);
          bri = trail[i]!;
        }
        col = SEGMENT.color_from_palette(index, false, false, idx, bri); // full brightness for Fire
      }
      SEGMENT.setPixelColor(i, col);
    }
  }

  // draw meteor
  for (let j = 0; j < meteorSize; j++) {
    const index = (meteorstart + j) % SEGLEN;
    if (meteorSmooth) {
      trail[index] = max;
      const col = SEGMENT.check1 ? SEGMENT.color_from_palette(index, true, false, 0, trail[index]!) : SEGMENT.color_from_palette(trail[index]!, false, true, 255);
      SEGMENT.setPixelColor(index, col);
    } else {
      let idx = 255;
      trail[index] = max;
      let i = max;
      if (!SEGMENT.check1) {
        i = map(index, 0, SEGLEN, 0, max);
        idx = 0;
      }
      const col = SEGMENT.color_from_palette(i, false, false, idx, 255); // full brightness
      SEGMENT.setPixelColor(index, col);
    }
  }

  SEGENV.step += SEGMENT.speed + 1;
}

// Railway Crossing / Christmas Fairy lights
function mode_railway(): void {
  if (SEGLEN <= 1) return FX_FALLBACK_STATIC();
  const dur = (256 - SEGMENT.speed) * 40;
  const rampdur = ((dur * SEGMENT.intensity) >> 8) & 0xffff;
  if (SEGENV.step > dur) {
    // reverse direction
    SEGENV.step = 0;
    SEGENV.aux0 = SEGENV.aux0 ? 0 : 1;
  }
  let pos = 255;
  if (rampdur !== 0) {
    const p0 = Math.trunc((SEGENV.step * 255) / rampdur);
    if (p0 < 255) pos = p0;
  }
  if (SEGENV.aux0) pos = 255 - pos;
  for (let i = 0; i < SEGLEN; i += 2) {
    SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(255 - pos, false, false, 255)); // do not use color 1 or 2, always use palette
    if (i < SEGLEN - 1) {
      SEGMENT.setPixelColor(i + 1, SEGMENT.color_from_palette(pos, false, false, 255)); // do not use color 1 or 2, always use palette
    }
  }
  SEGENV.step += FRAMETIME;
}

//  TwinkleFOX by Mark Kriegsman: https://gist.github.com/kriegsman/756ea6dcae8e30845b5a
//
//  TwinkleFOX: Twinkling 'holiday' lights that fade in and out.
//  Colors are chosen from a palette. Read more about this effect using the link above!
function twinklefox_one_twinkle(ms: number, salt: number, cat: boolean): number {
  // Overall twinkle speed (changed)
  const ticks = Math.trunc(ms / SEGENV.aux0) >>> 0;
  const fastcycle8 = ticks & 0xff;
  let slowcycle16 = ((ticks >>> 8) + salt) & 0xffff;
  slowcycle16 = (slowcycle16 + sin8_t(slowcycle16)) & 0xffff;
  slowcycle16 = (slowcycle16 * 2053 + 1384) & 0xffff;
  const slowcycle8 = ((slowcycle16 & 0xff) + (slowcycle16 >> 8)) & 0xff;

  // Overall twinkle density.
  // 0 (NONE lit) to 8 (ALL lit at once).
  // Default is 5.
  const twinkleDensity = (SEGMENT.intensity >> 5) + 1;

  let bright = 0;
  if ((slowcycle8 & 0x0e) >> 1 < twinkleDensity) {
    let ph = fastcycle8;
    // This is like 'triwave8', which produces a
    // symmetrical up-and-down triangle sawtooth waveform, except that this
    // function produces a triangle wave with a faster attack and a slower decay
    if (cat) { // twinklecat, variant where the leds instantly turn on and fade off
      bright = 255 - ph;
      if (SEGMENT.check2) { // reverse checkbox, reverses the leds to fade on and instantly turn off
        bright = ph;
      }
    } else { // vanilla twinklefox
      if (ph < 86) {
        bright = ph * 3;
      } else {
        ph -= 86;
        bright = 255 - (ph + (ph >> 1));
      }
    }
  }

  const hue = (slowcycle8 - salt) & 0xff;
  let c: number;
  if (bright > 0) {
    c = ColorFromPalette(SEGPALETTE, hue, gamma8inv(bright), NOBLEND); // note on gamma8inv: inverting results in non-linear brightness fade as originally designed
    if (!SEGMENT.check1) {
      // This code takes a pixel, and if its in the 'fading down'
      // part of the cycle, it adjusts the color a little bit like the
      // way that incandescent bulbs fade toward 'red' as they dim.
      if (fastcycle8 >= 128) {
        const cooling = (fastcycle8 - 128) >> 4;
        c = RGBW32(R(c), qsub8(G(c), cooling), qsub8(B(c), cooling * 2), W(c));
      }
    }
  } else {
    c = 0; // black
  }
  return c;
}

//  This function loops over each pixel, calculates the
//  adjusted 'clock' that this pixel should use, and calls
//  "CalculateOneTwinkle" on each pixel.  It then displays
//  either the twinkle color of the background color,
//  whichever is brighter.
function twinklefox_base(cat: boolean): void {
  // "PRNG16" is the pseudorandom number generator
  // It MUST be reset to the same starting value each time
  // this function is called, so that the sequence of 'random'
  // numbers that it generates is (paradoxically) stable.
  let PRNG16 = 11337;

  // Calculate speed
  if (SEGMENT.speed > 100) SEGENV.aux0 = 3 + ((255 - SEGMENT.speed) >> 3);
  else SEGENV.aux0 = 22 + ((100 - SEGMENT.speed) >> 1);

  // Set up the background color, "bg". Note: using gamma invert for brightness as the FX was written without any gamma correction, it will dim down too much now
  let bg = SEGCOLOR(1);
  let bglight = getRGBaverage(bg);
  if (bglight > 64) {
    bg = color_fade(bg, gamma8inv(16), true); // very bright, so scale to 1/16th
  } else if (bglight > 16) {
    bg = color_fade(bg, gamma8inv(64), true); // not that bright, so scale to 1/4
  } else {
    bg = color_fade(bg, gamma8inv(86), true); // dim, scale to 1/3rd
  }

  bglight = getRGBaverage(bg); // update after scaling

  for (let i = 0; i < SEGLEN; i++) {
    PRNG16 = (PRNG16 * 2053 + 1384) & 0xffff; // next 'random' number
    const myclockoffset16 = PRNG16; // use that number as clock offset
    PRNG16 = (PRNG16 * 2053 + 1384) & 0xffff; // next 'random' number
    // use that number as clock speed adjustment factor (in 8ths, from 8/8ths to 23/8ths)
    const myspeedmultiplierQ5_3 = ((((PRNG16 & 0xff) >> 4) + (PRNG16 & 0x0f)) & 0x0f) + 0x08;
    const myclock30 = (((Math.imul(strip.now, myspeedmultiplierQ5_3) >>> 0) >>> 3) + myclockoffset16) >>> 0;
    const myunique8 = PRNG16 >> 8; // get 'salt' value for this pixel

    // We now have the adjusted 'clock' for this pixel, now we call
    // the function that computes what color the pixel should be based
    // on the "brightness = f( time )" idea.
    const c = twinklefox_one_twinkle(myclock30, myunique8, cat);

    const cbright = getRGBaverage(c);
    const deltabright = cbright - bglight;
    if (deltabright >= 32 || bg === 0) {
      // If the new pixel is significantly brighter than the background color,
      // use the new color.
      SEGMENT.setPixelColor(i, c);
    } else if (deltabright > 0) {
      // If the new pixel is just slightly brighter than the background color,
      // mix a blend of the new color and the background color
      SEGMENT.setPixelColor(i, color_blend(bg, c, (deltabright * 8) & 0xff));
    } else {
      // if the new pixel is not at all brighter than the background color,
      // just use the background color.
      SEGMENT.setPixelColor(i, bg);
    }
  }
}

function mode_twinklefox(): void {
  twinklefox_base(false);
}

function mode_twinklecat(): void {
  twinklefox_base(true);
}

// Speed slider sets amount of LEDs lit, intensity sets unlit
function mode_static_pattern(): void {
  const lit = 1 + SEGMENT.speed;
  const unlit = 1 + SEGMENT.intensity;
  let drawingLit = true;
  let cnt = 0;

  for (let i = 0; i < SEGLEN; i++) {
    SEGMENT.setPixelColor(i, drawingLit ? SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 0) : SEGCOLOR(1));
    cnt++;
    if (cnt >= (drawingLit ? lit : unlit)) {
      cnt = 0;
      drawingLit = !drawingLit;
    }
  }
}

function mode_tri_static_pattern(): void {
  const segSize = (SEGMENT.intensity >> 5) + 1;
  let currSeg = 0;
  let currSegCount = 0;

  for (let i = 0; i < SEGLEN; i++) {
    if (currSeg % 3 === 0) {
      SEGMENT.setPixelColor(i, SEGCOLOR(0));
    } else if (currSeg % 3 === 1) {
      SEGMENT.setPixelColor(i, SEGCOLOR(1));
    } else {
      SEGMENT.setPixelColor(i, SEGCOLOR(2));
    }
    currSegCount += 1;
    if (currSegCount >= segSize) {
      currSeg += 1;
      currSegCount = 0;
    }
  }
}

function spots_base(threshold: number): void {
  threshold &= 0xffff;
  if (SEGLEN <= 1) return FX_FALLBACK_STATIC();
  if (!SEGMENT.check2) SEGMENT.fill(SEGCOLOR(1));

  const maxZones = SEGLEN >> 2;
  const zones = 1 + ((SEGMENT.intensity * maxZones) >>> 8);
  const zoneLen = Math.trunc(SEGLEN / zones);
  const offset = (SEGLEN - zones * zoneLen) >>> 1;

  for (let z = 0; z < zones; z++) {
    const pos = offset + z * zoneLen;
    for (let i = 0; i < zoneLen; i++) {
      const wave = triwave16(Math.trunc((i * 0xffff) / zoneLen));
      if (wave > threshold) {
        const index = 0 + pos + i;
        const s = Math.trunc(((wave - threshold) * 255) / (0xffff - threshold));
        SEGMENT.setPixelColor(index, color_blend(SEGMENT.color_from_palette(index, true, PALETTE_SOLID_WRAP, 0), SEGCOLOR(1), (255 - s) & 0xff));
      }
    }
  }
}

// Intensity slider sets number of "lights", speed sets LEDs per light
function mode_spots(): void {
  spots_base((255 - SEGMENT.speed) << 8);
}

// Intensity slider sets number of "lights", LEDs per light fade in and out
function mode_spots_fade(): void {
  const counter = Math.imul(strip.now, (SEGMENT.speed >> 2) + 8) >>> 0;
  const t = triwave16(counter);
  const tr = (t >> 1) + (t >> 2);
  spots_base(tr);
}

/*
 * Blinks one LED at a time.
 * Inspired by www.tweaking4all.com/hardware/arduino/adruino-led-strip-effects/
 */
function mode_sparkle(): void {
  if (!SEGMENT.check2) {
    for (let i = 0; i < SEGLEN; i++) {
      SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 1));
    }
  }
  const cycleTime = 10 + (255 - SEGMENT.speed) * 2;
  const it = Math.trunc(strip.now / cycleTime) >>> 0;
  if (it !== SEGENV.step) {
    SEGENV.aux0 = hw_random16(SEGLEN); // aux0 stores the random led index
    SEGENV.step = it;
  }

  SEGMENT.setPixelColor(SEGENV.aux0, SEGCOLOR(0));
}

// utility function that will add random glitter to SEGMENT
// (local copy: FX.cpp shares it with Solid Glitter, which lives in another file here)
function glitter_base(intensity: number, col: number = ULTRAWHITE): void {
  if ((intensity & 0xff) > hw_random8()) SEGMENT.setPixelColor(hw_random16(SEGLEN), col);
}

// Glitter with palette background, inspired by https://gist.github.com/kriegsman/062e10f7f07ba8518af6
function mode_glitter(): void {
  if (!SEGMENT.check2) { // use "* Color 1" palette for solid background (replacing "Solid glitter")
    let counter = 0;
    if (SEGMENT.speed !== 0) {
      counter = Math.imul(strip.now, (SEGMENT.speed >> 3) + 1) & 0xffff;
      counter = counter >> 8;
    }

    const noWrap = SEGMENT.speed === 0; // (paletteBlend == 2 || (paletteBlend == 0 && SEGMENT.speed == 0)), paletteBlend is 0
    for (let i = 0; i < SEGLEN; i++) {
      let colorIndex = (Math.trunc((i * 255) / SEGLEN) - counter) >>> 0;
      if (noWrap) colorIndex = map(colorIndex, 0, 255, 0, 240); // cut off blend at palette "end"
      SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(colorIndex, false, true, 255));
    }
  }
  glitter_base(SEGMENT.intensity, SEGCOLOR(2) ? SEGCOLOR(2) : ULTRAWHITE);
}

export const FX1D_B: EffectDef[] = [
  wledEffect({
    meta: 'Scanner@!,Trail,Delay,,,Dual,Bi-delay;!,!,!;!;;m12=0,c1=0',
    mode: mode_larson_scanner,
    category: 'Chase & Running',
    description: 'A light sweeps back and forth along the string leaving a fading trail, like KITT\'s scanner.',
  }),
  wledEffect({
    meta: 'Scanner Dual@!,Trail,Delay,,,Dual,Bi-delay;!,!,!;!;;m12=0,c1=0',
    mode: mode_dual_larson_scanner,
    category: 'Chase & Running',
    description: 'Two scanner lights sweep from opposite ends, crossing in the middle, with fading trails.',
  }),
  wledEffect({
    meta: 'Lighthouse@!,Fade rate;!,!;!',
    mode: mode_comet,
    category: 'Chase & Running',
    description: 'A bright head runs from one end to the other again and again, leaving a fading tail.',
  }),
  wledEffect({
    meta: 'Fire Flicker@!;!;!;01',
    mode: mode_fire_flicker,
    category: 'Fire & Fireworks',
    description: 'Every light flickers randomly in brightness, like candles or embers.',
  }),
  wledEffect({
    meta: 'Gradient@!,Spread;!,!;!;;ix=16',
    mode: mode_gradient,
    category: 'Chase & Running',
    description: 'A soft glowing band of the main colour glides along the background colour.',
    stateful: false,
    history: 1,
  }),
  wledEffect({
    meta: 'Loading@!,Fade;!,!;!;;ix=16',
    mode: mode_loading,
    category: 'Chase & Running',
    description: 'A band of colour moves along with a sharp leading edge and a fading tail, like a loading bar.',
    stateful: false,
    history: 1,
  }),
  wledEffect({
    meta: 'Two Dots@!,Dot size,,,,,Overlay;1,2,Bg;!',
    mode: mode_two_dots,
    category: 'Chase & Running',
    description: 'Two coloured dots chase each other along the string, half a string apart.',
  }),
  wledEffect({
    meta: 'Fairy@!,# of flashers;!,!;!',
    mode: mode_fairy,
    category: 'Twinkle & Sparkle',
    description: 'Fairy lights in mixed palette colours, with evenly spaced bulbs slowly flashing on and off.',
  }),
  wledEffect({
    meta: 'Fairytwinkle@!,!;!,!;!;;m12=0',
    mode: mode_fairytwinkle,
    category: 'Twinkle & Sparkle',
    description: 'Every light shows its own palette colour and gently fades out and back in at random.',
  }),
  wledEffect({
    meta: 'Running Dual@!,Wave width;L,!,R;!',
    mode: mode_running_dual,
    category: 'Chase & Running',
    description: 'Waves of two colours roll towards each other from opposite ends and pass through.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Chase 3@!,Size;1,2,3;!',
    mode: mode_tricolor_chase,
    category: 'Chase & Running',
    description: 'Blocks of three colours march along the string.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'ICU@!,!,,,,,Overlay;!,!;!',
    mode: mode_icu,
    category: 'Chase & Running',
    description: 'A pair of glowing eyes looks around, blinks now and then and darts to a new spot.',
  }),
  wledEffect({
    meta: 'Tri Wipe@!;1,2,3;!',
    mode: mode_tricolor_wipe,
    category: 'Chase & Running',
    description: 'Three colours wipe along the string one after another, each replacing the last.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Tri Fade@!;1,2,3;!',
    mode: mode_tricolor_fade,
    category: 'Basic',
    description: 'The whole string slowly fades from the first colour to the second to the third and back.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Stream 2@!;;',
    mode: mode_random_chase,
    category: 'Chase & Running',
    description: 'A stream of slowly changing random colours flows along the string.',
  }),
  wledEffect({
    meta: 'Oscillate',
    mode: mode_oscillate,
    category: 'Chase & Running',
    description: 'Three bars of colour slide back and forth, mixing where they overlap.',
  }),
  wledEffect({
    meta: 'Lightning@!,!,,,,,Overlay;!,!;!',
    mode: mode_lightning,
    category: 'Fire & Fireworks',
    description: 'Sudden bursts of flashes light up random stretches of the string, like lightning in a storm.',
  }),
  wledEffect({
    meta: 'Pride 2015@!;;',
    mode: mode_pride_2015,
    category: 'Waves & Patterns',
    description: 'Ever-changing rainbows ripple along the string with shifting waves of brightness.',
  }),
  wledEffect({
    meta: 'Colorwaves@!,Hue;!;!;;pal=26',
    mode: mode_colorwaves,
    category: 'Waves & Patterns',
    description: 'Slow waves of palette colour and brightness roll and change shape along the string.',
  }),
  wledEffect({
    meta: 'Juggle@!,Trail;;!;;sx=64,ix=128',
    mode: mode_juggle,
    category: 'Chase & Running',
    description: 'Eight coloured dots weave back and forth, drifting in and out of step, with fading trails.',
  }),
  wledEffect({
    meta: 'Bpm@!;!;!;;sx=64',
    mode: mode_bpm,
    category: 'Waves & Patterns',
    description: 'Stripes of palette colour scroll along while their brightness pulses to a beat.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Tetrix@!,Width,,,,One color;!,!;!;;sx=0,ix=0,pal=11,m12=1',
    mode: mode_tetrix,
    category: 'Chase & Running',
    description: 'Coloured bricks drop down the string and stack up until it is full, then it fades and starts again.',
  }),
  wledEffect({
    meta: 'Fill Noise@!;!;!',
    mode: mode_fillnoise8,
    category: 'Noise & Flow',
    description: 'Blotches of palette colour drift and morph slowly along the string.',
  }),
  wledEffect({
    meta: 'Noise 1@!;!;!;;pal=20',
    mode: mode_noise16_1,
    category: 'Noise & Flow',
    description: 'Busy, swirling bands of palette colour that sway back and forth.',
  }),
  wledEffect({
    meta: 'Noise 2@!;!;!;;pal=43',
    mode: mode_noise16_2,
    category: 'Noise & Flow',
    description: 'Patches of palette colour with dark gaps glide steadily along the string.',
  }),
  wledEffect({
    meta: 'Noise 3@!;!;!;;pal=35',
    mode: mode_noise16_3,
    category: 'Noise & Flow',
    description: 'Patches of palette colour bubble and change in place without moving along.',
  }),
  wledEffect({
    meta: 'Noise 4@!;!;!;;pal=26',
    mode: mode_noise16_4,
    category: 'Noise & Flow',
    description: 'Fine, shimmering speckles of palette colour that constantly shift.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Lake@!;Fx;!',
    mode: mode_lake,
    category: 'Waves & Patterns',
    description: 'Calm, gently rippling colour like moonlight on a lake at night.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Meteor@!,Trail,,,,Gradient,,Smooth;;!;1',
    mode: mode_meteor,
    category: 'Chase & Running',
    description: 'A bright meteor shoots along the string, leaving a sparkling trail that breaks up as it fades.',
  }),
  wledEffect({
    meta: 'Railway@!,Smoothness;1,2;!;;pal=3',
    mode: mode_railway,
    category: 'Chase & Running',
    description: 'Alternate lights swap between two colours back and forth, like a railway crossing signal.',
  }),
  wledEffect({
    meta: 'Twinklefox@!,Twinkle rate,,,,Cool;!,!;!',
    mode: mode_twinklefox,
    category: 'Twinkle & Sparkle',
    description: 'Holiday twinkle lights in palette colours that gently fade in and out, warming to red as they dim.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Twinklecat@!,Twinkle rate,,,,Cool,Reverse;!,!;!',
    mode: mode_twinklecat,
    category: 'Twinkle & Sparkle',
    description: 'Twinkle lights in palette colours that switch on instantly and then fade away.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Solid Pattern@Fg size,Bg size;Fg,!;!;;pal=0',
    mode: mode_static_pattern,
    category: 'Basic',
    description: 'A still pattern of lit groups and background-coloured gaps, with adjustable sizes.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Solid Pattern Tri@,Size;1,2,3;;;pal=0',
    mode: mode_tri_static_pattern,
    category: 'Basic',
    description: 'A still pattern of repeating blocks in three colours.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Spots@Spread,Width,,,,,Overlay;!,!;!',
    mode: mode_spots,
    category: 'Waves & Patterns',
    description: 'Evenly spaced soft spots of light glow on the background colour.',
  }),
  wledEffect({
    meta: 'Spots Fade@Spread,Width,,,,,Overlay;!,!;!',
    mode: mode_spots_fade,
    category: 'Waves & Patterns',
    description: 'Evenly spaced spots of light that swell and shrink, breathing in and out.',
  }),
  wledEffect({
    meta: 'Sparkle@!,,,,,,Overlay;!,!;!;;m12=0',
    mode: mode_sparkle,
    category: 'Twinkle & Sparkle',
    description: 'A single light flashes at a random spot, then another, over the background colour.',
  }),
  wledEffect({
    meta: 'Glitter@!,!,,,,,Overlay;,,Glitter color;!;;pal=11,m12=0',
    mode: mode_glitter,
    category: 'Twinkle & Sparkle',
    description: 'A slowly scrolling palette rainbow sprinkled with white glitter flashes.',
  }),
];
