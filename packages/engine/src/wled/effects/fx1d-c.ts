// Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/FX.cpp. Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.

import type { EffectDef } from '../../effects.js';
import {
  B, BLACK, BLUE, CHSV, CRGB, CYAN, G, R, RED, RGBW32, ULTRAWHITE, W, WHITE, YELLOW,
  color_blend, color_fade, crgbAdd, gamma8inv, getRGBaverage,
} from '../color.js';
import { wledEffect } from '../define.js';
import {
  PRNG, beat16, beat8, beatsin16_t, beatsin88_t, beatsin8_t, constrain, cos8_t, cubicwave8, hw_random,
  hw_random16, hw_random8, map, millis, perlin16, perlin8, qadd8, qsub8, quadwave8, scale16, scale8,
  sin16_t, sin8_t, triwave16,
} from '../math.js';
import {
  CRGBPalette16, ColorFromPalette, LINEARBLEND, LINEARBLEND_NOWRAP, nblendPaletteTowardPalette, type Palette16,
} from '../palettes.js';
import {
  FRAMETIME, FRAMETIME_FIXED, NUM_COLORS, PALETTE_SOLID_WRAP, SEGCOLOR, SEGENV, SEGLEN, SEGMENT, SEGPALETTE,
  indexToVStrip, strip,
} from '../segment.js';

const fr = Math.fround;

/** FX_FALLBACK_STATIC */
function fallbackStatic(): void { SEGMENT.fill(SEGCOLOR(0)); }

// FX.h: FAIR_DATA_PER_SEG = MAX_SEGMENT_DATA / MAX_NUM_SEGMENTS (ESP32 without PSRAM: 64k / 32).
// strip.getMaxSegments() is MAX_NUM_SEGMENTS in WLED (our runtime returns 1), so the controller's value is used here.
const MAX_NUM_SEGMENTS = 32;
const FAIR_DATA_PER_SEG = Math.trunc((64 * 1024) / MAX_NUM_SEGMENTS);

/** C float -> unsigned conversion (values below zero wrap through int). */
const f2u = (v: number): number => Math.trunc(v) >>> 0;

// scratch for reinterpreting uint32 <-> float bits (constant cache, no state between frames)
const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
const bitsToFloat = (u: number): number => { U32[0] = u >>> 0; return F32[0]!; };
const floatToBits = (f: number): number => { F32[0] = f; return U32[0]!; };

// ---------------------------------------------------------------------------------------------
// Dynamic Smooth
// ---------------------------------------------------------------------------------------------

/*
 * Lights every LED in a random color. Changes all LED at the same time
 * to new random colors.
 */
function mode_dynamic(): void {
  if (!SEGENV.allocateData(SEGLEN)) { fallbackStatic(); return; }
  const data = SEGENV.data;

  if (SEGENV.call === 0) {
    for (let i = 0; i < SEGLEN; i++) data[i] = hw_random8();
  }

  const cycleTime = 50 + (255 - SEGMENT.speed) * 15;
  const it = Math.trunc(strip.now / cycleTime) >>> 0;
  if (it !== SEGENV.step && SEGMENT.speed !== 0) { // new color
    for (let i = 0; i < SEGLEN; i++) {
      if (hw_random8() <= SEGMENT.intensity) data[i] = hw_random8(); // random color index
    }
    SEGENV.step = it;
  }

  if (SEGMENT.check1) {
    for (let i = 0; i < SEGLEN; i++) SEGMENT.blendPixelColor(i, SEGMENT.color_wheel(data[i]!), 16);
  } else {
    for (let i = 0; i < SEGLEN; i++) SEGMENT.setPixelColor(i, SEGMENT.color_wheel(data[i]!));
  }
}

/*
 * effect "Dynamic" with smooth color-fading
 */
function mode_dynamic_smooth(): void {
  const old = SEGMENT.check1;
  SEGMENT.check1 = true;
  mode_dynamic();
  SEGMENT.check1 = old;
}

// ---------------------------------------------------------------------------------------------
// Multi Comet
// ---------------------------------------------------------------------------------------------

/*
 * Creates random comets
 * Custom mode by Keith Lord: https://github.com/kitesurfer1404/WS2812FX/blob/master/src/custom/MultiComet.h
 */
const MAX_COMETS = 8;
function mode_multi_comet(): void {
  const cycleTime = 10 + (255 - SEGMENT.speed);
  const it = Math.trunc(strip.now / cycleTime) >>> 0;
  if (SEGENV.step === it) return;
  if (!SEGENV.allocateData(2 * MAX_COMETS)) { fallbackStatic(); return; }

  SEGMENT.fade_out((SEGMENT.intensity >> 1) + 128);

  const comets = SEGENV.view(Uint16Array);

  for (let i = 0; i < MAX_COMETS; i++) {
    if (comets[i]! < SEGLEN) {
      const index = comets[i]!;
      if (SEGCOLOR(2) !== 0) {
        SEGMENT.setPixelColor(index, i % 2 ? SEGMENT.color_from_palette(index, true, PALETTE_SOLID_WRAP, 0) : SEGCOLOR(2));
      } else {
        SEGMENT.setPixelColor(index, SEGMENT.color_from_palette(index, true, PALETTE_SOLID_WRAP, 0));
      }
      comets[i] = comets[i]! + 1;
    } else {
      if (!hw_random16(SEGLEN)) comets[i] = 0;
    }
  }

  SEGENV.step = it;
}

// ---------------------------------------------------------------------------------------------
// Bouncing Balls
// ---------------------------------------------------------------------------------------------

// struct Ball { unsigned long lastBounceTime; float impactVelocity; float height; } -> 12 bytes:
// u32[3i] lastBounceTime, f32[3i+1] impactVelocity, f32[3i+2] height
const MAX_NUM_BALLS = 16;
const GRAVITY = fr(-9.81);
function mode_bouncing_balls(): void {
  if (SEGLEN <= 1) { fallbackStatic(); return; }
  const strips = SEGMENT.nrOfVStrips();
  const dataSize = 12 * MAX_NUM_BALLS;
  if (!SEGENV.allocateData(dataSize * strips)) { fallbackStatic(); return; }

  const u32 = SEGENV.view(Uint32Array);
  const f32 = SEGENV.view(Float32Array);

  if (!SEGMENT.check2) SEGMENT.fill(SEGCOLOR(2) ? BLACK : SEGCOLOR(1));

  for (let stripNr = 0; stripNr < strips; stripNr++) {
    const o = stripNr * MAX_NUM_BALLS * 3;
    // number of balls based on intensity setting to max of 7 (cycles colors)
    const numBalls = Math.trunc((SEGMENT.intensity * (MAX_NUM_BALLS - 1)) / 255) + 1; // minimum 1 ball
    const hasCol2 = SEGCOLOR(2) !== 0;
    const time = strip.now;

    if (SEGENV.call === 0) {
      for (let i = 0; i < MAX_NUM_BALLS; i++) u32[o + i * 3] = time;
    }

    for (let i = 0; i < numBalls; i++) {
      const b = o + i * 3;
      const timeSinceLastBounce = fr(Math.trunc(((time - u32[b]!) >>> 0) / (Math.trunc((255 - SEGMENT.speed) / 64) + 1)));
      const timeSec = fr(timeSinceLastBounce / 1000);
      f32[b + 2] = fr(fr(fr(fr(0.5 * GRAVITY) * timeSec) + f32[b + 1]!) * timeSec);

      if (f32[b + 2]! <= 0) {
        f32[b + 2] = 0;
        // damping for better effect using multiple balls
        const dampening = fr(fr(0.9) - fr(i / (numBalls * numBalls)));
        f32[b + 1] = fr(dampening * f32[b + 1]!);
        u32[b] = time;

        if (f32[b + 1]! < fr(0.015)) {
          const impactVelocityStart = fr(fr(fr(Math.sqrt(fr(-2 * GRAVITY))) * hw_random8(5, 11)) / 10); // randomize impact velocity
          f32[b + 1] = impactVelocityStart;
        }
      } else if (f32[b + 2]! > 1) {
        continue; // do not draw OOB ball
      }

      let color = SEGCOLOR(0);
      if (SEGMENT.palette) {
        color = SEGMENT.color_wheel(i * Math.trunc(256 / Math.max(numBalls, 8)));
      } else if (hasCol2) {
        color = SEGCOLOR(i % NUM_COLORS);
      }

      const pos = Math.round(fr(f32[b + 2]! * (SEGLEN - 1))); // roundf, value >= 0
      SEGMENT.setPixelColor(indexToVStrip(pos, stripNr), color); // encode virtual strip into index
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Rolling Balls (WLED_PS_DONT_REPLACE_1D_FX)
// ---------------------------------------------------------------------------------------------

// struct RollingBall { unsigned long lastBounceUpdate; float mass; float velocity; float height; } -> 16 bytes:
// u32[4i] lastBounceUpdate, f32[4i+1] mass, f32[4i+2] velocity, f32[4i+3] height
function mode_rolling_balls(): void {
  const maxNumBalls = 16; // 255/16 + 1
  if (!SEGENV.allocateData(16 * maxNumBalls)) { fallbackStatic(); return; }
  const u32 = SEGENV.view(Uint32Array);
  const f32 = SEGENV.view(Float32Array);
  const LAST = 0, MASS = 1, VEL = 2, HEIGHT = 3;

  // number of balls based on intensity setting to max of 16 (cycles colors)
  const numBalls = (SEGMENT.intensity >> 4) + 1;
  const hasCol2 = SEGCOLOR(2) !== 0;

  if (SEGENV.call === 0) {
    SEGMENT.fill(hasCol2 ? BLACK : SEGCOLOR(1)); // start clean
    for (let i = 0; i < maxNumBalls; i++) {
      const b = i * 4;
      u32[b + LAST] = strip.now;
      f32[b + VEL] = fr(fr(20 * fr(hw_random16(1000, 10000))) / 10000); // number from 1 to 10
      if (hw_random8() < 128) f32[b + VEL] = -f32[b + VEL]!; // 50% chance of reverse direction
      f32[b + HEIGHT] = fr(fr(hw_random16(0, 10000)) / 10000); // from 0. to 1.
      f32[b + MASS] = fr(fr(hw_random16(1000, 10000)) / 10000); // from .1 to 1.
    }
  }

  const cfac = fr(fr(scale8(8, 255 - SEGMENT.speed) + 1) * 20000); // Aircoookie conversion factor for scaling time using speed slider

  if (SEGMENT.check3) SEGMENT.fade_out(250); // 2-8 pixel trails (optional)
  else if (!SEGMENT.check2) SEGMENT.fill(hasCol2 ? BLACK : SEGCOLOR(1)); // don't fill with background color if user wants to see trails

  for (let i = 0; i < numBalls; i++) {
    const bi = i * 4;
    const timeSinceLastUpdate = fr(fr((strip.now - u32[bi + LAST]!) >>> 0) / cfac);
    let thisHeight = fr(f32[bi + HEIGHT]! + fr(f32[bi + VEL]! * timeSinceLastUpdate)); // this method keeps higher resolution
    // test if intensity level was increased and some balls are way off the track then put them back
    if (thisHeight < -0.5 || thisHeight > 1.5) {
      thisHeight = f32[bi + HEIGHT] = fr(fr(hw_random16(0, 10000)) / 10000); // from 0. to 1.
      u32[bi + LAST] = strip.now;
    }
    // check if reached ends of the strip
    if ((thisHeight <= 0 && f32[bi + VEL]! < 0) || (thisHeight >= 1 && f32[bi + VEL]! > 0)) {
      f32[bi + VEL] = -f32[bi + VEL]!; // reverse velocity
      u32[bi + LAST] = strip.now;
      f32[bi + HEIGHT] = thisHeight;
    }
    // check for collisions
    if (SEGMENT.check1) {
      for (let j = i + 1; j < numBalls; j++) {
        const bj = j * 4;
        if (f32[bj + VEL] !== f32[bi + VEL]) {
          // tcollided + balls[j].lastBounceUpdate is actual time of collision
          const dLast = fr((u32[bj + LAST]! - u32[bi + LAST]!) >>> 0); // unsigned long difference
          const tcollided = fr(fr(fr(cfac * fr(f32[bi + HEIGHT]! - f32[bj + HEIGHT]!)) + fr(f32[bi + VEL]! * dLast))
            / fr(f32[bj + VEL]! - f32[bi + VEL]!));

          if (tcollided > 2 && tcollided < fr((strip.now - u32[bj + LAST]!) >>> 0)) { // 2ms minimum to avoid duplicate bounces
            f32[bi + HEIGHT] = fr(f32[bi + HEIGHT]! + fr(fr(f32[bi + VEL]! * fr(tcollided + dLast)) / cfac));
            f32[bj + HEIGHT] = f32[bi + HEIGHT]!;
            u32[bi + LAST] = (f2u(fr(tcollided + 0.5)) + u32[bj + LAST]!) >>> 0;
            u32[bj + LAST] = u32[bi + LAST]!;
            const vtmp = f32[bi + VEL]!;
            const mi = f32[bi + MASS]!, mj = f32[bj + MASS]!;
            f32[bi + VEL] = fr(fr(fr(fr(mi - mj) * vtmp) + fr(fr(2 * mj) * f32[bj + VEL]!)) / fr(mi + mj));
            f32[bj + VEL] = fr(fr(fr(fr(mj - mi) * f32[bj + VEL]!) + fr(fr(2 * mi) * vtmp)) / fr(mi + mj));
            thisHeight = fr(f32[bi + HEIGHT]! + fr(fr(f32[bi + VEL]! * fr((strip.now - u32[bi + LAST]!) >>> 0)) / cfac));
          }
        }
      }
    }

    let color = SEGCOLOR(0);
    if (SEGMENT.palette) {
      color = SEGMENT.color_from_palette(Math.trunc((i * 255) / numBalls), false, PALETTE_SOLID_WRAP, 0);
    } else if (hasCol2) {
      color = SEGCOLOR(i % NUM_COLORS);
    }

    if (thisHeight < 0) thisHeight = 0;
    if (thisHeight > 1) thisHeight = 1;
    const pos = Math.round(fr(thisHeight * (SEGLEN - 1)));
    SEGMENT.setPixelColor(pos, color);
    u32[bi + LAST] = strip.now;
    f32[bi + HEIGHT] = thisHeight;
  }
}

// ---------------------------------------------------------------------------------------------
// PacMan
// ---------------------------------------------------------------------------------------------

/*
/  Pac-Man by Bob Loeffler with help from @dedehai and @blazoncek
*/
// struct PacManChars { int pos; int topPos; uint32_t color; bool direction; bool blue; bool eaten; } -> 16 bytes:
// i32[4k] pos, i32[4k+1] topPos, u32[4k+2] color, u8[16k+12] direction, u8[16k+13] blue, u8[16k+14] eaten
const ORANGEYELLOW = 0xffcc00;
const PURPLEISH = 0xb000b0;
const ORANGEISH = 0xff8800;
const WHITEISH = 0x999999;
const ghostColors = [RED, PURPLEISH, CYAN, ORANGEISH];
function mode_pacman(): void {
  const PACMAN = 0; // PacMan is character[0]

  const maxPowerDots = Math.min(Math.trunc(SEGLEN / 10), 255); // cap the max so packed state fits in 8 bits
  const numPowerDots = map(SEGMENT.intensity, 0, 255, 1, maxPowerDots) >>> 0;
  const numGhosts = map(SEGMENT.custom3, 0, 31, 2, 8) >>> 0;
  const smearMode = SEGMENT.check2;

  // Pack two 8-bit values into one 16-bit field (stored in SEGENV.aux0)
  const combined_value = (((numPowerDots & 0xff) << 8) | (numGhosts & 0xff)) & 0xffff;
  if (combined_value !== SEGENV.aux0) SEGENV.call = 0; // Reinitialize on setting change
  SEGENV.aux0 = combined_value;

  // Allocate segment data
  const dataSize = 16 * (numGhosts + maxPowerDots + 1); // +1 is the PacMan character
  if (SEGLEN <= 16 + 2 * numGhosts || !SEGENV.allocateData(dataSize)) { fallbackStatic(); return; }
  const i32 = SEGENV.view(Int32Array);
  const u32 = SEGENV.view(Uint32Array);
  const u8 = SEGENV.data;
  const POS = (k: number) => k * 4, TOP = (k: number) => k * 4 + 1, COL = (k: number) => k * 4 + 2;
  const DIR = (k: number) => k * 16 + 12, BLUEF = (k: number) => k * 16 + 13, EATEN = (k: number) => k * 16 + 14;

  // Calculate when blue ghosts start blinking.
  let maxBlinkPos = SEGENV.call === 0 ? SEGLEN - 1 : i32[TOP(PACMAN)]!;
  if (maxBlinkPos < 20) maxBlinkPos = 20;
  const startBlinkingGhostsLED = SEGLEN < 64 ? Math.trunc(SEGLEN / 3) : map(SEGMENT.custom1, 0, 255, 20, maxBlinkPos);

  // Initialize characters on first call
  if (SEGENV.call === 0) {
    u32[COL(PACMAN)] = YELLOW;
    i32[POS(PACMAN)] = 0;
    i32[TOP(PACMAN)] = 0;
    u8[DIR(PACMAN)] = 1;
    u8[BLUEF(PACMAN)] = 0;

    // Initialize ghosts with alternating colors
    for (let i = 1; i <= numGhosts; i++) {
      u32[COL(i)] = ghostColors[(i - 1) % 4]!;
      i32[POS(i)] = -2 * (i + 1);
      u8[DIR(i)] = 1;
      u8[BLUEF(i)] = 0;
    }

    // Initialize power dots
    for (let i = 0; i < numPowerDots; i++) {
      u32[COL(i + numGhosts + 1)] = ORANGEYELLOW;
      u8[EATEN(i + numGhosts + 1)] = 0;
    }
    i32[POS(numGhosts + 1)] = SEGLEN - 1; // Last power dot at end
  }

  if (strip.now > SEGENV.step) {
    SEGENV.step = strip.now;
    SEGENV.aux1++;
  }

  // Clear background if not in smear mode
  if (!smearMode) SEGMENT.fill(BLACK);

  // Draw white dots in front of PacMan if option selected
  if (SEGMENT.check1) {
    const step = SEGMENT.check3 ? 1 : 2; // Compact or spaced dots
    for (let i = SEGLEN - 1; i > i32[TOP(PACMAN)]!; i -= step) SEGMENT.setPixelColor(i, WHITEISH);
  }

  // Update power dot positions dynamically
  const everyXLeds = Math.trunc((((SEGLEN - 10) << 8) >>> 0) / numPowerDots) >>> 0; // fixed-point spacing
  for (let i = 1; i < numPowerDots; i++) {
    i32[POS(i + numGhosts + 1)] = 10 + ((Math.imul(i, everyXLeds) >>> 0) >>> 8);
  }

  // Blink power dots every 10 ticks
  if (SEGENV.aux1 % 10 === 0) {
    const dotColor = u32[COL(numGhosts + 1)] === ORANGEYELLOW ? BLACK : ORANGEYELLOW;
    for (let i = 0; i < numPowerDots; i++) u32[COL(i + numGhosts + 1)] = dotColor;
  }

  // Blink blue ghosts when nearing start
  if (SEGENV.aux1 % 15 === 0 && u8[BLUEF(1)] && i32[POS(PACMAN)]! <= startBlinkingGhostsLED) {
    const ghostColor = u32[COL(1)] === BLUE ? WHITEISH : BLUE;
    for (let i = 1; i <= numGhosts; i++) u32[COL(i)] = ghostColor;
  }

  // Draw uneaten power dots
  for (let i = 0; i < numPowerDots; i++) {
    const k = i + numGhosts + 1;
    if (!u8[EATEN(k)] && (i32[POS(k)]! >>> 0) < SEGLEN) SEGMENT.setPixelColor(i32[POS(k)]!, u32[COL(k)]!);
  }

  // Check if PacMan ate a power dot
  for (let j = 0; j < numPowerDots; j++) {
    const dot = j + numGhosts + 1;
    if (i32[POS(PACMAN)] === i32[POS(dot)] && !u8[EATEN(dot)]) {
      // Reverse all characters - PacMan now chases ghosts
      for (let i = 0; i <= numGhosts; i++) u8[DIR(i)] = 0;
      // Turn ghosts blue
      for (let i = 1; i <= numGhosts; i++) { u32[COL(i)] = BLUE; u8[BLUEF(i)] = 1; }
      u8[EATEN(dot)] = 1;
      break; // only one power dot per frame
    }
  }

  // Reset when PacMan reaches start with blue ghosts
  if (u8[BLUEF(1)] && i32[POS(PACMAN)]! <= 0) {
    for (let i = 0; i <= numGhosts; i++) u8[DIR(i)] = 1;
    for (let i = 1; i <= numGhosts; i++) { u32[COL(i)] = ghostColors[(i - 1) % 4]!; u8[BLUEF(i)] = 0; }
    // Reset power dots if last one was eaten
    if (u8[EATEN(numGhosts + 1)]) {
      for (let i = 0; i < numPowerDots; i++) u8[EATEN(i + numGhosts + 1)] = 0;
      i32[TOP(PACMAN)] = 0;
    }
  }

  // Update and draw characters based on speed setting
  const updatePositions = SEGENV.aux1 % map(SEGMENT.speed, 0, 255, 15, 1) === 0;

  if (updatePositions) {
    i32[POS(PACMAN)] = i32[POS(PACMAN)]! + (u8[DIR(PACMAN)] ? 1 : -1);
    for (let i = 1; i <= numGhosts; i++) i32[POS(i)] = i32[POS(i)]! + (u8[DIR(i)] ? 1 : -1);
  }

  // Draw PacMan
  if ((i32[POS(PACMAN)]! >>> 0) < SEGLEN) SEGMENT.setPixelColor(i32[POS(PACMAN)]!, u32[COL(PACMAN)]!);

  // Draw ghosts
  for (let i = 1; i <= numGhosts; i++) {
    if ((i32[POS(i)]! >>> 0) < SEGLEN) SEGMENT.setPixelColor(i32[POS(i)]!, u32[COL(i)]!);
  }

  // Track farthest position of PacMan
  if (i32[TOP(PACMAN)]! < i32[POS(PACMAN)]!) i32[TOP(PACMAN)] = i32[POS(PACMAN)]!;

  SEGMENT.blur(SEGMENT.custom2 >> 1);
}

// ---------------------------------------------------------------------------------------------
// Sinelon
// ---------------------------------------------------------------------------------------------

/*
* Sinelon stolen from FASTLED examples
*/
function sinelon_base(dual: boolean, rainbow = false): void {
  if (SEGLEN <= 1) { fallbackStatic(); return; }
  SEGMENT.fade_out(SEGMENT.intensity);
  const pos = beatsin16_t(Math.trunc(SEGMENT.speed / 10), 0, SEGLEN - 1);
  if (SEGENV.call === 0) SEGENV.aux0 = pos;
  let color1 = SEGMENT.color_from_palette(pos, true, false, 0);
  let color2 = SEGCOLOR(2);
  if (rainbow) color1 = SEGMENT.color_wheel((pos & 0x07) * 32);
  SEGMENT.setPixelColor(pos, color1);
  if (dual) {
    if (!color2) color2 = SEGMENT.color_from_palette(pos, true, false, 0);
    if (rainbow) color2 = color1; // rainbow
    SEGMENT.setPixelColor(SEGLEN - 1 - pos, color2);
  }
  if (SEGENV.aux0 !== pos) {
    if (SEGENV.aux0 < pos) {
      for (let i = SEGENV.aux0; i < pos; i++) {
        SEGMENT.setPixelColor(i, color1);
        if (dual) SEGMENT.setPixelColor(SEGLEN - 1 - i, color2);
      }
    } else {
      for (let i = SEGENV.aux0; i > pos; i--) {
        SEGMENT.setPixelColor(i, color1);
        if (dual) SEGMENT.setPixelColor(SEGLEN - 1 - i, color2);
      }
    }
    SEGENV.aux0 = pos;
  }
}

function mode_sinelon(): void { sinelon_base(false); }
function mode_sinelon_dual(): void { sinelon_base(true); }
function mode_sinelon_rainbow(): void { sinelon_base(false, true); }

// ---------------------------------------------------------------------------------------------
// Solid Glitter
// ---------------------------------------------------------------------------------------------

// utility function that will add random glitter to SEGMENT
function glitter_base(intensity: number, col: number = ULTRAWHITE): void {
  if ((intensity & 0xff) > hw_random8()) SEGMENT.setPixelColor(hw_random16(SEGLEN), col);
}

// Solid colour background with glitter (can be replaced by Glitter)
function mode_solid_glitter(): void {
  SEGMENT.fill(SEGCOLOR(0));
  glitter_base(SEGMENT.intensity, SEGCOLOR(2) ? SEGCOLOR(2) : ULTRAWHITE);
}

// ---------------------------------------------------------------------------------------------
// Popcorn, Drip (struct Spark)
// ---------------------------------------------------------------------------------------------

// struct Spark { float pos, posX; float vel, velX; uint16_t col; uint8_t colIndex; } -> 20 bytes:
// f32[5k] pos, f32[5k+1] posX, f32[5k+2] vel, f32[5k+3] velX, u16[10k+8] col, u8[20k+18] colIndex
const SPARK_SIZE = 20;
const maxNumPopcorn = 21;

/*
*  POPCORN
*  modified from https://github.com/kitesurfer1404/WS2812FX/blob/master/src/custom/Popcorn.h
*/
function mode_popcorn(): void {
  if (SEGLEN <= 1) { fallbackStatic(); return; }
  const strips = SEGMENT.nrOfVStrips();
  let usablePopcorns = maxNumPopcorn;
  if (usablePopcorns * strips * SPARK_SIZE > FAIR_DATA_PER_SEG) usablePopcorns = Math.trunc(FAIR_DATA_PER_SEG / (strips * SPARK_SIZE)) + 1; // at least 1 popcorn per vstrip
  const dataSize = SPARK_SIZE * usablePopcorns;
  if (!SEGENV.allocateData(dataSize * strips)) { fallbackStatic(); return; }

  const f32 = SEGENV.view(Float32Array);
  const u8 = SEGENV.data;

  const hasCol2 = SEGCOLOR(2) !== 0;
  if (!SEGMENT.check2) SEGMENT.fill(hasCol2 ? BLACK : SEGCOLOR(1));

  for (let stripNr = 0; stripNr < strips; stripNr++) {
    const base = stripNr * usablePopcorns;
    let gravity = fr(fr(-0.0001) - fr(SEGMENT.speed / 200000)); // m/s/s
    gravity = fr(gravity * SEGLEN);

    let numPopcorn = Math.trunc((SEGMENT.intensity * usablePopcorns) / 255);
    if (numPopcorn === 0) numPopcorn = 1;

    for (let i = 0; i < numPopcorn; i++) {
      const k = base + i, p = k * 5, ci = k * SPARK_SIZE + 18;
      if (f32[p]! >= 0) { // if kernel is active, update its position
        f32[p] = fr(f32[p]! + f32[p + 2]!);
        f32[p + 2] = fr(f32[p + 2]! + gravity);
      } else { // if kernel is inactive, randomly pop it
        if (hw_random8() < 2) { // POP!!!
          f32[p] = fr(0.01);

          let peakHeight = 128 + hw_random8(128); // 0-255
          peakHeight = (peakHeight * (SEGLEN - 1)) >> 8;
          f32[p + 2] = fr(Math.sqrt(fr(fr(-2 * gravity) * peakHeight)));

          if (SEGMENT.palette) {
            u8[ci] = hw_random8();
          } else {
            let col = hw_random8(0, NUM_COLORS);
            if (!SEGCOLOR(2) || !SEGCOLOR(col)) col = 0;
            u8[ci] = col;
          }
        }
      }
      if (f32[p]! >= 0) { // draw now active popcorn (either active before or just popped)
        let col = SEGMENT.color_wheel(u8[ci]!);
        if (!SEGMENT.palette && u8[ci]! < NUM_COLORS) col = SEGCOLOR(u8[ci]!);
        const ledIndex = f2u(f32[p]!);
        if (ledIndex < SEGLEN) SEGMENT.setPixelColor(indexToVStrip(ledIndex, stripNr), col);
      }
    }
  }
}

/*
 * Drip Effect
 * ported of: https://www.youtube.com/watch?v=sru2fXh4r7k
 */
function mode_drip(): void {
  if (SEGLEN <= 1) { fallbackStatic(); return; }
  const strips = SEGMENT.nrOfVStrips();
  const maxNumDrops = 4;
  const dataSize = SPARK_SIZE * maxNumDrops;
  if (!SEGENV.allocateData(dataSize * strips)) { fallbackStatic(); return; }
  const f32 = SEGENV.view(Float32Array);
  const u16 = SEGENV.view(Uint16Array);
  const u8 = SEGENV.data;

  if (!SEGMENT.check2) SEGMENT.fill(SEGCOLOR(1));

  for (let stripNr = 0; stripNr < strips; stripNr++) {
    const numDrops = 1 + (SEGMENT.intensity >> 6); // 255>>6 = 3

    let gravity = fr(fr(-0.0005) - fr(SEGMENT.speed / 50000));
    gravity = fr(gravity * Math.max(1, SEGLEN - 1));
    const sourcedrop = 12;

    for (let j = 0; j < numDrops; j++) {
      const k = stripNr * maxNumDrops + j;
      const P = k * 5, V = k * 5 + 2, C = k * 10 + 8, S = k * SPARK_SIZE + 18;
      if (u8[S] === 0) { // init
        f32[P] = SEGLEN - 1; // start at end
        f32[V] = 0; // speed
        u16[C] = sourcedrop; // brightness
        u8[S] = 1; // drop state (0 init, 1 forming, 2 falling, 5 bouncing)
      }

      SEGMENT.setPixelColor(indexToVStrip(SEGLEN - 1, stripNr), color_blend(BLACK, SEGCOLOR(0), sourcedrop)); // water source
      if (u8[S] === 1) {
        if (u16[C]! > 255) u16[C] = 255;
        SEGMENT.setPixelColor(indexToVStrip(f2u(f32[P]!) & 0xffff, stripNr), color_blend(BLACK, SEGCOLOR(0), u16[C]! & 0xff));

        u16[C] = u16[C]! + map(SEGMENT.speed, 0, 255, 1, 6); // swelling

        if (hw_random8() < Math.trunc(u16[C]! / 10)) { // random drop
          u8[S] = 2; // fall
          u16[C] = 255;
        }
      }
      if (u8[S]! > 1) { // falling
        if (f32[P]! > 0) { // fall until end of segment
          f32[P] = fr(f32[P]! + f32[V]!);
          if (f32[P]! < 0) f32[P] = 0;
          f32[V] = fr(f32[V]! + gravity); // gravity is negative

          for (let i = 1; i < 7 - u8[S]!; i++) { // some minor math so we don't expand bouncing droplets
            const pos = constrain((f2u(f32[P]!) + i) >>> 0, 0, SEGLEN - 1); // this is BAD, returns a pos >= SEGLEN occasionally
            SEGMENT.setPixelColor(indexToVStrip(pos, stripNr), color_blend(BLACK, SEGCOLOR(0), Math.trunc(u16[C]! / i) & 0xff)); // spread pixel with fade while falling
          }

          if (u8[S]! > 2) { // during bounce, some water is on the floor
            SEGMENT.setPixelColor(indexToVStrip(0, stripNr), color_blend(SEGCOLOR(0), BLACK, u16[C]! & 0xff));
          }
        } else { // we hit bottom
          if (u8[S]! > 2) { // already hit once, so back to forming
            u8[S] = 0;
            u16[C] = sourcedrop;
          } else {
            if (u8[S] === 2) { // init bounce
              f32[V] = fr(-f32[V]! / 4); // reverse velocity with damping
              f32[P] = fr(f32[P]! + f32[V]!);
            }
            u16[C] = sourcedrop * 2;
            u8[S] = 5; // bouncing
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Candle, Candle Multi
// ---------------------------------------------------------------------------------------------

// values close to 100 produce 5Hz flicker, which looks very candle-y
// Inspired by https://github.com/avanhanegem/ArduinoCandleEffectNeoPixel
// and https://cpldcpu.wordpress.com/2016/01/05/reverse-engineering-a-real-candle/
function candle(multi: boolean): void {
  if (multi && SEGLEN > 1) {
    // allocate segment data
    const dataSize = 4 + Math.max(1, SEGLEN - 1) * 3;
    if (!SEGENV.allocateData(dataSize)) { candle(false); return; } // allocation failed (never here)
  } else {
    const dataSize = 4; // for last call timestamp
    if (!SEGENV.allocateData(dataSize)) { fallbackStatic(); return; }
  }
  const lastcall = SEGENV.view(Uint32Array);
  const candleData = SEGENV.data; // multi-candle data starts at byte 4

  // limit update rate
  if (((strip.now - lastcall[0]!) >>> 0) < FRAMETIME_FIXED) return;
  lastcall[0] = strip.now;

  // max. flicker range controlled by intensity
  const valrange = SEGMENT.intensity;
  const rndval = valrange >> 1; // max 127

  // step (how much to move closer to target per frame) coarsely set by speed
  let speedFactor = 4;
  if (SEGMENT.speed > 252) speedFactor = 1; // epilepsy
  else if (SEGMENT.speed > 99) speedFactor = 2; // regular candle
  else if (SEGMENT.speed > 49) speedFactor = 3; // slower fade

  const numCandles = multi ? SEGLEN : 1;

  for (let i = 0; i < numCandles; i++) {
    let d = 0; // data location

    let s = SEGENV.aux0, s_target = SEGENV.aux1, fadeStep = SEGENV.step;
    if (i > 0) {
      d = 4 + (i - 1) * 3;
      s = candleData[d]!; s_target = candleData[d + 1]!; fadeStep = candleData[d + 2]!;
    }
    if (fadeStep === 0) { // init vals
      s = 128; s_target = 130 + hw_random8(4); fadeStep = 1;
    }

    let newTarget = false;
    if (s_target > s) { // fade up
      s = qadd8(s, fadeStep);
      if (s >= s_target) newTarget = true;
    } else {
      s = qsub8(s, fadeStep);
      if (s <= s_target) newTarget = true;
    }

    if (newTarget) {
      s_target = hw_random8(rndval) + hw_random8(rndval); // between 0 and rndval*2 -2 = 252
      if (s_target < (rndval >> 1)) s_target = (rndval >> 1) + hw_random8(rndval);
      const offset = 255 - valrange;
      s_target += offset;

      const dif = s_target > s ? s_target - s : s - s_target;

      fadeStep = dif >> speedFactor;
      if (fadeStep === 0) fadeStep = 1;
    }

    if (i > 0) {
      SEGMENT.setPixelColor(i, color_blend(SEGCOLOR(1), SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 0), s & 0xff));
      candleData[d] = s; candleData[d + 1] = s_target; candleData[d + 2] = fadeStep;
    } else {
      for (let j = 0; j < SEGLEN; j++) {
        SEGMENT.setPixelColor(j, color_blend(SEGCOLOR(1), SEGMENT.color_from_palette(j, true, PALETTE_SOLID_WRAP, 0), s & 0xff));
      }
      SEGENV.aux0 = s; SEGENV.aux1 = s_target; SEGENV.step = fadeStep;
    }
  }
}

function mode_candle(): void { candle(false); }
function mode_candle_multi(): void { candle(true); }

// ---------------------------------------------------------------------------------------------
// Fireworks Starburst (WLED_PS_DONT_REPLACE_1D_FX)
// ---------------------------------------------------------------------------------------------

/*
/ Fireworks in starburst effect
/ based on the video: https://www.reddit.com/r/arduino/comments/c3sd46/i_made_this_fireworks_effect_for_my_led_strips/
/ Speed sets frequency of new starbursts, intensity is the intensity of the burst
*/
const STARBURST_MAX_FRAG = 10;
// struct particle { CRGB color; uint32_t birth; uint32_t last; float vel; uint16_t pos; float fragment[10]; } -> 60 bytes:
// u32[15j] color (CRGB + pad), u32[15j+1] birth, u32[15j+2] last, f32[15j+3] vel, u16[30j+8] pos, f32[15j+5+i] fragment[i]
const STAR_SIZE = 60;
function mode_starburst(): void {
  if (SEGLEN <= 1) { fallbackStatic(); return; }
  let maxData = FAIR_DATA_PER_SEG;
  const segs = strip.getActiveSegmentsNum();
  if (segs <= MAX_NUM_SEGMENTS / 2) maxData *= 2;
  if (segs <= MAX_NUM_SEGMENTS / 4) maxData *= 2;
  const maxStars = Math.trunc(maxData / STAR_SIZE);

  let numStars = 1 + (SEGLEN >> 3);
  if (numStars > maxStars) numStars = maxStars;
  const dataSize = STAR_SIZE * numStars;

  if (!SEGENV.allocateData(dataSize)) { fallbackStatic(); return; }

  const it = strip.now;

  const u32 = SEGENV.view(Uint32Array);
  const f32 = SEGENV.view(Float32Array);
  const u16 = SEGENV.view(Uint16Array);

  const maxSpeed = 375; // Max velocity
  const particleIgnition = 250; // How long to "flash"
  const particleFadeTime = 1500; // Fade out time

  for (let j = 0; j < numStars; j++) {
    const o = j * 15;
    // speed to adjust chance of a burst, max is nearly always.
    if (hw_random8(144 - (SEGMENT.speed >> 1)) === 0 && u32[o + 1] === 0) {
      // Pick a random color and location.
      const startPos = hw_random16(SEGLEN - 1);
      const multiplier = fr(fr(hw_random8() / 255) * 1);

      u32[o] = SEGMENT.color_wheel(hw_random8()) & 0xffffff;
      u16[j * 30 + 8] = startPos;
      f32[o + 3] = fr(fr(fr(maxSpeed * hw_random8()) / 255) * multiplier);
      u32[o + 1] = it;
      u32[o + 2] = it;
      // more fragments means larger burst effect
      const num = hw_random8(3, 6 + (SEGMENT.intensity >> 5));

      for (let i = 0; i < STARBURST_MAX_FRAG; i++) {
        f32[o + 5 + i] = i < num ? startPos : -1;
      }
    }
  }

  if (!SEGMENT.check2) SEGMENT.fill(SEGCOLOR(1));

  for (let j = 0; j < numStars; j++) {
    const o = j * 15;
    if (u32[o + 1] !== 0) {
      const dt = ((it - u32[o + 2]!) >>> 0) / 1000.0; // double

      for (let i = 0; i < STARBURST_MAX_FRAG; i++) {
        const v = i >> 1;
        if (f32[o + 5 + i]! > 0) {
          // all fragments travel right, will be mirrored on other side
          f32[o + 5 + i] = f32[o + 5 + i]! + ((f32[o + 3]! * dt) * v) / 3.0;
        }
      }
      u32[o + 2] = it;
      f32[o + 3] = f32[o + 3]! - 3 * f32[o + 3]! * dt;
    }

    let c = u32[o]!;

    // If the star is brand new, it flashes white briefly.
    // Otherwise it just fades over time.
    let fade = 0;
    let age = fr((it - u32[o + 1]!) >>> 0);

    if (age < particleIgnition) {
      c = color_blend(WHITE, RGBW32(R(c), G(c), B(c), 0), Math.trunc(fr(254.5 * fr(age / particleIgnition))) & 0xff) & 0xffffff;
    } else {
      // Figure out how much to fade and shrink the star based on its age relative to its lifetime
      if (age > particleIgnition + particleFadeTime) {
        fade = 1; // Black hole, all faded out
        u32[o + 1] = 0;
        c = SEGCOLOR(1) & 0xffffff;
      } else {
        age = fr(age - particleIgnition);
        fade = fr(age / particleFadeTime); // Fading star
        c = color_blend(RGBW32(R(c), G(c), B(c), 0), SEGCOLOR(1), Math.trunc(fr(254.5 * fade)) & 0xff) & 0xffffff;
      }
    }

    const particleSize = fr(fr(1 - fade) * 2);
    const spos = u16[j * 30 + 8]!;

    for (let index = 0; index < STARBURST_MAX_FRAG * 2; index++) {
      const mirrored = index & 0x1;
      const i = index >> 1;
      if (f32[o + 5 + i]! > 0) {
        let loc = f32[o + 5 + i]!;
        if (mirrored) loc = fr(loc - fr(fr(loc - spos) * 2));
        let start = f2u(fr(loc - particleSize));
        let end = f2u(fr(loc + particleSize));
        if (start < 0) start = 0; // never true (unsigned), as in C
        if (start === end) end = (end + 1) >>> 0;
        if (end > SEGLEN) end = SEGLEN;
        for (let p = start; p < end; p++) SEGMENT.setPixelColor(p, c);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Plasma, Percent, Heartbeat
// ---------------------------------------------------------------------------------------------

/*
/ Plasma Effect
/ adapted from https://github.com/atuline/FastLED-Demos/blob/master/plasma/plasma.ino
*/
function mode_plasma(): void {
  // initialize phases on start
  if (SEGENV.call === 0) SEGENV.aux0 = hw_random8(0, 2); // add a bit of randomness
  const thisPhase = beatsin8_t(6 + SEGENV.aux0, -64, 64);
  const thatPhase = beatsin8_t(7 + SEGENV.aux0, -64, 64);

  for (let i = 0; i < SEGLEN; i++) {
    const colorIndex = (cubicwave8((i * (2 + 3 * (SEGMENT.speed >> 5)) + thisPhase) & 0xff) >> 1)
      + (cos8_t((i * (1 + 2 * (SEGMENT.speed >> 5)) + thatPhase) & 0xff) >> 1);
    const thisBright = qsub8(colorIndex, beatsin8_t(7, 0, 128 - (SEGMENT.intensity >> 1)));
    SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(colorIndex, false, PALETTE_SOLID_WRAP, 0, thisBright));
  }
}

/*
 * Percentage display
 * Intensity values from 0-100 turn on the leds.
 */
function mode_percent(): void {
  let percent = SEGMENT.intensity;
  percent = constrain(percent, 0, 200);
  const active_leds = percent < 100 ? Math.round(fr((SEGLEN * percent) / 100)) : Math.round(fr((SEGLEN * (200 - percent)) / 100));

  let size = 1 + ((SEGMENT.speed * SEGLEN) >> 11);
  if (SEGMENT.speed === 255) size = 255;

  if (percent <= 100) {
    for (let i = 0; i < SEGLEN; i++) {
      if (i < SEGENV.aux1) {
        if (SEGMENT.check1) SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(map(percent, 0, 100, 0, 255), false, false, 0));
        else SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 0));
      } else {
        SEGMENT.setPixelColor(i, SEGCOLOR(1));
      }
    }
  } else {
    for (let i = 0; i < SEGLEN; i++) {
      if (i < SEGLEN - SEGENV.aux1) {
        SEGMENT.setPixelColor(i, SEGCOLOR(1));
      } else {
        if (SEGMENT.check1) SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(map(percent, 100, 200, 255, 0), false, false, 0));
        else SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 0));
      }
    }
  }

  if (active_leds > SEGENV.aux1) { // smooth transition to the target value
    SEGENV.aux1 += size;
    if (SEGENV.aux1 > active_leds) SEGENV.aux1 = active_leds;
  } else if (active_leds < SEGENV.aux1) {
    if (SEGENV.aux1 > size) SEGENV.aux1 -= size; else SEGENV.aux1 = 0;
    if (SEGENV.aux1 < active_leds) SEGENV.aux1 = active_leds;
  }
}

/*
 * Modulates the brightness similar to a heartbeat
 */
function mode_heartbeat(): void {
  const bpm = 40 + (SEGMENT.speed >> 3);
  const msPerBeat = Math.trunc(60000 / bpm);
  const secondBeat = Math.trunc(msPerBeat / 3);
  let bri_lower = SEGENV.aux1;
  const beatTimer = (strip.now - SEGENV.step) >>> 0;

  bri_lower = Math.trunc((bri_lower * 2042) / (2048 + SEGMENT.intensity));
  SEGENV.aux1 = bri_lower;

  if (beatTimer > secondBeat && !SEGENV.aux0) { // time for the second beat?
    SEGENV.aux1 = 0xffff; // 3/4 bri
    SEGENV.aux0 = 1;
  }
  if (beatTimer > msPerBeat) { // time to reset the beat timer?
    SEGENV.aux1 = 0xffff; // full bri
    SEGENV.aux0 = 0;
    SEGENV.step = strip.now;
  }

  for (let i = 0; i < SEGLEN; i++) {
    SEGMENT.setPixelColor(i, color_blend(SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 0), SEGCOLOR(1), (255 - (SEGENV.aux1 >> 8)) & 0xff));
  }
}

// ---------------------------------------------------------------------------------------------
// Pacifica
// ---------------------------------------------------------------------------------------------

//  "Pacifica"
//  Gentle, blue-green ocean waves.
//  December 2019, Mark Kriegsman and Mary Corey March.
//  For Dan.
//  Modified for WLED, based on https://github.com/FastLED/FastLED/blob/master/examples/Pacifica/Pacifica.ino
//
// Add one layer of waves into the led array
function pacifica_one_layer(i: number, p: Palette16, cistart: number, wavescale: number, bri: number, ioff: number): number {
  let ci = cistart & 0xffff;
  let waveangle = ioff & 0xffff;
  const wavescale_half = ((wavescale & 0xffff) >> 1) + 20;

  waveangle += (120 + SEGMENT.intensity) * i; // original 250 * i
  const s16 = sin16_t(waveangle) + 32768;
  const cs = scale16(s16, wavescale_half) + wavescale_half;
  ci = (ci + cs * i) >>> 0;
  const sindex16 = sin16_t(ci) + 32768;
  const sindex8 = scale16(sindex16, 240);
  return ColorFromPalette(p, sindex8, bri & 0xff, LINEARBLEND);
}

// palettes are gamma inverted using gamma 2.0 to get closer to pre 16.0 looks
const pacifica_palette_1_def = CRGBPalette16(
  0x002229, 0x001E2F, 0x001934, 0x001938, 0x00143F, 0x001443, 0x00B047, 0x00B04C,
  0x00004F, 0x000054, 0x000062, 0x00006F, 0x00007A, 0x000085, 0x47938A, 0x64D08E);
const pacifica_palette_2_def = CRGBPalette16(
  0x002229, 0x001E2F, 0x001934, 0x001938, 0x00143F, 0x001443, 0x00B047, 0x00B04C,
  0x00004F, 0x000054, 0x000062, 0x00006F, 0x00007A, 0x000085, 0x369B90, 0x4FDC9B);
const pacifica_palette_3_def = CRGBPalette16(
  0x00142C, 0x00193B, 0x002247, 0x002551, 0x002C5A, 0x002F63, 0x00346B, 0x003671,
  0x003B78, 0x003F7F, 0x00478E, 0x004D9C, 0x0054A9, 0x005AB4, 0x3F7FDC, 0x5A9CFF);

function mode_pacifica(): void {
  const nowOld = strip.now;

  let pacifica_palette_1 = pacifica_palette_1_def;
  let pacifica_palette_2 = pacifica_palette_2_def;
  let pacifica_palette_3 = pacifica_palette_3_def;

  if (SEGMENT.palette) {
    pacifica_palette_1 = SEGPALETTE;
    pacifica_palette_2 = SEGPALETTE;
    pacifica_palette_3 = SEGPALETTE;
  }

  // Increment the four "color index start" counters, one for each wave layer.
  // Each is incremented at a different speed, and the speeds vary over time.
  let sCIStart1 = SEGENV.aux0, sCIStart2 = SEGENV.aux1, sCIStart3 = SEGENV.step & 0xffff, sCIStart4 = SEGENV.step >>> 16;
  const deltams = (FRAMETIME >> 2) + ((FRAMETIME * SEGMENT.speed) >> 7);
  const deltat = ((strip.now >>> 2) + ((Math.imul(strip.now, SEGMENT.speed) >>> 0) >>> 7)) >>> 0;
  // Note: in WLED the beat functions below read millis(), not strip.now, so this has no effect on them.
  strip.now = deltat;

  const speedfactor1 = beatsin16_t(3, 179, 269);
  const speedfactor2 = beatsin16_t(4, 179, 269);
  const deltams1 = Math.trunc((deltams * speedfactor1) / 256);
  const deltams2 = Math.trunc((deltams * speedfactor2) / 256);
  const deltams21 = Math.trunc((deltams1 + deltams2) / 2);
  sCIStart1 = (sCIStart1 + deltams1 * beatsin88_t(1011, 10, 13)) >>> 0;
  sCIStart2 = (sCIStart2 - deltams21 * beatsin88_t(777, 8, 11)) >>> 0;
  sCIStart3 = (sCIStart3 - deltams1 * beatsin88_t(501, 5, 7)) >>> 0;
  sCIStart4 = (sCIStart4 - deltams2 * beatsin88_t(257, 4, 6)) >>> 0;
  SEGENV.aux0 = sCIStart1; SEGENV.aux1 = sCIStart2;
  SEGENV.step = ((sCIStart4 << 16) | (sCIStart3 & 0xffff)) >>> 0;

  const basethreshold = beatsin8_t(9, 55, 65);
  let wave = beat8(7);

  for (let i = 0; i < SEGLEN; i++) {
    let c = CRGB(2, 6, 10);
    // Render each of four layers, with different scales and speeds, that vary over time
    c = crgbAdd(c, pacifica_one_layer(i, pacifica_palette_1, sCIStart1, beatsin16_t(3, 11 * 256, 14 * 256), beatsin8_t(10, 70, 130), 0 - beat16(301)));
    c = crgbAdd(c, pacifica_one_layer(i, pacifica_palette_2, sCIStart2, beatsin16_t(4, 6 * 256, 9 * 256), beatsin8_t(17, 40, 80), beat16(401)));
    c = crgbAdd(c, pacifica_one_layer(i, pacifica_palette_3, sCIStart3, 6 * 256, beatsin8_t(9, 10, 38), 0 - beat16(503)));
    c = crgbAdd(c, pacifica_one_layer(i, pacifica_palette_3, sCIStart4, 5 * 256, beatsin8_t(8, 10, 28), beat16(601)));

    // Add extra 'white' to areas where the four layers of light have lined up brightly
    const threshold = scale8(sin8_t(wave), 20) + basethreshold;
    wave += 7;
    const l = getRGBaverage(c);
    if (l > threshold) {
      const overage = l - threshold;
      const overage2 = qadd8(overage, overage);
      c = crgbAdd(c, CRGB(overage, overage2, qadd8(overage2, overage2)));
    }

    SEGMENT.setPixelColor(i, c);
  }

  strip.now = nowOld;
}

// ---------------------------------------------------------------------------------------------
// Sunrise
// ---------------------------------------------------------------------------------------------

/*
 * Mode simulates a gradual sunrise
 */
function mode_sunrise(): void {
  if (SEGLEN <= 1) { fallbackStatic(); return; }
  // speed 0 - static sun
  // speed 1 - 60: sunrise time in minutes
  // speed 60 - 120 : sunset time in minutes - 60;
  // speed above: "breathing" rise and set
  if (SEGENV.call === 0 || SEGMENT.speed !== SEGENV.aux0) {
    // Deviation: WLED saves millis() here (the moment the effect was selected). Our frames are rendered
    // independently of each other, so the start is the origin of the effect clock (millis() == 0).
    SEGENV.step = 0;
    SEGENV.aux0 = SEGMENT.speed;
  }

  SEGMENT.fill(BLACK);
  let stage = 0xffff;

  let s10SinceStart = Math.trunc(((millis() - SEGENV.step) >>> 0) / 100); // tenths of seconds

  if (SEGMENT.speed > 120) { // quick sunrise and sunset
    const counter = Math.imul(strip.now >>> 1, ((SEGMENT.speed - 120) >> 1) + 1) >>> 0;
    stage = triwave16(counter);
  } else if (SEGMENT.speed) { // sunrise
    let durMins = SEGMENT.speed;
    if (durMins > 60) durMins -= 60;
    const s10Target = durMins * 600;
    if (s10SinceStart > s10Target) s10SinceStart = s10Target;
    stage = map(s10SinceStart, 0, s10Target, 0, 0xffff) >>> 0;
    if (SEGMENT.speed > 60) stage = 0xffff - stage; // sunset
  }

  for (let i = 0; i <= SEGLEN >> 1; i++) {
    // default palette is Fire
    let wave = triwave16(Math.trunc((i * stage) / SEGLEN));
    wave = (wave >> 8) + ((wave * SEGMENT.intensity) >> 15);
    let c: number;
    if (wave > 240) c = SEGMENT.color_from_palette(240, false, true, 255); // clipped, full white sun
    else c = SEGMENT.color_from_palette(wave, false, true, 255); // transition
    SEGMENT.setPixelColor(i, c);
    SEGMENT.setPixelColor(SEGLEN - i - 1, c);
  }
}

// ---------------------------------------------------------------------------------------------
// Effects by Andrew Tuline: Phased, Phased Noise, Twinkleup, Noise Pal, Sine
// ---------------------------------------------------------------------------------------------

function phased_base(moder: number): void { // We're making sine waves here. By Andrew Tuline.
  const allfreq = 16; // Base frequency.
  // Phase change value gets calculated (float fits into unsigned long): float *phase = (float*)&SEGENV.step
  let phase = bitsToFloat(SEGENV.step);
  const cutOff = 255 - SEGMENT.intensity; // You can change the number of pixels.
  let modVal = 5; // You can change the modulus.

  let index = (strip.now / 64) >>> 0; // Set color rotation speed
  phase = fr(phase + SEGMENT.speed / 32.0); // You can change the speed of the wave.
  SEGENV.step = floatToBits(phase);

  for (let i = 0; i < SEGLEN; i++) {
    if (moder === 1) modVal = perlin8(i * 10 + i * 10) >> 4; // Let's randomize our mod length with some Perlin noise.
    let val = (i + 1) * allfreq; // This sets the frequency of the waves. The +1 makes sure that led 0 is used.
    if (modVal === 0) modVal = 1;
    val = f2u(fr(val + fr(fr(phase * ((i % modVal) + 1)) / 2))); // This sets the varying phase change of the waves.
    let b = cubicwave8(val); // Now we make an 8 bit sinewave.
    b = b > cutOff ? b - cutOff : 0; // A ternary operator to cutoff the light.
    SEGMENT.setPixelColor(i, color_blend(SEGCOLOR(1), SEGMENT.color_from_palette(index, false, false, 0), b));
    index += Math.trunc(256 / SEGLEN);
    if (SEGLEN > 256) index++; // Correction for segments longer than 256 LEDs
  }
}

function mode_phased(): void { phased_base(0); }
function mode_phased_noise(): void { phased_base(1); }

// FX.cpp: static PRNG prng(hw_random()); twinkleup reseeds it every call and restores it afterwards.
const prng = new PRNG();
function mode_twinkleup(): void { // A very short twinkle routine with fade-in and dual controls. By Andrew Tuline.
  const prevSeed = prng.getSeed(); // save seed so we can restore it at the end of the function
  prng.setSeed(535); // The randomizer needs to be re-set each time through the loop

  const t16 = Math.trunc((Math.imul(16, strip.now) >>> 0) / (256 - SEGMENT.speed));
  const t100 = Math.trunc(strip.now / 100);
  for (let i = 0; i < SEGLEN; i++) {
    const ranstart = prng.random8(); // The starting value (aka brightness) for each pixel.
    let pixBri = sin8_t(ranstart + t16);
    if (prng.random8() > SEGMENT.intensity) pixBri = 0;
    SEGMENT.setPixelColor(i, color_blend(SEGCOLOR(1), SEGMENT.color_from_palette(prng.random8() + t100, false, PALETTE_SOLID_WRAP, 0), pixBri));
  }

  prng.setSeed(prevSeed); // restore original seed so other effects can use "random" PRNG
}

// Peaceful noise that's slow and with gradually changing palettes. Does not support WLED palettes or default colours or controls.
// data: two CRGBPalette16 (palettes[0] current, palettes[1] target), kept as 16 packed colours each.
function mode_noisepal(): void { // Slow noise palette by Andrew Tuline.
  const scale = 15 + (SEGMENT.intensity >> 2); // default was 30

  if (!SEGENV.allocateData(2 * 16 * 4)) { fallbackStatic(); return; }
  const pals = SEGENV.view(Uint32Array);
  const pal0 = pals.subarray(0, 16), pal1 = pals.subarray(16, 32);

  const changePaletteMs = 4000 + SEGMENT.speed * 10; // between 4 - 6.5sec
  if (((strip.now - SEGENV.step) >>> 0) > changePaletteMs) {
    SEGENV.step = strip.now;

    const baseI = hw_random8();
    const minBri = gamma8inv(128); // use gamma inversion on min brightness value to restore pre 16.0 looks
    // (arguments evaluated left to right)
    const c1 = CHSV(baseI + hw_random8(64), 255, hw_random8(minBri, 255));
    const c2 = CHSV(baseI + 128, 255, hw_random8(minBri, 255));
    const c3 = CHSV(baseI + hw_random8(92), 192, hw_random8(minBri, 255));
    const c4 = CHSV(baseI + hw_random8(92), 255, hw_random8(minBri, 255));
    pal1.set(CRGBPalette16(c1, c2, c3, c4));
  }

  nblendPaletteTowardPalette(pal0, pal1, 48); // Blend towards the target palette over 48 iterations.

  if (SEGMENT.palette > 0) pal0.set(SEGPALETTE);

  for (let i = 0; i < SEGLEN; i++) {
    const index = perlin8(i * scale, SEGENV.aux0 + i * scale); // Get a value from the noise function. I'm using both x and y axis.
    SEGMENT.setPixelColor(i, ColorFromPalette(pal0, index, 255, LINEARBLEND)); // Use my own palette.
  }

  SEGENV.aux0 += beatsin8_t(10, 1, 4); // Moving along the distance. Vary it a bit with a sine wave.
}

// Sine waves that have controllable phase change speed, frequency and cutoff. By Andrew Tuline.
function mode_sinewave(): void { // Adjustable sinewave. By Andrew Tuline
  const colorIndex = (strip.now / 32) >>> 0; // Amount of colour change.

  SEGENV.step += SEGMENT.speed >> 4; // Speed of animation.
  const freq = SEGMENT.intensity >> 2; // Frequency of the signal.

  for (let i = 0; i < SEGLEN; i++) {
    const pixBri = cubicwave8(i * freq + SEGENV.step);
    SEGMENT.setPixelColor(i, color_blend(SEGCOLOR(1), SEGMENT.color_from_palette(Math.trunc((Math.imul(i, colorIndex) >>> 0) / 255), false, PALETTE_SOLID_WRAP, 0), pixBri));
  }
}

// ---------------------------------------------------------------------------------------------
// Flow, Chunchun
// ---------------------------------------------------------------------------------------------

/*
 * Best of both worlds from Palette and Spot effects. By Aircoookie
 */
function mode_flow(): void {
  let counter = 0;
  if (SEGMENT.speed !== 0) {
    counter = Math.imul(strip.now, (SEGMENT.speed >> 2) + 1) >>> 0;
    counter = counter >>> 8;
  }

  const maxZones = Math.trunc(SEGLEN / 6); // only looks good if each zone has at least 6 LEDs
  let zones = (SEGMENT.intensity * maxZones) >> 8;
  if (zones & 0x01) zones++; // zones must be even
  if (zones < 2) zones = 2;
  const zoneLen = Math.trunc(SEGLEN / zones);
  if (zoneLen === 0) return; // integer division by zero in C (SEGLEN < 2)
  const requiredZones = Math.trunc((SEGLEN + zoneLen - 1) / zoneLen);
  zones = requiredZones + 2; // add extra zones to cover beginning and end of segment
  const offset = Math.trunc((SEGLEN - zones * zoneLen) / 2); // center the zones on the segment

  for (let z = 0; z < zones; z++) {
    const pos = offset + z * zoneLen;
    for (let i = 0; i < zoneLen; i++) {
      const colorIndex = (Math.trunc((i * 255) / zoneLen) - counter) >>> 0;
      let led = z & 0x01 ? i : zoneLen - 1 - i;
      if (SEGMENT.reverse) led = zoneLen - 1 - led;
      SEGMENT.setPixelColor(pos + led, SEGMENT.color_from_palette(colorIndex, false, true, 255));
    }
  }
}

/*
 * Dots waving around in a sine/pendulum motion.
 * Little pixel birds flying in a circle. By Aircoookie
 */
function mode_chunchun(): void {
  if (SEGLEN <= 1) { fallbackStatic(); return; }
  SEGMENT.fade_out(254); // add a bit of trail
  let counter = Math.imul(strip.now, 6 + (SEGMENT.speed >> 4)) >>> 0;
  const numBirds = 2 + (SEGLEN >> 3); // 2 + 1/8 of a segment
  const span = Math.trunc((SEGMENT.intensity << 8) / numBirds);

  for (let i = 0; i < numBirds; i++) {
    counter = (counter - span) >>> 0;
    const megumin = sin16_t(counter) + 0x8000;
    let bird = (megumin * SEGLEN) >>> 16;
    bird = constrain(bird, 0, SEGLEN - 1);
    SEGMENT.setPixelColor(bird, SEGMENT.color_from_palette(Math.trunc((i * 255) / numBirds), false, false, 0)); // no palette wrapping
  }
}

// ---------------------------------------------------------------------------------------------
// Dancing Shadows (WLED_PS_DONT_REPLACE_1D_FX)
// ---------------------------------------------------------------------------------------------

const SPOT_TYPE_SOLID = 0, SPOT_TYPE_GRADIENT = 1, SPOT_TYPE_2X_GRADIENT = 2, SPOT_TYPE_2X_DOT = 3, SPOT_TYPE_3X_DOT = 4, SPOT_TYPE_4X_DOT = 5;
const SPOT_TYPES_COUNT = 6;
const SPOT_MAX_COUNT = 49; // Number of simultaneous waves (ESP32)

/** ((start + j) >= 0 && (start + j) < SEGLEN) with size_t j: an unsigned comparison. */
const inSeg = (p: number): boolean => (p >>> 0) < SEGLEN;

// struct Spotlight { float speed; uint8_t colorIdx; int16_t position; unsigned long lastUpdateTime; uint8_t width; uint8_t type; } -> 16 bytes:
// f32[4i] speed, u8[16i+4] colorIdx, i16[8i+3] position, u32[4i+2] lastUpdateTime, u8[16i+12] width, u8[16i+13] type

/*
 * Spotlights moving back and forth that cast dancing shadows.
 * Shine this through tree branches/leaves or other close-up objects that cast
 * interesting shadows onto a ceiling or tarp.
 *
 * By Steve Pomeroy @xxv
 */
function mode_dancing_shadows(): void {
  if (SEGLEN <= 1) { fallbackStatic(); return; }
  const numSpotlights = map(SEGMENT.intensity, 0, 255, 2, SPOT_MAX_COUNT); // 49 on 32 segment ESP32
  const initialize = SEGENV.aux0 !== numSpotlights;
  SEGENV.aux0 = numSpotlights;

  const dataSize = 16 * numSpotlights;
  if (!SEGENV.allocateData(dataSize)) { fallbackStatic(); return; }
  const f32 = SEGENV.view(Float32Array);
  const u32 = SEGENV.view(Uint32Array);
  const i16 = SEGENV.view(Int16Array);
  const u8 = SEGENV.data;

  SEGMENT.fill(BLACK);

  const time = strip.now;
  let respawn = false;

  for (let i = 0; i < numSpotlights; i++) {
    const SPD = i * 4, CI = i * 16 + 4, POSI = i * 8 + 3, LAST = i * 4 + 2, WID = i * 16 + 12, TYP = i * 16 + 13;
    if (!initialize) {
      // advance the position of the spotlight
      const delta = Math.trunc(fr((time - u32[LAST]!) >>> 0) * (f32[SPD]! * ((1.0 + SEGMENT.speed) / 100.0))) | 0;

      if (Math.abs(delta) >= 1) {
        i16[POSI] = i16[POSI]! + delta;
        u32[LAST] = time;
      }

      respawn = (f32[SPD]! > 0.0 && i16[POSI]! > SEGLEN + 2)
        || (f32[SPD]! < 0.0 && i16[POSI]! < -(u8[WID]! + 2));
    }

    if (initialize || respawn) {
      u8[CI] = hw_random8();
      u8[WID] = hw_random8(1, 10);

      f32[SPD] = 1.0 / hw_random8(4, 50);

      if (initialize) {
        i16[POSI] = hw_random16(SEGLEN);
        f32[SPD] = f32[SPD]! * (hw_random8(2) ? 1.0 : -1.0);
      } else {
        if (hw_random8(2)) {
          i16[POSI] = SEGLEN + u8[WID]!;
          f32[SPD] = f32[SPD]! * -1.0;
        } else {
          i16[POSI] = -u8[WID]!;
        }
      }

      u32[LAST] = time;
      u8[TYP] = hw_random8(SPOT_TYPES_COUNT);
    }

    const color = SEGMENT.color_from_palette(u8[CI]!, false, false, 255);
    const start = i16[POSI]!;
    const width = u8[WID]!;

    if (width <= 1) {
      if (start >= 0 && start < SEGLEN) SEGMENT.blendPixelColor(start, color, 128);
    } else {
      switch (u8[TYP]) {
        case SPOT_TYPE_SOLID:
          for (let j = 0; j < width; j++) if (inSeg(start + j)) SEGMENT.blendPixelColor(start + j, color, 128);
          break;
        case SPOT_TYPE_GRADIENT:
          for (let j = 0; j < width; j++) if (inSeg(start + j)) SEGMENT.blendPixelColor(start + j, color, cubicwave8(map(j, 0, width - 1, 0, 255)));
          break;
        case SPOT_TYPE_2X_GRADIENT:
          for (let j = 0; j < width; j++) if (inSeg(start + j)) SEGMENT.blendPixelColor(start + j, color, cubicwave8(2 * map(j, 0, width - 1, 0, 255)));
          break;
        case SPOT_TYPE_2X_DOT:
          for (let j = 0; j < width; j += 2) if (inSeg(start + j)) SEGMENT.blendPixelColor(start + j, color, 128);
          break;
        case SPOT_TYPE_3X_DOT:
          for (let j = 0; j < width; j += 3) if (inSeg(start + j)) SEGMENT.blendPixelColor(start + j, color, 128);
          break;
        case SPOT_TYPE_4X_DOT:
          for (let j = 0; j < width; j += 4) if (inSeg(start + j)) SEGMENT.blendPixelColor(start + j, color, 128);
          break;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Washing Machine, Blends, TV Simulator
// ---------------------------------------------------------------------------------------------

/** int8 tristate_square8(uint8 x, uint8 pulsewidth, uint8 attdec) */
function tristate_square8(x: number, pulsewidth: number, attdec: number): number {
  x &= 0xff;
  let a = 127;
  if (x > 127) {
    a = -127;
    x = (x - 127) & 0xff;
  }
  let r = 0;
  if (x < attdec) r = Math.trunc((x * a) / attdec); // inc to max
  else if (x < pulsewidth - attdec) r = a; // max
  else if (x < pulsewidth) r = Math.trunc(((pulsewidth - x) * a) / attdec); // dec to 0
  return (r << 24) >> 24;
}

/*
  Imitates a washing machine, rotating same waves forward, then pause, then backward.
  By Stefan Seegel
*/
function mode_washing_machine(): void {
  const speed = tristate_square8(strip.now >>> 7, 90, 15);

  SEGENV.step += Math.trunc((speed * 2048) / (512 - SEGMENT.speed));

  for (let i = 0; i < SEGLEN; i++) {
    const col = sin8_t(Math.trunc((((Math.trunc(SEGMENT.intensity / 25) + 1) * 255 * i) / SEGLEN)) + (SEGENV.step >>> 7));
    SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(col, false, PALETTE_SOLID_WRAP, 3));
  }
}

/*
  Blends random colors across palette
  Modified, originally by Mark Kriegsman https://gist.github.com/kriegsman/1f7ccbbfa492a73c015e
*/
function mode_blends(): void {
  const pixelLen = SEGLEN > 255 ? 255 : SEGLEN;
  const dataSize = 4 * (pixelLen + 1);
  if (!SEGENV.allocateData(dataSize)) { fallbackStatic(); return; }
  const pixels = SEGENV.view(Uint32Array);
  const blendSpeed = map(SEGMENT.intensity, 0, 255, 10, 128) & 0xff;
  let shift = (Math.imul(strip.now, (SEGMENT.speed >> 3) + 1) >>> 0) >>> 8;

  for (let i = 0; i < pixelLen; i++) {
    pixels[i] = color_blend(pixels[i]!, SEGMENT.color_from_palette(shift + quadwave8((i + 1) * 16), false, PALETTE_SOLID_WRAP, 255), blendSpeed);
    shift += 3;
  }

  let offset = 0;
  for (let i = 0; i < SEGLEN; i++) {
    SEGMENT.setPixelColor(i, pixels[offset++]!);
    if (offset >= pixelLen) offset = 0;
  }
}

/*
  TV Simulator
  Modified and adapted to WLED by Def3nder, based on "Fake TV Light for Engineers" by Phillip Burgess https://learn.adafruit.com/fake-tv-light-for-engineers/arduino-sketch
*/
// struct TvSim (48 bytes): u32 totalTime@0, fadeTime@4, startTime@8, elapsed@12, pixelNum@16, u16 sliderValues@20,
// u32 sceeneStart@24, sceeneDuration@28, u16 sceeneColorHue@32, u8 sceeneColorSat@34, sceeneColorBri@35,
// u8 actualColorR@36, G@37, B@38, u16 pr@40, pg@42, pb@44
const TV_TOTAL = 0, TV_FADE = 4, TV_START = 8, TV_ELAPSED = 12, TV_SLIDERS = 20, TV_SC_START = 24, TV_SC_DUR = 28;
const TV_HUE = 32, TV_SAT = 34, TV_BRI = 35, TV_R = 36, TV_G = 37, TV_B = 38, TV_PR = 40, TV_PG = 42, TV_PB = 44;
const tvTemp = new Uint8Array(5); // scratch (fully written before use)
function mode_tv_simulator(): void {
  if (!SEGENV.allocateData(48)) { fallbackStatic(); return; }
  const dv = SEGENV.dataView;
  const LE = true;

  const colorSpeed = map(SEGMENT.speed, 0, 255, 1, 20) & 0xff;
  const colorIntensity = map(SEGMENT.intensity, 0, 255, 10, 30) & 0xff;

  let i = (SEGMENT.speed << 8) | SEGMENT.intensity;
  if (i !== dv.getUint16(TV_SLIDERS, LE)) {
    dv.setUint16(TV_SLIDERS, i, LE);
    SEGENV.aux1 = 0;
  }

  // create a new sceene
  if (((strip.now - dv.getUint32(TV_SC_START, LE)) >>> 0) >= dv.getUint32(TV_SC_DUR, LE) || SEGENV.aux1 === 0) {
    dv.setUint32(TV_SC_START, strip.now, LE); // remember the start of the new sceene
    dv.setUint32(TV_SC_DUR, hw_random16(60 * 250 * colorSpeed, 60 * 750 * colorSpeed) >>> 0, LE); // duration of a "movie sceene" (int16 result, as in C)
    dv.setUint16(TV_HUE, hw_random16(0, 768) & 0xffff, LE); // random start color-tone for the sceene
    dv.setUint8(TV_SAT, hw_random8(100, 130 + colorIntensity)); // random start color-saturation for the sceene
    dv.setUint8(TV_BRI, hw_random8(200, 240)); // random start color-brightness for the sceene
    SEGENV.aux1 = 1;
    SEGENV.aux0 = 0;
  }

  // slightly change the color-tone in this sceene
  if (SEGENV.aux0 === 0) {
    const sHue = dv.getUint16(TV_HUE, LE);
    // hue change in both directions
    let j = hw_random8(4 * colorIntensity);
    const hue = hw_random8() < 128
      ? (j < sHue ? sHue - j : 767 - sHue - j) // negative
      : (j + sHue < 767 ? sHue + j : sHue + j - 767); // positive

    // saturation
    j = hw_random8(2 * colorIntensity);
    const sSat = dv.getUint8(TV_SAT);
    const sat = (sSat - j < 0 ? 0 : sSat - j) & 0xff;

    // brightness
    j = hw_random8(100);
    const sBri = dv.getUint8(TV_BRI);
    const bri = (sBri - j < 0 ? 0 : sBri - j) & 0xff;

    // calculate R,G,B from HSV
    // Source: https://blog.adafruit.com/2012/03/14/constant-brightness-hsb-to-rgb-algorithm/
    {
      const n = ((hue >> 8) % 3) & 0xff;
      const x = (((((hue & 255) * sat) >> 8) * bri) >> 8) & 0xff;
      const s = (((256 - sat) * bri) >> 8) & 0xff;
      tvTemp[0] = tvTemp[3] = s;
      tvTemp[1] = tvTemp[4] = x + s;
      tvTemp[2] = bri - x;
      dv.setUint8(TV_R, tvTemp[n + 2]!);
      dv.setUint8(TV_G, tvTemp[n + 1]!);
      dv.setUint8(TV_B, tvTemp[n]!);
    }
  }
  // expand to 16 bit
  const nr = dv.getUint8(TV_R) * 257; // New R/G/B
  const ng = dv.getUint8(TV_G) * 257;
  const nb = dv.getUint8(TV_B) * 257;

  if (SEGENV.aux0 === 0) { // initialize next iteration
    SEGENV.aux0 = 1;

    // randomize total duration and fade duration for the actual color
    dv.setUint32(TV_TOTAL, hw_random16(250, 2500) >>> 0, LE); // Semi-random pixel-to-pixel time
    dv.setUint32(TV_FADE, hw_random16(0, dv.getUint32(TV_TOTAL, LE) | 0) >>> 0, LE); // Pixel-to-pixel transition time
    if (hw_random8(10) < 3) dv.setUint32(TV_FADE, 0, LE); // Force scene cut 30% of time

    dv.setUint32(TV_START, strip.now, LE);
  } // end of initialization

  // how much time is elapsed ?
  const elapsed = (strip.now - dv.getUint32(TV_START, LE)) >>> 0;
  dv.setUint32(TV_ELAPSED, elapsed, LE);
  const fadeTime = dv.getUint32(TV_FADE, LE);

  // fade from prev color to next color
  let r: number, g: number, b: number;
  if (elapsed < fadeTime) {
    r = map(elapsed, 0, fadeTime, dv.getUint16(TV_PR, LE), nr);
    g = map(elapsed, 0, fadeTime, dv.getUint16(TV_PG, LE), ng);
    b = map(elapsed, 0, fadeTime, dv.getUint16(TV_PB, LE), nb);
  } else { // Avoid divide-by-zero in map()
    r = nr;
    g = ng;
    b = nb;
  }

  // set strip color
  const col = RGBW32(r >> 8, g >> 8, b >> 8); // Quantize to 8-bit
  for (i = 0; i < SEGLEN; i++) SEGMENT.setPixelColor(i, col);

  // if total duration has passed, remember last color and restart the loop
  if (elapsed >= dv.getUint32(TV_TOTAL, LE)) {
    dv.setUint16(TV_PR, nr, LE); // Prev RGB = new RGB
    dv.setUint16(TV_PG, ng, LE);
    dv.setUint16(TV_PB, nb, LE);
    SEGENV.aux0 = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// WLED-SR effects: Perlin Move, Wavesins, Flow Stripe
// ---------------------------------------------------------------------------------------------

// 16 bit perlinmove. Use Perlin Noise instead of sinewaves for movement. By Andrew Tuline.
// Controls are speed, # of pixels, faderate.
function mode_perlinmove(): void {
  if (SEGLEN <= 1) { fallbackStatic(); return; }
  SEGMENT.fade_out(255 - SEGMENT.custom1);
  const tt = Math.trunc((Math.imul(strip.now, 128) >>> 0) / (260 - SEGMENT.speed)) >>> 0;
  for (let i = 0; i < (SEGMENT.intensity >> 4) + 1; i++) {
    const locn = perlin16((tt + i * 15000) >>> 0, tt); // Get a new pixel location from moving noise.
    const pixloc = map(locn, 50 * 256, 192 * 256, 0, SEGLEN - 1) >>> 0; // Map that to the length of the strand
    SEGMENT.setPixelColor(pixloc | 0, SEGMENT.color_from_palette(pixloc % 255, false, PALETTE_SOLID_WRAP, 0));
  }
}

// Uses beatsin8() + phase shifting. By: Andrew Tuline
function mode_wavesins(): void {
  const t4 = (strip.now / 4) >>> 0;
  for (let i = 0; i < SEGLEN; i++) {
    const bri = sin8_t(t4 + i * SEGMENT.intensity);
    const index = beatsin8_t(SEGMENT.speed, SEGMENT.custom1, SEGMENT.custom1 + SEGMENT.custom2, 0, i * (SEGMENT.custom3 << 3)); // custom3 is reduced resolution slider
    SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(index, false, PALETTE_SOLID_WRAP, 0, bri));
  }
}

// By: ldirko  https://editor.soulmatelights.com/gallery/392-flow-led-stripe , modifed by: Andrew Tuline, fixed by @DedeHai
function mode_FlowStripe(): void {
  if (SEGLEN <= 1) { fallbackStatic(); return; }
  const hl = Math.trunc((SEGLEN * 10) / 13);
  const hue = Math.trunc(strip.now / (SEGMENT.speed + 1)) & 0xff;
  const t = Math.trunc(strip.now / ((SEGMENT.intensity >> 3) + 1)) >>> 0;

  for (let i = 0; i < SEGLEN; i++) {
    let c = Math.trunc((Math.abs(i - hl) * 127) / hl);
    c = sin8_t(c);
    c = sin8_t((c >> 1) + t);
    const b = sin8_t(c + (t >>> 3));
    SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(b + hue, false, true, 3));
  }
}

// ---------------------------------------------------------------------------------------------
// Shimmer
// ---------------------------------------------------------------------------------------------

/*
  Shimmer effect: moves a gradient with optional modulators across the strip at a given interval, up to 60 seconds
  It can be used as an overlay to other effects or standalone
  by DedeHai (Damian Schneider), based on idea from @Charming-Lime (#4905)
*/
function mode_shimmer(): void {
  if (!SEGENV.allocateData(4)) { fallbackStatic(); return; }
  const lastTime = SEGENV.view(Uint32Array);

  const radius = (((SEGMENT.custom1 * SEGLEN) >>> 7) + 1) >>> 0; // [1, 2*SEGLEN+1] pixels
  const traversalDistance = ((SEGLEN + 2 * radius) << 8) >>> 0; // total subpixels to cross, 1 pixel = 256 subpixels
  const traversalTime = 200 + (255 - SEGMENT.speed) * 80; // [200, 20600] ms
  const speed = Math.trunc(((traversalDistance << 5) >>> 0) / traversalTime) >>> 0; // subpixels/512ms
  let position = SEGENV.step | 0; // current position in subpixels
  const inputstate = ((SEGMENT.intensity << 8) | SEGMENT.custom1) & 0xffff; // current user input state

  // init
  if (SEGENV.call === 0 || inputstate !== SEGENV.aux1) {
    position = -(radius << 8);
    SEGENV.aux0 = 0; // aux0 is pause timer
    lastTime[0] = strip.now;
    SEGENV.aux1 = inputstate; // save user input state
  }

  if (SEGMENT.speed) {
    const deltaTime = (strip.now - lastTime[0]!) & 0x7f; // clamp to 127ms to avoid overflows
    lastTime[0] = strip.now;

    if (SEGENV.aux0 > 0) {
      SEGENV.aux0 = SEGENV.aux0 > deltaTime ? SEGENV.aux0 - deltaTime : 0;
    } else {
      // calculate movement step and update position
      const step = (1 + ((Math.imul(speed, deltaTime) >>> 0) >>> 5)) | 0; // subpixels moved this frame
      position = (position + step) | 0;
      const endposition = (SEGLEN + radius) << 8;
      if (position > endposition) {
        SEGENV.aux0 = SEGMENT.intensity * 236; // [0, 60180] ms pause
        if (SEGMENT.check3) SEGENV.aux0 = hw_random(SEGENV.aux0 + 1000); // randomise interval
        position = -(radius << 8); // reset to start position (out of frame)
      }
      SEGENV.step = position >>> 0; // save back
    }

    if (SEGMENT.check2) position = ((SEGLEN << 8) - position) | 0; // invert position (and direction)
  } else {
    position = SEGLEN << 7; // at speed=0, make it static in the center (this enables to use modulators only)
  }

  for (let i = 0; i < SEGLEN; i++) {
    const dist = Math.abs(position - (i << 8)) >>> 0;
    if (dist < radius << 8) {
      let color = SEGMENT.color_from_palette(Math.trunc((i * 255) / SEGLEN), false, false, 0);
      const blend = Math.trunc(dist / radius) & 0xff; // linear gradient
      if (SEGMENT.custom2) {
        let modVal: number; // modulation value
        const tmod = (Math.imul(strip.now, SEGMENT.custom3) << 5) >>> 0;
        if (SEGMENT.check1) {
          modVal = ((sin16_t(((i * SEGMENT.custom2) << 6) + tmod) >> 8) + 128) & 0xff; // sine modulation: regular "Zebra" stripes
        } else {
          modVal = (perlin16(((i * SEGMENT.custom2) << 7) >>> 0, tmod) >> 8) & 0xff; // perlin noise modulation
        }
        color = color_fade(color, modVal, true); // dim by modulator value
      }
      SEGMENT.setPixelColor(i, color_blend(color, SEGCOLOR(1), blend)); // blend to background color
    } else {
      SEGMENT.setPixelColor(i, SEGCOLOR(1));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Slow Transition
// ---------------------------------------------------------------------------------------------

/*
 * Slow Transition effect
 * Displays the currently selected palette/color with a very slow transition
 * speed slider controls the number of minutes for the transition (0 = 10s)
 * by DedeHai
 */
// struct SlowTransitionData (150 bytes): CRGBPalette16 startPalette@0, currentPalette@48, endPalette@96 (16 x r,g,b each),
// u8 startWhite@144, currentWhite@145, endWhite@146, startCCT@147, currentCCT@148, endCCT@149
const ST_START = 0, ST_CUR = 48, ST_END = 96;
const ST_SW = 144, ST_CW = 145, ST_EW = 146, ST_SCCT = 147, ST_CCCT = 148, ST_ECCT = 149;
const stPal: Palette16 = new Uint32Array(16); // scratch (fully written before use)
const palGet = (d: Uint8Array, o: number, i: number): number => RGBW32(d[o + i * 3]!, d[o + i * 3 + 1]!, d[o + i * 3 + 2]!);
function palSet(d: Uint8Array, o: number, i: number, c: number): void { d[o + i * 3] = R(c); d[o + i * 3 + 1] = G(c); d[o + i * 3 + 2] = B(c); }
function palCopyFrom(d: Uint8Array, o: number, p: Palette16): void { for (let i = 0; i < 16; i++) palSet(d, o, i, p[i]!); }
function palCopy(d: Uint8Array, to: number, from: number): void { d.copyWithin(to, from, from + 48); }

function mode_slow_transition(): void {
  // aliases: SEGMENT.step = startTime, SEGMENT.aux0 = stepsDone, SEGMENT.aux1 = startSpeed
  const dataSize = 150;
  if (!SEGMENT.allocateData(dataSize)) { fallbackStatic(); return; }
  const data = SEGMENT.data;
  // Note: compare currentCCT (not endCCT). SEGMENT.cct is set to currentCCT at the end of each call, if they differ, it was changed externally
  let palDiffers = false;
  for (let i = 0; i < 16 && !palDiffers; i++) palDiffers = palGet(data, ST_END, i) !== (SEGPALETTE[i]! & 0xffffff);
  const changed = palDiffers || SEGMENT.aux1 !== SEGMENT.speed || data[ST_EW] !== W(SEGCOLOR(0)) || data[ST_CCCT] !== SEGMENT.cct;

  // (re) init
  if (changed || SEGMENT.call === 0) {
    if (SEGMENT.call === 0) {
      palCopyFrom(data, ST_START, SEGPALETTE);
      palCopyFrom(data, ST_CUR, SEGPALETTE);
      palCopyFrom(data, ST_END, SEGPALETTE);
      data[ST_SW] = data[ST_CW] = data[ST_EW] = W(SEGCOLOR(0));
      data[ST_SCCT] = data[ST_CCCT] = data[ST_ECCT] = SEGMENT.cct;
      SEGMENT.aux0 = 0xffff; // set to max, fading will start once a change is detected
    } else {
      palCopy(data, ST_START, ST_CUR);
      palCopyFrom(data, ST_END, SEGPALETTE);
      data[ST_SW] = data[ST_CW]!;
      data[ST_EW] = W(SEGCOLOR(0));
      data[ST_SCCT] = data[ST_CCCT]!;
      data[ST_ECCT] = SEGMENT.cct;
      SEGMENT.aux0 = 0; // reset counter
    }
    SEGMENT.aux1 = SEGMENT.speed;
    SEGMENT.step = millis(); // set start time note: intentionally not using strip.now as this is based on real time
  }

  const totalSteps = SEGMENT.check2 ? 16 * 255 : 255;
  const duration = SEGMENT.speed === 0 ? 10000 : SEGMENT.speed * 60000; // 10s if zero, otherwise map 1-255 to 1-255 minutes
  const elapsed = (millis() - SEGMENT.step) >>> 0;
  let expectedSteps = Math.trunc((elapsed * totalSteps) / duration) >>> 0; // uint64 product, exact in doubles
  expectedSteps = Math.min(expectedSteps, totalSteps);

  if (SEGMENT.aux0 > expectedSteps) SEGMENT.aux0 = expectedSteps; // in case sweep was disabled mid transition

  if (SEGMENT.aux0 < expectedSteps) {
    SEGMENT.aux0 = expectedSteps; // jump to expected steps to make sure timing is correct
    let blendAmount: number;
    if (SEGMENT.check2) {
      // sweep: one palette entry at a time
      const i = SEGMENT.aux0 % 16;
      blendAmount = (SEGMENT.aux0 >> 4) & 0xff;
      palSet(data, ST_CUR, i, color_blend(palGet(data, ST_START, i), palGet(data, ST_END, i), blendAmount));
    } else {
      // full palette at once
      blendAmount = SEGMENT.aux0 & 0xff;
      for (let i = 0; i < 16; i++) palSet(data, ST_CUR, i, color_blend(palGet(data, ST_START, i), palGet(data, ST_END, i), blendAmount));
    }
    data[ST_CW] = Math.trunc((data[ST_SW]! * (255 - blendAmount) + data[ST_EW]! * blendAmount) / 255);
    data[ST_CCCT] = Math.trunc((data[ST_SCCT]! * (255 - blendAmount) + data[ST_ECCT]! * blendAmount) / 255);
    if (SEGMENT.aux0 >= totalSteps) {
      // transition complete, apply end palette
      palCopy(data, ST_CUR, ST_END);
      data[ST_CW] = data[ST_EW]!;
      data[ST_CCCT] = data[ST_ECCT]!;
    }
  }
  // display current palette (plus white) over segment
  for (let i = 0; i < 16; i++) stPal[i] = palGet(data, ST_CUR, i);
  for (let i = 0; i < SEGLEN; i++) {
    const paletteIndex = Math.trunc((i * 255) / SEGLEN) & 0xff;
    const palcol = ColorFromPalette(stPal, paletteIndex, 255, LINEARBLEND_NOWRAP);
    SEGMENT.setPixelColor(i, RGBW32(R(palcol), G(palcol), B(palcol), data[ST_CW]!));
  }
  // SEGMENT.cct = currentCCT: our segment's CCT is fixed (127) and currentCCT always equals it, so this is a no-op.
}

// ---------------------------------------------------------------------------------------------

export const FX1D_C: EffectDef[] = [
  wledEffect({
    meta: 'Solid Glitter@,!;Bg,,Glitter color;;;m12=0',
    mode: mode_solid_glitter,
    category: 'Twinkle & Sparkle',
    description: 'A solid background colour with single white sparkles popping up at random.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Multi Comet@!,Fade;!,!;!;1',
    mode: mode_multi_comet,
    category: 'Chase & Running',
    description: 'Several comets with fading tails launch at random and race along the lights.',
  }),
  wledEffect({
    meta: 'Rolling Balls@!,# of balls,,,,Collide,Overlay,Trails;!,!,!;!;1;m12=1',
    mode: mode_rolling_balls,
    category: 'Chase & Running',
    description: 'Coloured balls roll back and forth along the lights, bouncing off the ends (and each other).',
  }),
  wledEffect({
    meta: 'Fireworks Starburst@Chance,Fragments,,,,,Overlay;,!;!;;pal=11,m12=0',
    mode: mode_starburst,
    category: 'Fire & Fireworks',
    description: 'Fireworks flash white at random spots and burst into coloured fragments that fly apart and fade.',
  }),
  wledEffect({
    meta: 'Dancing Shadows@!,# of shadows;!;!',
    mode: mode_dancing_shadows,
    category: 'Chase & Running',
    description: 'Overlapping coloured spotlights of different widths drift back and forth like dancing shadows.',
  }),
  wledEffect({
    meta: 'Candle@!,!;!,!;!;01;sx=96,ix=224,pal=0',
    mode: mode_candle,
    category: 'Fire & Fireworks',
    description: 'All the lights flicker together like a single candle flame.',
  }),
  wledEffect({
    meta: 'Bouncing Balls@Gravity,# of balls,,,,,Overlay;!,!,!;!;1;m12=1',
    mode: mode_bouncing_balls,
    category: 'Chase & Running',
    description: 'Balls are thrown up from the start of the lights and bounce, losing height with each bounce.',
  }),
  wledEffect({
    meta: 'Popcorn@!,!,,,,,Overlay;!,!,!;!;;m12=1',
    mode: mode_popcorn,
    category: 'Chase & Running',
    description: 'Kernels pop up from the start of the lights, fly up and fall back down like popcorn.',
  }),
  wledEffect({
    meta: 'Drip@Gravity,# of drips,,,,,Overlay;!,!;!;;m12=1',
    mode: mode_drip,
    category: 'Chase & Running',
    description: 'Water drops swell at the far end, fall to the start and splash with a little bounce.',
  }),
  wledEffect({
    meta: 'Sinelon@!,Trail;!,!,!;!',
    mode: mode_sinelon,
    category: 'Chase & Running',
    description: 'A single dot swings back and forth like a pendulum, leaving a fading trail.',
  }),
  wledEffect({
    meta: 'Sinelon Dual@!,Trail;!,!,!;!',
    mode: mode_sinelon_dual,
    category: 'Chase & Running',
    description: 'Two dots swing back and forth in mirror image, crossing in the middle, with fading trails.',
  }),
  wledEffect({
    meta: 'Sinelon Rainbow@!,Trail;,,!;!',
    mode: mode_sinelon_rainbow,
    category: 'Chase & Running',
    description: 'A dot swings back and forth like a pendulum, changing colour as it goes and leaving a trail.',
  }),
  wledEffect({
    meta: 'Plasma@Phase,!;!;!',
    mode: mode_plasma,
    category: 'Noise & Flow',
    description: 'Soft blobs of palette colour swell, merge and drift like a lava lamp.',
  }),
  wledEffect({
    meta: 'Percent@!,% of fill,,,,One color;!,!;!',
    mode: mode_percent,
    category: 'Basic',
    description: 'Fills a share of the lights set by the intensity, like a progress bar, sliding to the new level.',
  }),
  wledEffect({
    meta: 'Heartbeat@!,!;!,!;!;01;m12=1',
    mode: mode_heartbeat,
    category: 'Basic',
    description: 'All the lights pulse with a double thump like a beating heart, then fade.',
  }),
  wledEffect({
    meta: 'Pacifica@!,Angle;;!;;pal=51',
    mode: mode_pacifica,
    category: 'Waves & Patterns',
    description: 'Gentle layered blue-green ocean waves roll along with bright whitecaps where they meet.',
  }),
  wledEffect({
    meta: 'Candle Multi@!,!;!,!;!;;sx=96,ix=224,pal=0',
    mode: mode_candle_multi,
    category: 'Fire & Fireworks',
    description: 'Every light flickers on its own like a row of separate candles.',
  }),
  wledEffect({
    meta: 'Sunrise@Time [min],Width;;!;;pal=35,sx=60',
    mode: mode_sunrise,
    category: 'Basic',
    description: 'A sun slowly rises from the middle over the set minutes (or sets, or breathes at high speed).',
    // Function of time only: the sunrise starts at the beginning of the effect clock (see mode_sunrise).
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Phased@!,!;!,!;!',
    mode: mode_phased,
    category: 'Waves & Patterns',
    description: 'Sine waves at shifting phases make bands of light that pulse and slide in palette colours.',
  }),
  wledEffect({
    meta: 'Twinkleup@!,Intensity;!,!;!;;m12=0',
    mode: mode_twinkleup,
    category: 'Twinkle & Sparkle',
    description: 'Lights slowly fade in and out at their own pace in palette colours.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Noise Pal@!,Scale;;!',
    mode: mode_noisepal,
    category: 'Noise & Flow',
    description: 'Slow flowing noise in a random palette that gradually changes to new colours.',
  }),
  wledEffect({
    meta: 'Sine@!,Scale;;!',
    mode: mode_sinewave,
    category: 'Waves & Patterns',
    description: 'A smooth sine wave of brightness rolls along the lights while the colours slowly shift.',
  }),
  wledEffect({
    meta: 'Phased Noise@!,!;!,!;!',
    mode: mode_phased_noise,
    category: 'Waves & Patterns',
    description: 'Like Phased, but the waves get uneven, noisy spacing for a more organic shimmer.',
  }),
  wledEffect({
    meta: 'Flow@!,Zones;;!;;m12=1',
    mode: mode_flow,
    category: 'Noise & Flow',
    description: 'The palette flows in zones that alternate direction, meeting and parting along the lights.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Chunchun@!,Gap size;!,!;!',
    mode: mode_chunchun,
    category: 'Chase & Running',
    description: 'A flock of little coloured birds swoops back and forth in a sine motion.',
  }),
  wledEffect({
    meta: 'Washing Machine@!,!;;!',
    mode: mode_washing_machine,
    category: 'Waves & Patterns',
    description: 'Waves of colour spin one way, pause, then spin back like a washing machine drum.',
  }),
  wledEffect({
    meta: 'Blends@Shift speed,Blend speed;;!',
    mode: mode_blends,
    category: 'Noise & Flow',
    description: 'Palette colours drift and blend smoothly into one another along the lights.',
  }),
  wledEffect({
    meta: 'TV Simulator@!,!;;!;01',
    mode: mode_tv_simulator,
    category: 'Basic',
    description: 'All the lights flicker and cut between colours like the glow of a TV in a dark room.',
  }),
  wledEffect({
    meta: 'Dynamic Smooth@!,!;;!',
    mode: mode_dynamic_smooth,
    category: 'Basic',
    description: 'Every light picks a random colour now and then and fades smoothly to it.',
  }),
  wledEffect({
    meta: 'PacMan@Speed,# of PowerDots,Blink distance,Blur,# of Ghosts,Dots,Smear,Compact;;!;1;m12=0,sx=192,ix=64,c1=64,c2=0,c3=12,o1=1,o2=0',
    mode: mode_pacman,
    category: 'Chase & Running',
    description: 'Pac-Man runs along eating dots, chased by ghosts, then chases them back when he eats a power dot.',
  }),
  wledEffect({
    meta: 'Slow Transition@Time (min),,,,,,Sweep;!;!;1;pal=2,sx=0,ix=0',
    mode: mode_slow_transition,
    category: 'Basic',
    description: 'Shows the palette across the lights and fades very slowly to a new one whenever it changes.',
  }),
  wledEffect({
    meta: 'Perlin Move@!,# of pixels,Fade rate;!,!;!',
    mode: mode_perlinmove,
    category: 'Noise & Flow',
    description: 'A few dots wander back and forth at random, leaving fading trails.',
  }),
  wledEffect({
    meta: 'Flow Stripe@Hue speed,Effect speed;;!;pal=11',
    mode: mode_FlowStripe,
    category: 'Noise & Flow',
    description: 'Ripples of palette colour flow outwards from a point along the lights while the hues rotate.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Wavesins@!,Brightness variation,Starting color,Range of colors,Color variation;!;!',
    mode: mode_wavesins,
    category: 'Waves & Patterns',
    description: 'Colour and brightness waves sweep along the lights in a chosen slice of the palette.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Shimmer@Speed,Interval,Size,Granular,Flow,Zebra,Reverse,Sporadic;Fx,Bg,Cx;!;1;pal=15,sx=220,ix=10,c2=0,c3=0',
    mode: mode_shimmer,
    category: 'Chase & Running',
    description: 'A soft glowing band sweeps across the lights every so often, optionally striped or speckled.',
  }),
];
