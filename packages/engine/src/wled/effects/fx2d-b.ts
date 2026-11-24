// Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/FX.cpp. Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.
//
// The 2D effects of the fx2d batch (registered through FX2D in fx2d.ts).

import type { EffectDef } from '../../effects.js';
import { CHSV, color_blend, crgbAdd, DARKSLATEGRAY, gamma8inv, HeatColor, nscale8, rgb2hsv, RGBW32, WHITE, type HSV32 } from '../color.js';
import { wledEffect } from '../define.js';
import {
  abs8, atan2_t, beat8, beatsin16_t, beatsin8_t, cos8_t, cos_t, ease8InOutCubic, hw_random, hw_random16, hw_random8, inoise8,
  lerp8by8, map, perlin16, perlin8, PRNG, qsub8, scale8, sin16_t, sin8_t, sin_t, sqrt32_bw,
} from '../math.js';
import { ColorFromPalette, CRGBPalette16, LINEARBLEND, LINEARBLEND_NOWRAP } from '../palettes.js';
import { FRAMETIME, PALETTE_SOLID_WRAP, SEG_H, SEG_W, SEGCOLOR, SEGENV, SEGMENT, SEGPALETTE, strip } from '../segment.js';

const f = Math.fround;
/** Arduino radians(): (deg) * DEG_TO_RAD, a double. */
const DEG_TO_RAD = 0.017453292519943295769236907684886;
/** C float → narrow integer conversion as GCC emits it (truncate to int32, then keep the low bits). */
const toU8 = (x: number): number => Math.trunc(x) & 0xff;
const toI8 = (x: number): number => (Math.trunc(x) << 24) >> 24;
const toU16 = (x: number): number => Math.trunc(x) & 0xffff;
const toI16 = (x: number): number => (Math.trunc(x) << 16) >> 16;
/** roundf(): half away from zero. */
const roundf = (x: number): number => (x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5));

/** FX_FALLBACK_STATIC when not a 2D set-up. */
function notMatrix(): boolean {
  if (!strip.isMatrix || !SEGMENT.is2D()) { SEGMENT.fill(SEGCOLOR(0)); return true; }
  return false;
}

// Black hole
function mode_2DBlackHole(): void { // By: Stepko https://editor.soulmatelights.com/gallery/1012 , Modified by: Andrew Tuline
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;
  let x: number, y: number;

  SEGMENT.fadeToBlackBy(16 + (SEGMENT.speed >> 3)); // create fading trails
  const t = Math.trunc(strip.now / 128); // timebase
  // outer stars
  for (let i = 0; i < 8; i++) {
    x = beatsin8_t(SEGMENT.custom1 >> 3, 0, cols - 1, 0, (i % 2 ? 128 : 0) + t * i);
    y = beatsin8_t(SEGMENT.intensity >> 3, 0, rows - 1, 0, (i % 2 ? 192 : 64) + t * i);
    SEGMENT.addPixelColorXY(x, y, SEGMENT.color_from_palette(i * 32, false, PALETTE_SOLID_WRAP, SEGMENT.check1 ? 0 : 255));
  }
  // inner stars
  for (let i = 0; i < 4; i++) {
    x = beatsin8_t(SEGMENT.custom2 >> 3, Math.trunc(cols / 4), cols - 1 - Math.trunc(cols / 4), 0, (i % 2 ? 128 : 0) + t * i);
    y = beatsin8_t(SEGMENT.custom3, Math.trunc(rows / 4), rows - 1 - Math.trunc(rows / 4), 0, (i % 2 ? 192 : 64) + t * i);
    SEGMENT.addPixelColorXY(x, y, SEGMENT.color_from_palette(255 - i * 64, false, PALETTE_SOLID_WRAP, SEGMENT.check1 ? 0 : 255));
  }
  // central white dot
  SEGMENT.setPixelColorXY(Math.trunc(cols / 2), Math.trunc(rows / 2), WHITE);
  // blur everything a bit
  if (SEGMENT.check3) SEGMENT.blur(16, cols * rows < 100);
}

////////////////////////////
//     2D Colored Bursts  //
////////////////////////////
function mode_2DColoredBursts(): void { // By: ldirko   https://editor.soulmatelights.com/gallery/819-colored-bursts , modified by: Andrew Tuline
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  if (SEGENV.call === 0) {
    SEGENV.aux0 = 0; // start with red hue
  }

  const dot = SEGMENT.check3;
  const grad = SEGMENT.check1;

  const numLines = (Math.trunc(SEGMENT.intensity / 16) + 1) & 0xff;

  SEGENV.aux0++; // hue
  SEGMENT.fadeToBlackBy(40 - (SEGMENT.check2 ? 1 : 0) * 8);
  const bpmBase = Math.trunc(SEGMENT.speed / 16);
  for (let i = 0; i < numLines; i++) {
    const x1 = beatsin8_t(2 + bpmBase, 0, cols - 1);
    const x2 = beatsin8_t(1 + bpmBase, 0, rows - 1);
    const y1 = beatsin8_t(5 + bpmBase, 0, cols - 1, 0, i * 24);
    const y2 = beatsin8_t(3 + bpmBase, 0, rows - 1, 0, i * 48 + 64);
    const color = ColorFromPalette(SEGPALETTE, Math.trunc((i * 255) / numLines) + (SEGENV.aux0 & 0xff), 255, LINEARBLEND);

    const xsteps = (abs8(x1 - y1) + 1) & 0xff;
    const ysteps = (abs8(x2 - y2) + 1) & 0xff;
    const steps = xsteps >= ysteps ? xsteps : ysteps;
    // Draw gradient line
    for (let j = 1; j <= steps; j++) {
      const rate = Math.trunc((j * 255) / steps) & 0xff;
      const dx = lerp8by8(x1, y1, rate) & 0xff;
      const dy = lerp8by8(x2, y2, rate) & 0xff;
      SEGMENT.addPixelColorXY(dx, dy, color); // use setPixelColorXY for different look
      if (grad) SEGMENT.fadePixelColorXY(dx, dy, rate);
    }

    if (dot) { // add white point at the ends of line
      SEGMENT.setPixelColorXY(x1, x2, WHITE);
      SEGMENT.setPixelColorXY(y1, y2, DARKSLATEGRAY);
    }
  }
  SEGMENT.blur(SEGMENT.custom3 >> 1, SEGMENT.check2);
}

/////////////////////////
//     2D DNA Spiral   //
/////////////////////////
function mode_2DDNASpiral(): void { // By: ldirko  https://editor.soulmatelights.com/gallery/512-dna-spiral-variation , modified by: Andrew Tuline
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  if (SEGENV.call === 0) {
    SEGMENT.fill(0);
  }

  const speeds = (SEGMENT.speed >> 1) + 7;
  const freq = SEGMENT.intensity >> 3;

  const ms = Math.trunc(strip.now / 20);
  SEGMENT.fadeToBlackBy(135);

  for (let i = 0; i < rows; i++) {
    let x = beatsin8_t(speeds, 0, cols - 1, 0, i * freq) + beatsin8_t(speeds - 7, 0, cols - 1, 0, i * freq + 128);
    let x1 = beatsin8_t(speeds, 0, cols - 1, 0, 128 + i * freq) + beatsin8_t(speeds - 7, 0, cols - 1, 0, 128 + 64 + i * freq);
    const hue = Math.trunc((i * 128) / rows) + ms;
    // skip every 4th row every now and then (fade it more)
    if ((i + Math.trunc(ms / 8)) & 3) {
      // draw a gradient line between x and x1
      x = Math.trunc(x / 2); x1 = Math.trunc(x1 / 2);
      const steps = abs8(x - x1) + 1;
      const positive = x1 >= x; // direction of drawing
      for (let k = 1; k <= steps; k++) {
        const rate = Math.trunc((k * 255) / steps);
        const dx = positive ? x + k - 1 : x - k + 1; // behaves the same as "lerp8by8" but does not create holes
        SEGMENT.addPixelColorXY(dx, i, ColorFromPalette(SEGPALETTE, hue, 255, LINEARBLEND)); // use setPixelColorXY for different look
        SEGMENT.fadePixelColorXY(dx, i, rate);
      }
      SEGMENT.setPixelColorXY(x, i, DARKSLATEGRAY);
      SEGMENT.setPixelColorXY(x1, i, WHITE);
    }
  }
  SEGMENT.blur(Math.trunc((SEGMENT.custom1 * 3) / (6 + (SEGMENT.check1 ? 1 : 0))), SEGMENT.check1);
}

/////////////////////////
//     2D Drift        //
/////////////////////////
function mode_2DDrift(): void { // By: Stepko   https://editor.soulmatelights.com/gallery/884-drift , Modified by: Andrew Tuline
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  const colsCenter = (cols >> 1) + (cols % 2);
  const rowsCenter = (rows >> 1) + (rows % 2);

  SEGMENT.fadeToBlackBy(128);
  const maxDim = Math.trunc(Math.max(cols, rows) / 2);
  const t = Math.trunc(strip.now / (32 - (SEGMENT.speed >> 3)));
  const t_20 = Math.trunc(t / 20); // softhack007: pre-calculating this gives about 10% speedup
  const tf = f(t);
  const t20f = f(t_20);
  for (let i = 1.0; i < maxDim; i = f(i + 0.25)) {
    const angle = f(tf * f(maxDim - i)) * DEG_TO_RAD;
    const mySin = Math.trunc(f(sin_t(angle) * i));
    const myCos = Math.trunc(f(cos_t(angle) * i));
    const ci = Math.trunc(f(f(i * 20) + t20f)) >>> 0;
    SEGMENT.setPixelColorXY(colsCenter + mySin, rowsCenter + myCos, ColorFromPalette(SEGPALETTE, ci, 255, LINEARBLEND));
    if (SEGMENT.check1) SEGMENT.setPixelColorXY(colsCenter + myCos, rowsCenter + mySin, ColorFromPalette(SEGPALETTE, ci, 255, LINEARBLEND));
  }
  SEGMENT.blur(SEGMENT.intensity >> (3 - (SEGMENT.check2 ? 1 : 0)), SEGMENT.check2);
}

//////////////////////////
//     2D Firenoise     //
//////////////////////////
// CRGB::Black, Red, DarkOrange, Orange, Yellow
const FIRE_PAL = CRGBPalette16(
  0x000000, 0x000000, 0x000000, 0x000000,
  0xff0000, 0xff0000, 0xff0000, 0xff8c00,
  0xff8c00, 0xff8c00, 0xffa500, 0xffa500,
  0xffff00, 0xffa500, 0xffff00, 0xffff00,
);
function mode_2Dfirenoise(): void { // firenoise2d. By Andrew Tuline. Yet another short routine.
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  if (SEGENV.call === 0) {
    SEGMENT.fill(0);
  }

  const xscale = SEGMENT.intensity * 4;
  const yscale = SEGMENT.speed * 8;
  let indexx = 0;

  const pal = SEGMENT.check1 ? SEGPALETTE : FIRE_PAL;
  const t4 = Math.trunc(strip.now / 4);
  for (let j = 0; j < cols; j++) {
    for (let i = 0; i < rows; i++) {
      indexx = perlin8(Math.trunc((j * yscale * rows) / 255), i * xscale + t4); // We're moving along our Perlin map.
      SEGMENT.setPixelColorXY(j, i, ColorFromPalette(pal, Math.min(Math.trunc((i * indexx) / 11), 225), Math.trunc((i * 255) / rows), LINEARBLEND));
    }
  }
}

//////////////////////////////
//     2D Frizzles          //
//////////////////////////////
function mode_2DFrizzles(): void { // By: Stepko https://editor.soulmatelights.com/gallery/640-color-frizzles , Modified by: Andrew Tuline
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  SEGMENT.fadeToBlackBy(16 + (SEGMENT.check1 ? 1 : 0) * 10);
  for (let i = 8; i > 0; i--) {
    SEGMENT.addPixelColorXY(beatsin8_t((SEGMENT.speed >> 3) + i, 0, cols - 1),
      beatsin8_t((SEGMENT.intensity >> 3) - i, 0, rows - 1), // uint16 bpm: negative values wrap
      ColorFromPalette(SEGPALETTE, beatsin8_t(12, 0, 255), 255, LINEARBLEND));
  }
  SEGMENT.blur(SEGMENT.custom1 >> (3 + (SEGMENT.check1 ? 1 : 0)), SEGMENT.check1);
}

///////////////////////////////////////////
//   2D Cellular Automata Game of life   //
///////////////////////////////////////////
// typedef struct Cell { uint8_t alive:1, faded:1, toggleStatus:1, edgeCell:1, oscillatorCheck:1, spaceshipCheck:1, unused:2; }
const ALIVE = 1, FADED = 2, TOGGLE = 4, EDGE = 8, OSC = 16, SHIP = 32;
const parentIdx = new Int32Array(3);

function mode_2Dgameoflife(): void { // Written by Ewoud Wijma, inspired by https://natureofcode.com/book/chapter-7-cellular-automata/
  // and https://github.com/DougHaber/nlife-color , Modified By: Brandon Butler
  if (notMatrix()) return;
  const cols = SEG_W, rows = SEG_H;
  const maxIndex = cols * rows;

  if (!SEGENV.allocateData(SEGMENT.length())) { SEGMENT.fill(SEGCOLOR(0)); return; }
  const cells = SEGENV.data;

  // generation = SEGENV.aux0, gliderLength = SEGENV.aux1
  const mutate = SEGMENT.check3;
  const blur = map(SEGMENT.custom1, 0, 255, 255, 4) & 0xff;

  const bgColor = SEGCOLOR(1);
  let birthColor = SEGMENT.color_from_palette(128, false, PALETTE_SOLID_WRAP, 255);

  const setup = SEGENV.call === 0;
  if (setup) {
    // Calculate glider length LCM(rows,cols)*4 once
    let a = rows, b = cols;
    while (b) { const t = b; b = a % b; a = t; }
    SEGENV.aux1 = Math.trunc((cols * rows) / a) << 2;
  }

  if (Math.abs(strip.now - SEGENV.step) > 2000) SEGENV.step = 0; // Timebase jump fix
  let paused = SEGENV.step > strip.now;

  // Setup New Game of Life
  if ((!paused && SEGENV.aux0 === 0) || setup) {
    SEGENV.step = strip.now + 1280; // show initial state for 1.28 seconds
    SEGENV.aux0 = 1;
    paused = true;
    // Setup Grid
    cells.fill(0, 0, maxIndex);

    for (let i = 0; i < maxIndex; i++) {
      const isAlive = !hw_random8(3); // ~33%
      const x = i % cols, y = Math.trunc(i / cols);
      cells[i] = (isAlive ? ALIVE : FADED) | (x === 0 || x === cols - 1 || y === 0 || y === rows - 1 ? EDGE : 0);
      SEGMENT.setPixelColor(i, isAlive ? SEGMENT.color_from_palette(hw_random8(), false, PALETTE_SOLID_WRAP, 0) : bgColor);
    }
  }

  if (paused || ((strip.now - SEGENV.step) >>> 0) < Math.trunc(1000 / map(SEGMENT.speed, 0, 255, 1, 42))) {
    // Redraw if paused or between updates to remove blur
    for (let i = maxIndex; i--;) {
      if (!(cells[i]! & ALIVE)) {
        const cellColor = SEGMENT.getPixelColor(i);
        if (cellColor !== bgColor) {
          let newColor: number;
          if (cells[i]! & FADED) newColor = bgColor;
          else {
            let blended = color_blend(cellColor, bgColor, 2);
            if (blended === cellColor) { blended = bgColor; cells[i] = cells[i]! | FADED; }
            newColor = blended;
          }
          SEGMENT.setPixelColor(i, newColor);
        }
      }
    }
    return;
  }

  // Repeat detection
  const generation = SEGENV.aux0, gliderLength = SEGENV.aux1;
  const updateOscillator = generation % 16 === 0;
  const updateSpaceship = gliderLength !== 0 && generation % gliderLength === 0;
  let repeatingOscillator = true, repeatingSpaceship = true, emptyGrid = true;

  let cIndex = maxIndex - 1;
  for (let y = rows; y--;) for (let x = cols; x--; cIndex--) {
    let cell = cells[cIndex]!;
    const alive = cell & ALIVE;

    if (alive) emptyGrid = false;
    if (((cell & OSC) ? 1 : 0) !== alive) repeatingOscillator = false;
    if (((cell & SHIP) ? 1 : 0) !== alive) repeatingSpaceship = false;
    if (updateOscillator) cell = alive ? cell | OSC : cell & ~OSC;
    if (updateSpaceship) cell = alive ? cell | SHIP : cell & ~SHIP;

    let neighbors = 0, aliveParents = 0;
    // Count alive neighbors
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (i || j) {
      let nX = x + j, nY = y + i;
      if (cell & EDGE) {
        nX = (nX + cols) % cols;
        nY = (nY + rows) % rows;
      }
      const nIndex = nX + nY * cols;
      const neighbor = cells[nIndex]!;
      if (neighbor & ALIVE) {
        neighbors++;
        if (!(neighbor & TOGGLE) && neighbors < 4) { // Alive and not dying
          parentIdx[aliveParents++] = nIndex;
        }
      }
    }

    let newColor = 0;
    let needsColor = false;

    if (alive && (neighbors < 2 || neighbors > 3)) { // Loneliness or Overpopulation
      cell |= TOGGLE;
      if (blur === 255) cell |= FADED;
      newColor = cell & FADED ? bgColor : color_blend(SEGMENT.getPixelColor(cIndex), bgColor, blur);
      needsColor = true;
    } else if (!alive) {
      const mutationRoll = mutate ? hw_random8(128) : 1; // if 0: 3 neighbor births fail and 2 neighbor births mutate
      if ((neighbors === 3 && mutationRoll) || (mutate && neighbors === 2 && !mutationRoll)) { // Reproduction or Mutation
        cell |= TOGGLE;
        cell &= ~FADED;

        if (aliveParents) {
          // Set color based on random neighbor
          const parentIndex = parentIdx[hw_random8(aliveParents)]!;
          birthColor = SEGMENT.getPixelColor(parentIndex);
        }
        newColor = birthColor;
        needsColor = true;
      } else if (!(cell & FADED)) { // No change, fade dead cells
        const cellColor = SEGMENT.getPixelColor(cIndex);
        let blended = color_blend(cellColor, bgColor, blur);
        if (blended === cellColor) { blended = bgColor; cell |= FADED; }
        newColor = blended;
        needsColor = true;
      }
    }
    cells[cIndex] = cell;

    if (needsColor) SEGMENT.setPixelColor(cIndex, newColor);
  }
  // Loop through cells, if toggle, swap alive status
  for (let i = maxIndex; i--;) {
    const c = cells[i]!;
    cells[i] = (c ^ ((c & TOGGLE) ? ALIVE : 0)) & ~TOGGLE;
  }

  if (repeatingOscillator || repeatingSpaceship || emptyGrid) {
    SEGENV.aux0 = 0; // reset on next call
    SEGENV.step = SEGENV.step + 1024; // pause final generation for ~1 second
  } else {
    SEGENV.aux0 = SEGENV.aux0 + 1;
    SEGENV.step = strip.now;
  }
}

/////////////////////////
//     2D Hiphotic     //
/////////////////////////
function mode_2DHiphotic(): void { //  By: ldirko  https://editor.soulmatelights.com/gallery/810 , Modified by: Andrew Tuline
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;
  const a = Math.trunc(strip.now / ((SEGMENT.custom3 >> 1) + 1));
  const a3 = Math.trunc(a / 3), a4 = Math.trunc(a / 4);

  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      SEGMENT.setPixelColorXY(x, y, SEGMENT.color_from_palette(sin8_t(cos8_t(((x * SEGMENT.speed) >> 4) + a3) + sin8_t(((y * SEGMENT.intensity) >> 4) + a4) + a), false, PALETTE_SOLID_WRAP, 0));
    }
  }
}

/////////////////////////
//     2D Julia        //
/////////////////////////
// typedef struct Julia { float xcen; float ycen; float xymag; } -> f32[0..2]
function mode_2DJulia(): void { // An animated Julia set by Andrew Tuline.
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  if (!SEGENV.allocateData(12)) { SEGMENT.fill(SEGCOLOR(0)); return; }
  const julias = SEGENV.view(Float32Array);

  if (SEGENV.call === 0) { // Reset the center if we've just re-started this animation.
    julias[0] = 0;
    julias[1] = 0;
    julias[2] = 1.0;
    // WLED also resets the sliders here (custom1/2 = 128, custom3 = 16, intensity = 24). Those are the meta
    // defaults, and our sliders can't be moved afterwards, so the user's settings are kept instead.
  }

  julias[0] = julias[0]! + f((SEGMENT.custom1 - 128) / f(100000));
  julias[1] = julias[1]! + f((SEGMENT.custom2 - 128) / f(100000));
  julias[2] = julias[2]! + f(((SEGMENT.custom3 - 16) << 3) / f(100000)); // reduced resolution slider
  if (julias[2]! < f(0.01)) julias[2] = 0.01;
  if (julias[2]! > 1.0) julias[2] = 1.0;

  const xcen = julias[0]!, ycen = julias[1]!, xymag = julias[2]!;
  let xmin = f(xcen - xymag);
  let xmax = f(xcen + xymag);
  let ymin = f(ycen - xymag);
  let ymax = f(ycen + xymag);

  // Whole set should be within -1.2,1.2 to -.8 to 1.
  const m12 = f(-1.2), p12 = f(1.2), m08 = f(-0.8);
  xmin = xmin < m12 ? m12 : xmin > p12 ? p12 : xmin;
  xmax = xmax < m12 ? m12 : xmax > p12 ? p12 : xmax;
  ymin = ymin < m08 ? m08 : ymin > 1 ? 1 : ymin;
  ymax = ymax < m08 ? m08 : ymax > 1 ? 1 : ymax;

  const maxCalc = 16.0; // How big is each calculation allowed to be before we give up.
  const maxIterations = SEGMENT.intensity >> 1;

  // Resize section on the fly for some animaton.
  let reAl = f(-0.94299); // PixelBlaze example
  let imAg = f(0.3162);

  reAl = f(reAl + f(sin16_t(Math.imul(strip.now, 34)) / f(655340)));
  imAg = f(imAg + f(sin16_t(Math.imul(strip.now, 26)) / f(655340)));

  const dx = f(f(xmax - xmin) / cols); // Scale the delta x and y values to our matrix size.
  const dy = f(f(ymax - ymin) / rows);

  // Start y
  let y = ymin;
  for (let j = 0; j < rows; j++) {
    // Start x
    let x = xmin;
    for (let i = 0; i < cols; i++) {
      // Now we test, as we iterate z = z^2 + c does z tend towards infinity?
      let a = x;
      let b = y;
      let iter = 0;

      while (iter < maxIterations) { // Here we determine whether or not we're out of bounds.
        const aa = f(a * a);
        const bb = f(b * b);
        const len = f(aa + bb);
        if (len > maxCalc) break; // Bail
        // z -> z^2+c where z=a+ib c=(x,y)
        b = f(f(f(2 * a) * b) + imAg);
        a = f(f(aa - bb) + reAl);
        iter++;
      }

      // We color each pixel based on how long it takes to get to infinity, or black if it never gets there.
      if (iter === maxIterations) {
        SEGMENT.setPixelColorXY(i, j, 0);
      } else {
        SEGMENT.setPixelColorXY(i, j, SEGMENT.color_from_palette(Math.trunc((iter * 255) / maxIterations), false, PALETTE_SOLID_WRAP, 0));
      }
      x = f(x + dx);
    }
    y = f(y + dy);
  }
  if (SEGMENT.check1) SEGMENT.blur(100, true);
}

//////////////////////////////
//     2D Lissajous         //
//////////////////////////////
function mode_2DLissajous(): void { // By: Andrew Tuline
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  SEGMENT.fadeToBlackBy(SEGMENT.intensity);
  const phase = (Math.imul(strip.now, 1 + SEGENV.custom3) >>> 0) >>> 5; // allow user to control rotation speed (uint_fast16_t is 32 bits on ESP32)
  const t100 = Math.trunc(strip.now / 100);

  for (let i = 0; i < 256; i++) {
    let xlocn = sin8_t((phase >>> 1) + ((i * SEGMENT.speed) >> 5));
    let ylocn = cos8_t((phase >>> 1) + i * 2);
    xlocn = cols < 2 ? 1 : Math.trunc((map(2 * xlocn, 0, 511, 0, 2 * (cols - 1)) + 1) / 2); // softhack007: "(2* ..... +1) /2" for proper rounding
    ylocn = rows < 2 ? 1 : Math.trunc((map(2 * ylocn, 0, 511, 0, 2 * (rows - 1)) + 1) / 2); // "rows > 1" is needed to avoid div/0 in map()
    SEGMENT.setPixelColorXY(xlocn & 0xff, ylocn & 0xff, SEGMENT.color_from_palette(t100 + i, false, PALETTE_SOLID_WRAP, 0));
  }
  SEGMENT.blur(SEGMENT.custom1 >> (1 + (SEGMENT.check1 ? 1 : 0) * 3), SEGMENT.check1);
}

///////////////////////
//    2D Matrix      //
///////////////////////
function mode_2Dmatrix(): void { // Matrix2D. By Jeremy Williams. Adapted by Andrew Tuline & improved by merkisoft and ewowi, and softhack007.
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;
  const XY = (x: number, y: number): number => (x % cols) + (y % rows) * cols;

  const dataSize = (SEGMENT.length() + 7) >> 3; // 1 bit per LED for trails
  if (!SEGENV.allocateData(dataSize)) { SEGMENT.fill(SEGCOLOR(0)); return; }
  const data = SEGENV.data;

  if (SEGENV.call === 0) {
    SEGMENT.fill(0);
    SEGENV.step = 0;
  }

  const fade = map(SEGMENT.custom1, 0, 255, 30, 250) & 0xff; // equals trail size
  const speed = ((256 - SEGMENT.speed) >> map(Math.min(rows, 150), 0, 150, 0, 3)) & 0xff; // slower speeds for small displays

  let spawnColor: number;
  let trailColor: number;
  if (SEGMENT.check1) {
    spawnColor = SEGCOLOR(0);
    trailColor = SEGCOLOR(1);
  } else {
    spawnColor = RGBW32(gamma8inv(175), gamma8inv(255), gamma8inv(175), 0); // use gamma inversion to restor original pre 16.0 looks
    trailColor = RGBW32(gamma8inv(27), gamma8inv(130), gamma8inv(39), 0);
  }

  let emptyScreen = true;
  if (((strip.now - SEGENV.step) >>> 0) >= speed) {
    SEGENV.step = strip.now;
    // move pixels one row down. Falling codes keep color and add trail pixels; all others pixels are faded
    SEGMENT.fadeToBlackBy(fade);
    for (let row = rows - 1; row >= 0; row--) {
      for (let col = 0; col < cols; col++) {
        let index = XY(col, row) >> 3;
        let bitNum = XY(col, row) & 0x07;
        if ((data[index]! >> bitNum) & 1) {
          SEGMENT.setPixelColorXY(col, row, trailColor); // create trail
          data[index] = data[index]! & ~(1 << bitNum);
          if (row < rows - 1) {
            SEGMENT.setPixelColorXY(col, row + 1, spawnColor);
            index = XY(col, row + 1) >> 3;
            bitNum = XY(col, row + 1) & 0x07;
            data[index] = data[index]! | (1 << bitNum);
            emptyScreen = false;
          }
        }
      }
    }

    // spawn new falling code
    if (hw_random8() <= SEGMENT.intensity || emptyScreen) {
      const spawnX = hw_random8(cols);
      SEGMENT.setPixelColorXY(spawnX, 0, spawnColor);
      // update hint for next run
      const index = XY(spawnX, 0) >> 3;
      const bitNum = XY(spawnX, 0) & 0x07;
      data[index] = data[index]! | (1 << bitNum);
    }
  }
}

/////////////////////////
//     2D Metaballs    //
/////////////////////////
function mode_2Dmetaballs(): void { // Metaballs by Stefan Petrick. Cannot have one of the dimensions be 2 or less. Adapted by Andrew Tuline.
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  const speed = f(0.25 * (1 + (SEGMENT.speed >> 6)));
  const tn = toU16(f(f(strip.now) * speed)); // float → uint16 argument

  // get some 2 random moving points
  const x2 = map(perlin8(tn, 25355, 685), 0, 255, 0, cols - 1);
  const y2 = map(perlin8(tn, 355, 11685), 0, 255, 0, rows - 1);

  const x3 = map(perlin8(tn, 55355, 6685), 0, 255, 0, cols - 1);
  const y3 = map(perlin8(tn, 25355, 22685), 0, 255, 0, rows - 1);

  // and one Lissajou function
  const x1 = beatsin8_t(toU16(f(23 * speed)), 0, cols - 1);
  const y1 = beatsin8_t(toU16(f(28 * speed)), 0, rows - 1);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      // calculate distances of the 3 points from actual pixel and add them together with weightening
      let dx = Math.abs(x - x1);
      let dy = Math.abs(y - y1);
      let dist = 2 * sqrt32_bw(dx * dx + dy * dy);

      dx = Math.abs(x - x2);
      dy = Math.abs(y - y2);
      dist += sqrt32_bw(dx * dx + dy * dy);

      dx = Math.abs(x - x3);
      dy = Math.abs(y - y3);
      dist += sqrt32_bw(dx * dx + dy * dy);

      // inverse result
      const color = dist ? Math.trunc(1000 / dist) : 255;

      // map color between thresholds
      if (color > 0 && color < 60) {
        SEGMENT.setPixelColorXY(x, y, SEGMENT.color_from_palette(map(color * 9, 9, 531, 0, 255), false, PALETTE_SOLID_WRAP, 0));
      } else {
        SEGMENT.setPixelColorXY(x, y, SEGMENT.color_from_palette(0, false, PALETTE_SOLID_WRAP, 0));
      }
      // show the 3 points, too
      SEGMENT.setPixelColorXY(x1, y1, WHITE);
      SEGMENT.setPixelColorXY(x2, y2, WHITE);
      SEGMENT.setPixelColorXY(x3, y3, WHITE);
    }
  }
}

//////////////////////
//    2D Noise      //
//////////////////////
function mode_2Dnoise(): void { // By Andrew Tuline
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  const scale = SEGMENT.intensity + 2;
  const z = Math.trunc(strip.now / (16 - (SEGMENT.speed >> 4)));

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const pixelHue8 = perlin8(x * scale, y * scale, z);
      SEGMENT.setPixelColorXY(x, y, ColorFromPalette(SEGPALETTE, pixelHue8));
    }
  }
}

//////////////////////////////
//     2D Plasma Ball       //
//////////////////////////////
function mode_2DPlasmaball(): void { // By: Stepko https://editor.soulmatelights.com/gallery/659-plasm-ball , Modified by: Andrew Tuline
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  SEGMENT.fadeToBlackBy(SEGMENT.custom1 >> 2);
  const t = Math.trunc((Math.imul(strip.now, 8) >>> 0) / (256 - SEGMENT.speed)); // optimized to avoid float
  const half = Math.trunc(cols / 2);
  const beat = beat8(5);
  for (let i = 0; i < cols; i++) {
    const thisVal = perlin8(i * 30, t, t);
    const thisMax = map(thisVal, 0, 255, 0, cols - 1);
    for (let j = 0; j < rows; j++) {
      const thisVal_ = perlin8(t, j * 30, t);
      const thisMax_ = map(thisVal_, 0, 255, 0, rows - 1);
      const x = i + thisMax_ - half;
      const y = j + thisMax - half;
      const cx = i + thisMax_;
      const cy = j + thisMax;

      SEGMENT.addPixelColorXY(i, j, ((x - y > -2) && (x - y < 2)) ||
        ((cols - 1 - x - y) > -2 && (cols - 1 - x - y < 2)) ||
        (cols - cx === 0) ||
        (cols - 1 - cx === 0) ||
        ((rows - cy === 0) ||
          (rows - 1 - cy === 0)) ? ColorFromPalette(SEGPALETTE, beat, thisVal, LINEARBLEND) : 0);
    }
  }
  SEGMENT.blur(SEGMENT.custom2 >> 5);
}

////////////////////////////////
//  2D Polar Lights           //
////////////////////////////////
function mode_2DPolarLights(): void { // By: Kostyantyn Matviyevskyy  https://editor.soulmatelights.com/gallery/762-polar-lights , Modified by: Andrew Tuline & @dedehai (palette support)
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  if (SEGENV.call === 0) {
    SEGMENT.fill(0);
    SEGENV.step = 0;
  }

  const adjustHeight = map(rows, 8, 32, 28, 12); // maybe use mapf() ???
  const adjScale = map(cols, 8, 64, 310, 63);
  const _scale = map(SEGMENT.intensity, 0, 255, 30, adjScale) >>> 0;
  const _speed = map(SEGMENT.speed, 0, 255, 128, 16);
  const halfRows = f(rows / 2);

  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      SEGENV.step = SEGENV.step + 1;
      const step = SEGENV.step;
      // float → uint8 argument of qsub8 (negative products wrap, as GCC converts through int)
      const sub = toU8(f(Math.abs(f(halfRows - y)) * adjustHeight));
      let palindex = qsub8(perlin8((step % 2) + Math.imul(x, _scale), y * 16 + (step % 16), Math.trunc(step / _speed)), sub);
      const palbrightness = palindex;
      if (SEGMENT.check1) palindex = 255 - palindex; // flip palette
      SEGMENT.setPixelColorXY(x, y, SEGMENT.color_from_palette(palindex, false, false, 255, palbrightness));
    }
  }
}

/////////////////////////
//     2D Pulser       //
/////////////////////////
function mode_2DPulser(): void { // By: ldirko   https://editor.soulmatelights.com/gallery/878-pulse-test , modifed by: Andrew Tuline
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  SEGMENT.fadeToBlackBy(8 - (SEGMENT.intensity >> 5));
  const a = Math.trunc(strip.now / (18 - (SEGMENT.speed >> 4)));
  const x = Math.trunc(a / 14) % cols;
  const y = map(sin8_t(a * 5) + sin8_t(a * 4) + sin8_t(a * 2), 0, 765, rows - 1, 0);
  SEGMENT.setPixelColorXY(x, y, ColorFromPalette(SEGPALETTE, map(y, 0, rows - 1, 0, 255), 255, LINEARBLEND));

  SEGMENT.blur(SEGMENT.intensity >> 4);
}

/////////////////////////
//     2D Sindots      //
/////////////////////////
function mode_2DSindots(): void { // By: ldirko   https://editor.soulmatelights.com/gallery/597-sin-dots , modified by: Andrew Tuline
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  if (SEGENV.call === 0) {
    SEGMENT.fill(0);
  }

  SEGMENT.fadeToBlackBy((SEGMENT.custom1 >> 3) + (SEGMENT.check1 ? 1 : 0) * 24);

  const t1 = Math.trunc(strip.now / (257 - SEGMENT.speed)) & 0xff; // 20;
  const t2 = ((sin8_t(t1) >> 2) * 2) & 0xff;
  for (let i = 0; i < 13; i++) {
    const x = Math.trunc((sin8_t(t1 + ((i * SEGMENT.intensity) >> 3)) * (cols - 1)) / 255); // max index now 255x15/255=15!
    const y = Math.trunc((sin8_t(t2 + ((i * SEGMENT.intensity) >> 3)) * (rows - 1)) / 255); // max index now 255x15/255=15!
    SEGMENT.setPixelColorXY(x, y, ColorFromPalette(SEGPALETTE, Math.trunc((i * 255) / 13), 255, LINEARBLEND));
  }
  SEGMENT.blur(SEGMENT.custom2 >> (3 + (SEGMENT.check1 ? 1 : 0)), SEGMENT.check1);
}

//////////////////////////////
//     2D Squared Swirl     //
//////////////////////////////
// custom3 affects the blur amount.
function mode_2Dsquaredswirl(): void { // By: Mark Kriegsman. https://gist.github.com/kriegsman/368b316c55221134b160
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  const kBorderWidth = 2;

  SEGMENT.fadeToBlackBy(1 + Math.trunc(SEGMENT.intensity / 5));
  SEGMENT.blur(SEGMENT.custom3 >> 1);

  // Use two out-of-sync sine waves
  const i = beatsin8_t(19, kBorderWidth, cols - kBorderWidth);
  const j = beatsin8_t(22, kBorderWidth, cols - kBorderWidth);
  const k = beatsin8_t(17, kBorderWidth, cols - kBorderWidth);
  const m = beatsin8_t(18, kBorderWidth, rows - kBorderWidth);
  const n = beatsin8_t(15, kBorderWidth, rows - kBorderWidth);
  const p = beatsin8_t(20, kBorderWidth, rows - kBorderWidth);

  SEGMENT.addPixelColorXY(i, m, ColorFromPalette(SEGPALETTE, Math.trunc(strip.now / 29), 255, LINEARBLEND));
  SEGMENT.addPixelColorXY(j, n, ColorFromPalette(SEGPALETTE, Math.trunc(strip.now / 41), 255, LINEARBLEND));
  SEGMENT.addPixelColorXY(k, p, ColorFromPalette(SEGPALETTE, Math.trunc(strip.now / 73), 255, LINEARBLEND));
}

//////////////////////////////
//     2D Sun Radiation     //
//////////////////////////////
function mode_2DSunradiation(): void { // By: ldirko https://editor.soulmatelights.com/gallery/599-sun-radiation  , modified by: Andrew Tuline
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  if (!SEGENV.allocateData((cols + 2) * (rows + 2))) { SEGMENT.fill(SEGCOLOR(0)); return; }
  const bump = SEGENV.data;

  if (SEGENV.call === 0) {
    SEGMENT.fill(0);
  }

  const t = Math.trunc(strip.now / 4);
  let index = 0;
  const someVal = SEGMENT.speed >> 2; // Was 25.
  for (let j = 0; j < rows + 2; j++) {
    for (let i = 0; i < cols + 2; i++) {
      bump[index++] = (perlin8(i * someVal, j * someVal, t) - 127) >> 2; // about +/- 32, stored as byte
    }
  }

  const div = f(3.0 - f(SEGMENT.intensity / f(128)));
  let yindex = cols + 3;
  let vly = -(Math.trunc(rows / 2) + 1);
  for (let y = 0; y < rows; y++) {
    ++vly;
    let vlx = -(Math.trunc(cols / 2) + 1);
    for (let x = 0; x < cols; x++) {
      ++vlx;
      const nx = bump[x + yindex + 1]! - bump[x + yindex - 1]!;
      const ny = bump[x + yindex + (cols + 2)]! - bump[x + yindex - (cols + 2)]!;
      const difx = abs8(vlx * 7 - nx);
      const dify = abs8(vly * 7 - ny);
      const temp = (Math.imul(difx, difx) + Math.imul(dify, dify)) | 0;
      let col = 255 - Math.trunc(temp / 8); // 8 its a size of effect
      if (col < 0) col = 0;
      SEGMENT.setPixelColorXY(x, y, HeatColor(toU8(f(col / div))));
    }
    yindex += cols + 2;
  }
}

/////////////////////////
//     2D Tartan       //
/////////////////////////
function mode_2Dtartan(): void { // By: Elliott Kember  https://editor.soulmatelights.com/gallery/3-tartan , Modified by: Andrew Tuline
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  if (SEGENV.call === 0) {
    SEGMENT.fill(0);
  }

  let hue: number, bri: number;
  let intensity: number;
  const offsetX = beatsin16_t(3, -360, 360);
  const offsetY = beatsin16_t(2, -360, 360);
  const sharpness = SEGMENT.custom3 >> 3; // 0-3

  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      hue = (x * beatsin16_t(10, 1, 10) + offsetY) & 0xff;
      intensity = bri = sin8_t(((x * SEGMENT.speed) >> 1) + offsetX);
      for (let i = 0; i < sharpness; i++) intensity = (intensity * bri) >>> 0;
      intensity = intensity >>> (8 * sharpness);
      SEGMENT.setPixelColorXY(x, y, ColorFromPalette(SEGPALETTE, hue, intensity, LINEARBLEND));
      hue = (y * 3 + offsetX) & 0xff;
      intensity = bri = sin8_t(((y * SEGMENT.intensity) >> 1) + offsetY);
      for (let i = 0; i < sharpness; i++) intensity = (intensity * bri) >>> 0;
      intensity = intensity >>> (8 * sharpness);
      SEGMENT.addPixelColorXY(x, y, ColorFromPalette(SEGPALETTE, hue, intensity, LINEARBLEND));
    }
  }
}

/////////////////////////
//     2D spaceships   //
/////////////////////////
function mode_2Dspaceships(): void { //// Space ships by stepko (c)05.02.21 [https://editor.soulmatelights.com/gallery/639-space-ships], adapted by Blaz Kristan (AKA blazoncek)
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  const tb = strip.now >>> 12; // every ~4s
  if (tb > SEGENV.step) {
    SEGENV.aux0++;
    let dir = SEGENV.aux0;
    dir += hw_random8(3) - 1;
    if (dir > 7) SEGENV.aux0 = 0;
    else if (dir < 0) SEGENV.aux0 = 7;
    else SEGENV.aux0 = dir;
    SEGENV.step = tb + hw_random8(4);
  }

  SEGMENT.fadeToBlackBy(map(SEGMENT.speed, 0, 255, 248, 16));
  SEGMENT.move(SEGENV.aux0, 1);

  for (let i = 0; i < 8; i++) {
    const x = beatsin8_t(12 + i, 2, cols - 3);
    const y = beatsin8_t(15 + i, 2, rows - 3);
    const color = ColorFromPalette(SEGPALETTE, beatsin8_t(12 + i, 0, 255), 255);
    SEGMENT.addPixelColorXY(x, y, color);
    if (cols > 24 || rows > 24) {
      SEGMENT.addPixelColorXY(x + 1, y, color);
      SEGMENT.addPixelColorXY(x - 1, y, color);
      SEGMENT.addPixelColorXY(x, y + 1, color);
      SEGMENT.addPixelColorXY(x, y - 1, color);
    }
  }
  SEGMENT.blur(SEGMENT.intensity >> 3, SEGMENT.check1);
}

/////////////////////////
//     2D Crazy Bees   //
/////////////////////////
//// Crazy bees by stepko (c)12.02.21 [https://editor.soulmatelights.com/gallery/651-crazy-bees], adapted by Blaz Kristan (AKA blazoncek), improved by @dedehai
const MAX_BEES = 5;
// struct Bee { uint8 posX, posY, aimX, aimY, hue; int8 deltaX, deltaY, signX, signY, error; } -> 10 bytes, at 10*i.
// FX.cpp's `static PRNG prng` keeps its seed in the uint16 after the bees (bytes 50..51) so it is part of SEGENV.
const BEE = 10;
const prng = new PRNG();

function beeAimed(d: Uint8Array, o: number, w: number, h: number): void {
  d[o + 2] = prng.random8(0, w); // aimX
  d[o + 3] = prng.random8(0, h); // aimY
  d[o + 4] = prng.random8(); // hue
  const posX = d[o]!, posY = d[o + 1]!, aimX = d[o + 2]!, aimY = d[o + 3]!;
  const deltaX = toI8(Math.abs(aimX - posX));
  const deltaY = toI8(Math.abs(aimY - posY));
  d[o + 5] = deltaX;
  d[o + 6] = deltaY;
  d[o + 7] = posX < aimX ? 1 : -1; // signX
  d[o + 8] = posY < aimY ? 1 : -1; // signY
  d[o + 9] = deltaX - deltaY; // error
}

function mode_2Dcrazybees(): void {
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  const n = Math.min(MAX_BEES, Math.trunc((rows * cols) / 256) + 1) & 0xff;

  if (!SEGENV.allocateData(BEE * MAX_BEES + 2)) { SEGMENT.fill(SEGCOLOR(0)); return; }
  const d = SEGENV.data;
  const i8 = SEGENV.view(Int8Array);
  const dv = SEGENV.dataView;

  if (SEGENV.call === 0) {
    prng.setSeed(strip.now);
    for (let i = 0; i < n; i++) {
      d[i * BEE] = prng.random8(0, cols);
      d[i * BEE + 1] = prng.random8(0, rows);
      beeAimed(d, i * BEE, cols, rows);
    }
  } else prng.setSeed(dv.getUint16(BEE * MAX_BEES, true));

  if (strip.now > SEGENV.step) {
    SEGENV.step = strip.now + Math.trunc((FRAMETIME * 16) / ((SEGMENT.speed >> 4) + 1));
    SEGMENT.fadeToBlackBy(32 + Math.trunc(((SEGMENT.check1 ? 1 : 0) * SEGMENT.intensity) / 25));
    SEGMENT.blur(Math.trunc(SEGMENT.intensity / (2 + (SEGMENT.check1 ? 1 : 0) * 9)), SEGMENT.check1);
    for (let i = 0; i < n; i++) {
      const o = i * BEE;
      const flowerCcolor = SEGMENT.color_from_palette(d[o + 4]!, false, true, 255);
      SEGMENT.addPixelColorXY(d[o + 2]! + 1, d[o + 3]!, flowerCcolor);
      SEGMENT.addPixelColorXY(d[o + 2]!, d[o + 3]! + 1, flowerCcolor);
      SEGMENT.addPixelColorXY(d[o + 2]! - 1, d[o + 3]!, flowerCcolor);
      SEGMENT.addPixelColorXY(d[o + 2]!, d[o + 3]! - 1, flowerCcolor);
      if (d[o]! !== d[o + 2]! || d[o + 1]! !== d[o + 3]!) {
        SEGMENT.setPixelColorXY(d[o]!, d[o + 1]!, CHSV(d[o + 4]!, 60, 255));
        const error2 = i8[o + 9]! * 2;
        if (error2 > -i8[o + 6]!) {
          i8[o + 9] = i8[o + 9]! - i8[o + 6]!;
          d[o] = d[o]! + i8[o + 7]!;
        }
        if (error2 < i8[o + 5]!) {
          i8[o + 9] = i8[o + 9]! + i8[o + 5]!;
          d[o + 1] = d[o + 1]! + i8[o + 8]!;
        }
      } else {
        beeAimed(d, o, cols, rows);
      }
    }
  }
  dv.setUint16(BEE * MAX_BEES, prng.getSeed(), true);
}

/////////////////////////
//     2D Ghost Rider  //
/////////////////////////
//// Ghost Rider by stepko (c)2021 [https://editor.soulmatelights.com/gallery/716-ghost-rider], adapted by Blaz Kristan (AKA blazoncek)
const LIGHTERS_AM = 64; // max lighters (adequate for 32x32 matrix)
// typedef struct Lighter (586 bytes):
//   int16 gPosX @0, int16 gPosY @2, uint16 gAngle @4, int8 angleSpeed @6, (pad) uint16 lightersPosX[64] @8,
//   uint16 lightersPosY[64] @136, uint16 Angle[64] @264, uint16 time[64] @392, bool reg[64] @520, int8 Vspeed @584
const LX = 4, LY = 68, LA = 132, LT = 196, LREG = 520; // uint16 indices (LREG: byte offset)
function mode_2Dghostrider(): void {
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  if (!SEGENV.allocateData(586)) { SEGMENT.fill(SEGCOLOR(0)); return; }
  const u8 = SEGENV.data;
  const i8 = SEGENV.view(Int8Array);
  const u16 = SEGENV.view(Uint16Array);
  const i16 = SEGENV.view(Int16Array);

  const maxLighters = Math.min(cols + rows, LIGHTERS_AM);

  if (SEGENV.aux0 !== cols || SEGENV.aux1 !== rows) {
    SEGENV.aux0 = cols;
    SEGENV.aux1 = rows;
    i8[6] = hw_random8(0, 20) - 10; // angleSpeed
    u16[2] = hw_random16(); // gAngle
    i8[584] = 5; // Vspeed
    i16[0] = Math.trunc(cols / 2) * 10;
    i16[1] = Math.trunc(rows / 2) * 10;
    for (let i = 0; i < maxLighters; i++) {
      u16[LX + i] = i16[0]!;
      u16[LY + i] = i16[1]! + i;
      u16[LT + i] = i * 2;
      u8[LREG + i] = 0;
    }
  }

  if (strip.now > SEGENV.step) {
    SEGENV.step = strip.now + Math.trunc(1024 / (cols + rows));

    SEGMENT.fadeToBlackBy((SEGMENT.speed >> 2) + 64);

    SEGMENT.wu_pixel(Math.trunc((i16[0]! * 256) / 10), Math.trunc((i16[1]! * 256) / 10), WHITE);

    const vs = i8[584]!;
    i16[0] = toI16(f(i16[0]! + f(vs * sin_t(u16[2]! * DEG_TO_RAD))));
    i16[1] = toI16(f(i16[1]! + f(vs * cos_t(u16[2]! * DEG_TO_RAD))));
    u16[2] = u16[2]! + i8[6]!;
    if (i16[0]! < 0) i16[0] = (cols - 1) * 10;
    if (i16[0]! > (cols - 1) * 10) i16[0] = 0;
    if (i16[1]! < 0) i16[1] = (rows - 1) * 10;
    if (i16[1]! > (rows - 1) * 10) i16[1] = 0;
    for (let i = 0; i < maxLighters; i++) {
      u16[LT + i] = u16[LT + i]! + hw_random8(5, 20);
      if (u16[LT + i]! >= 255 ||
        u16[LX + i]! <= 0 ||
        u16[LX + i]! >= (cols - 1) * 10 ||
        u16[LY + i]! <= 0 ||
        u16[LY + i]! >= (rows - 1) * 10) {
        u8[LREG + i] = 1;
      }
      if (u8[LREG + i]) {
        u16[LY + i] = i16[1]!;
        u16[LX + i] = i16[0]!;
        u16[LA + i] = u16[2]! + (hw_random8(20) - 10);
        u16[LT + i] = 0;
        u8[LREG + i] = 0;
      } else {
        u16[LX + i] = toU16(f(u16[LX + i]! + f(-7 * sin_t(u16[LA + i]! * DEG_TO_RAD))));
        u16[LY + i] = toU16(f(u16[LY + i]! + f(-7 * cos_t(u16[LA + i]! * DEG_TO_RAD))));
      }
      SEGMENT.wu_pixel(Math.trunc((u16[LX + i]! * 256) / 10), Math.trunc((u16[LY + i]! * 256) / 10), ColorFromPalette(SEGPALETTE, (256 - u16[LT + i]!) >>> 0));
    }
    SEGMENT.blur(SEGMENT.intensity >> 3);
  }
}

////////////////////////////
//     2D Floating Blobs  //
////////////////////////////
//// Floating Blobs by stepko (c)2021 [https://editor.soulmatelights.com/gallery/573-blobs], adapted by Blaz Kristan (AKA blazoncek)
const MAX_BLOBS = 8;
// typedef struct Blob { float x[8] @0, y[8] @32, sX[8] @64, sY[8] @96, r[8] @128; bool grow[8] @160; byte color[8] @168 } = 176 bytes
const BX = 0, BY = 8, BSX = 16, BSY = 24, BR = 32, BGROW = 160, BCOL = 168; // float indices / byte offsets
function mode_2Dfloatingblobs(): void {
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  const Amount = (SEGMENT.intensity >> 5) + 1; // NOTE: be sure to update MAX_BLOBS if you change this

  if (!SEGENV.allocateData(176)) { SEGMENT.fill(SEGCOLOR(0)); return; }
  const fl = SEGENV.view(Float32Array);
  const u8 = SEGENV.data;
  const spd = 256 - SEGMENT.speed;

  if (SEGENV.aux0 !== cols || SEGENV.aux1 !== rows) {
    SEGENV.aux0 = cols; // re-initialise if virtual size changes
    SEGENV.aux1 = rows;
    for (let i = 0; i < MAX_BLOBS; i++) {
      fl[BR + i] = hw_random8(1, cols > 8 ? Math.trunc(cols / 4) : 2);
      fl[BSX + i] = f(hw_random8(3, cols) / spd); // speed x
      fl[BSY + i] = f(hw_random8(3, rows) / spd); // speed y
      fl[BX + i] = hw_random8(0, cols - 1);
      fl[BY + i] = hw_random8(0, rows - 1);
      u8[BCOL + i] = hw_random8();
      u8[BGROW + i] = fl[BR + i]! < 1 ? 1 : 0;
      if (fl[BSX + i] === 0) fl[BSX + i] = 1;
      if (fl[BSY + i] === 0) fl[BSY + i] = 1;
    }
  }

  SEGMENT.fadeToBlackBy((SEGMENT.custom2 >> 3) + 1);

  const growLimit = Math.min(f(cols / 4), 2);
  const c005 = f(0.05), c0005 = f(0.005), c001 = f(0.01), c101 = f(1.01);
  // Bounce balls around
  for (let i = 0; i < Amount; i++) {
    if (SEGENV.step < strip.now) u8[BCOL + i] = u8[BCOL + i]! + 4; // slowly change color
    const asX = Math.abs(fl[BSX + i]!), asY = Math.abs(fl[BSY + i]!);
    // change radius if needed
    if (u8[BGROW + i]) {
      // enlarge radius until it is >= 4
      fl[BR + i] = f(fl[BR + i]! + f((asX > asY ? asX : asY) * c005));
      if (fl[BR + i]! >= growLimit) u8[BGROW + i] = 0;
    } else {
      // reduce radius until it is < 1
      fl[BR + i] = f(fl[BR + i]! - f((asX > asY ? asX : asY) * c005));
      if (fl[BR + i]! < 1) u8[BGROW + i] = 1;
    }
    const c = SEGMENT.color_from_palette(u8[BCOL + i]!, false, false, 0);
    const bx = fl[BX + i]!, by = fl[BY + i]!, br = fl[BR + i]!;
    if (br > 1) SEGMENT.fillCircle(toU16(roundf(bx)), toU16(roundf(by)), toU8(roundf(br)), c);
    else SEGMENT.setPixelColorXY(Math.trunc(roundf(bx)), Math.trunc(roundf(by)), c);
    // move x
    const sX = fl[BSX + i]!, sY = fl[BSY + i]!;
    if (f(bx + br) >= cols - 1) fl[BX + i] = f(bx + f(sX * f(f(f(cols - 1 - bx) / br) + c0005)));
    else if (f(bx - br) <= 0) fl[BX + i] = f(bx + f(sX * f(f(bx / br) + c0005)));
    else fl[BX + i] = f(bx + sX);
    // move y
    if (f(by + br) >= rows - 1) fl[BY + i] = f(by + f(sY * f(f(f(rows - 1 - by) / br) + c0005)));
    else if (f(by - br) <= 0) fl[BY + i] = f(by + f(sY * f(f(by / br) + c0005)));
    else fl[BY + i] = f(by + sY);
    // bounce x
    if (fl[BX + i]! < c001) {
      fl[BSX + i] = f(hw_random8(3, cols) / spd);
      fl[BX + i] = c001;
    } else if (fl[BX + i]! > f(cols - c101)) {
      fl[BSX + i] = f(hw_random8(3, cols) / spd);
      fl[BSX + i] = -fl[BSX + i]!;
      fl[BX + i] = f(cols - c101);
    }
    // bounce y
    if (fl[BY + i]! < c001) {
      fl[BSY + i] = f(hw_random8(3, rows) / spd);
      fl[BY + i] = c001;
    } else if (fl[BY + i]! > f(rows - c101)) {
      fl[BSY + i] = f(hw_random8(3, rows) / spd);
      fl[BSY + i] = -fl[BSY + i]!;
      fl[BY + i] = f(rows - c101);
    }
  }
  SEGMENT.blur(SEGMENT.custom1 >> 2);

  if (SEGENV.step < strip.now) SEGENV.step = strip.now + 2000; // change colors every 2 seconds
}

////////////////////////////
//     2D Drift Rose      //
////////////////////////////
//// Drift Rose by stepko (c)2021 [https://editor.soulmatelights.com/gallery/1369-drift-rose-pattern], adapted by Blaz Kristan (AKA blazoncek) improved by @dedehai
function mode_2Ddriftrose(): void {
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  const CX = f(f((cols - (cols % 2)) / 2) - f(0.5));
  const CY = f(f((rows - (rows % 2)) / 2) - f(0.5));
  const L = f(Math.min(cols, rows) / 2);

  SEGMENT.fadeToBlackBy(32 + (SEGMENT.speed >> 3));
  for (let i = 1; i < 37; i++) {
    const angle = i * 10 * DEG_TO_RAD;
    const x = Math.trunc(f(f(CX + f(sin_t(angle) * f(beatsin8_t(i, 0, toU8(f(L * 2))) - L))) * 255)) >>> 0;
    const y = Math.trunc(f(f(CY + f(cos_t(angle) * f(beatsin8_t(i, 0, toU8(f(L * 2))) - L))) * 255)) >>> 0;
    if (SEGMENT.palette === 0) SEGMENT.wu_pixel(x, y, CHSV(i * 10, 255, 255));
    else SEGMENT.wu_pixel(x, y, ColorFromPalette(SEGPALETTE, i * 10));
  }
  SEGMENT.blur(SEGMENT.intensity >> 4, SEGMENT.check1);
}

/////////////////////////////
//  2D PLASMA ROTOZOOMER   //
/////////////////////////////
// Plasma Rotozoomer by ldirko (c)2020 [https://editor.soulmatelights.com/gallery/457-plasma-rotozoomer], adapted for WLED by Blaz Kristan (AKA blazoncek)
// data: float a @0, byte plasma[length] @4
function mode_2Dplasmarotozoom(): void {
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  const dataSize = SEGMENT.length() + 4;
  if (!SEGENV.allocateData(dataSize)) { SEGMENT.fill(SEGCOLOR(0)); return; }
  const fa = SEGENV.view(Float32Array);
  const data = SEGENV.data;
  const P = 4; // plasma offset

  const ms = Math.trunc(strip.now / 15);

  // plasma
  for (let j = 0; j < rows; j++) {
    const index = j * cols;
    for (let i = 0; i < cols; i++) {
      if (SEGMENT.check1) data[P + index + i] = ((i * 4) ^ (j * 4)) + Math.trunc(ms / 6);
      else data[P + index + i] = inoise8(i * 40, j * 40, ms);
    }
  }

  // rotozoom
  const a = fa[0]!;
  const fs = f(f(f(sin_t(f(a / 2)) + f((128 - SEGMENT.intensity) / f(128))) + f(1.1)) / f(1.5)); // scale factor
  const kosinus = f(cos_t(a) * fs);
  const sinus = f(sin_t(a) * fs);
  for (let i = 0; i < cols; i++) {
    const u1 = f(i * kosinus);
    const v1 = f(i * sinus);
    for (let j = 0; j < rows; j++) {
      const u = (abs8(toI8(f(u1 - f(j * sinus)))) % cols) & 0xff;
      const v = (abs8(toI8(f(v1 + f(j * kosinus)))) % rows) & 0xff;
      // (an abs8() result of -128 indexes outside the plasma in C; reads past the buffer give 0 here)
      SEGMENT.setPixelColorXY(i, j, SEGMENT.color_from_palette(data[P + v * cols + u] ?? 0, false, PALETTE_SOLID_WRAP, 255));
    }
  }
  fa[0] = f(a - f(f(0.03) + f((SEGENV.speed - 128) * f(0.0002)))); // rotation speed
  if (fa[0]! < f(-6283.18530718)) fa[0] = f(fa[0]! + f(6283.18530718)); // 1000*2*PI, protect sin/cos from very large input float values
}

// Distortion waves - ldirko
// https://editor.soulmatelights.com/gallery/1089-distorsion-waves
// adapted for WLED by @blazoncek, improvements by @dedehai
const hsvTmp: HSV32 = { h: 0, s: 0, v: 0 };
function mode_2Ddistortionwaves(): void {
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  const speed = SEGMENT.speed >> 5;
  let scale = SEGMENT.intensity >> 5;
  if (SEGMENT.check2) scale = (scale + Math.trunc(192 / (cols + rows))) & 0xff; // zoom out some more

  const a = strip.now >>> 5;
  const a2 = a >>> 1;
  const a3 = Math.trunc(a / 3);
  const colsScaled = cols * scale;
  const rowsScaled = rows * scale;

  const cx = beatsin16_t(10 - speed, 0, colsScaled);
  const cy = beatsin16_t(12 - speed, 0, rowsScaled);
  const cx1 = beatsin16_t(13 - speed, 0, colsScaled);
  const cy1 = beatsin16_t(15 - speed, 0, rowsScaled);
  const cx2 = beatsin16_t(17 - speed, 0, colsScaled);
  const cy2 = beatsin16_t(14 - speed, 0, rowsScaled);

  let rdistort: number, gdistort: number, bdistort: number;

  let xoffs = 0;
  for (let x = 0; x < cols; x++) {
    xoffs += scale;
    let yoffs = 0;

    for (let y = 0; y < rows; y++) {
      yoffs += scale;

      if (SEGMENT.check3) {
        // alternate mode from original code
        rdistort = cos8_t(((x + y) * 8 + a2) & 255) >> 1;
        gdistort = cos8_t(((x + y) * 8 + a3 + 32) & 255) >> 1;
        bdistort = cos8_t(((x + y) * 8 + a + 64) & 255) >> 1;
      } else {
        rdistort = cos8_t((cos8_t(((x << 3) + a) & 255) + cos8_t(((y << 3) - a2) & 255) + a3) & 255) >> 1;
        gdistort = cos8_t((cos8_t(((x << 3) - a2) & 255) + cos8_t(((y << 3) + a3) & 255) + a + 32) & 255) >> 1;
        bdistort = cos8_t((cos8_t(((x << 3) + a3) & 255) + cos8_t(((y << 3) - a) & 255) + a2 + 64) & 255) >> 1;
      }

      // unsigned arithmetic; only the low 8 bits survive
      const dR = (xoffs - cx) * (xoffs - cx) + (yoffs - cy) * (yoffs - cy);
      const dG = (xoffs - cx1) * (xoffs - cx1) + (yoffs - cy1) * (yoffs - cy1);
      const dB = (xoffs - cx2) * (xoffs - cx2) + (yoffs - cy2) * (yoffs - cy2);
      let valueR = (rdistort + ((a - (dR >>> 7)) << 1)) & 0xff;
      let valueG = (gdistort + ((a2 - (dG >>> 7)) << 1)) & 0xff;
      let valueB = (bdistort + ((a3 - (dB >>> 7)) << 1)) & 0xff;

      valueR = cos8_t(valueR);
      valueG = cos8_t(valueG);
      valueB = cos8_t(valueB);

      if (SEGMENT.palette === 0) {
        // use RGB values (original color mode)
        SEGMENT.setPixelColorXY(x, y, RGBW32(valueR, valueG, valueB, 0));
      } else {
        // use palette
        const brightness = Math.trunc((valueR + valueG + valueB) / 3);
        if (SEGMENT.check1) { // map brightness to palette index
          SEGMENT.setPixelColorXY(x, y, ColorFromPalette(SEGPALETTE, brightness, 255, LINEARBLEND_NOWRAP));
        } else {
          // color mapping: calculate hue from pixel color, map it to palette index
          rgb2hsv(RGBW32(valueR >> 2, valueG >> 2, valueB >> 2), hsvTmp); // scale colors down to not saturate for better hue extraction
          SEGMENT.setPixelColorXY(x, y, ColorFromPalette(SEGPALETTE, hsvTmp.h >> 8, brightness));
        }
      }
    }
  }

  // palette mode and not filling: smear-blur to cover up palette wrapping artefacts
  if (!SEGMENT.check1 && SEGMENT.palette) SEGMENT.blur(200, true);
}

// Soap
// @Stepko
// Idea from https://www.youtube.com/watch?v=DiHBgITrZck&ab_channel=StefanPetrick
// adapted for WLED by @blazoncek, optimization by @dedehai
// data: uint8 noise3d[segSize] @0, then the CRGB pixels (kept as uint32 per pixel here, 4-aligned), then uint32 noisecoord[3].
let ledsbuff = new Uint32Array(64);
function soapPixels(isRow: boolean, noise3d: Uint8Array, pixels: Uint32Array): void {
  const cols = SEG_W;
  const rows = SEG_H;
  const tRC = isRow ? rows : cols; // transpose if isRow
  const tCR = isRow ? cols : rows; // transpose if isRow
  const amplitude = Math.max(1, (tCR - 8) >> 3) * (1 + (SEGMENT.custom1 >> 5));
  const shift = 0;

  if (ledsbuff.length < tCR) ledsbuff = new Uint32Array(tCR);

  for (let i = 0; i < tRC; i++) {
    const amount = (noise3d[isRow ? i * cols : i]! - 128) * amplitude + shift; // use first row/column: XY(0,i)/XY(i,0)
    const absAmount = amount < 0 ? -amount : amount;
    const delta = absAmount >> 8;
    const fraction = absAmount & 255;
    const easeA = ease8InOutCubic(255 - fraction), easeB = ease8InOutCubic(fraction);
    for (let j = 0; j < tCR; j++) {
      let zD: number, zF: number;
      if (amount < 0) {
        zD = j - delta;
        zF = zD - 1;
      } else {
        zD = j + delta;
        zF = zD + 1;
      }
      const yA = (zD < 0 ? -zD : zD) % tCR;
      const yB = (zF < 0 ? -zF : zF) % tCR;
      const indxA = isRow ? yA + i * cols : i + yA * cols;
      const indxB = isRow ? yB + i * cols : i + yB * cols;
      const PixelA = zD >= 0 && zD < tCR ? pixels[indxA]! : ColorFromPalette(SEGPALETTE, (~noise3d[indxA]! * 3) & 0xff);
      const PixelB = zF >= 0 && zF < tCR ? pixels[indxB]! : ColorFromPalette(SEGPALETTE, (~noise3d[indxB]! * 3) & 0xff);
      ledsbuff[j] = crgbAdd(nscale8(PixelA, easeA), nscale8(PixelB, easeB));
    }
    for (let j = 0; j < tCR; j++) {
      const c = ledsbuff[j]!;
      const x = isRow ? j : i, y = isRow ? i : j;
      pixels[x + y * cols] = c;
      SEGMENT.setPixelColorXY(x, y, c);
    }
  }
}

function mode_2Dsoap(): void {
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  const segSize = SEGMENT.width() * SEGMENT.height();
  const pixOff = (segSize + 3) & ~3;
  const coordOff = pixOff + segSize * 4;
  if (!SEGENV.allocateData(coordOff + 12)) { SEGMENT.fill(SEGCOLOR(0)); return; }

  const data = SEGENV.data;
  const noise3d = data.subarray(0, segSize);
  const u32 = SEGENV.view(Uint32Array);
  const pixels = u32.subarray(pixOff >> 2, (pixOff >> 2) + segSize);
  const nc = coordOff >> 2; // noisecoord x, y, z
  const scale32_x = Math.trunc(160000 / cols);
  const scale32_y = Math.trunc(160000 / rows);
  const mov = Math.trunc((Math.min(cols, rows) * (SEGMENT.speed + 2)) / 2);
  const smoothness = Math.min(250, SEGMENT.intensity); // limit as >250 produces very little changes

  if (SEGENV.call === 0) for (let i = 0; i < 3; i++) u32[nc + i] = hw_random(); // init
  else for (let i = 0; i < 3; i++) u32[nc + i] = u32[nc + i]! + mov;

  const n0 = u32[nc]!, n1 = u32[nc + 1]!, n2 = u32[nc + 2]!;
  for (let i = 0; i < cols; i++) {
    const ioffset = Math.imul(scale32_x, i - (cols >> 1));
    for (let j = 0; j < rows; j++) {
      const joffset = Math.imul(scale32_y, j - (rows >> 1));
      const d = perlin16((n0 + ioffset) >>> 0, (n1 + joffset) >>> 0, n2) >> 8;
      const k = i + j * cols;
      noise3d[k] = scale8(noise3d[k]!, smoothness) + scale8(d, 255 - smoothness);
    }
  }
  // init also if dimensions changed
  if (SEGENV.call === 0 || SEGMENT.aux0 !== cols || SEGMENT.aux1 !== rows) {
    SEGMENT.aux0 = cols;
    SEGMENT.aux1 = rows;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        SEGMENT.setPixelColorXY(i, j, ColorFromPalette(SEGPALETTE, (~noise3d[i + j * cols]! * 3) & 0xff));
      }
    }
  }

  soapPixels(true, noise3d, pixels); // rows
  soapPixels(false, noise3d, pixels); // cols
}

// Idea from https://www.youtube.com/watch?v=HsA-6KIbgto&ab_channel=GreatScott%21
// Octopus (https://editor.soulmatelights.com/gallery/671-octopus)
// Stepko and Sutaburosu
// adapted for WLED by @blazoncek
// data: struct { uint8 angle; uint8 radius; } rMap[w*h] @0, uint8 offsX, offsY after it
function mode_2Doctopus(): void {
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;
  const XY = (x: number, y: number): number => (x % cols) + (y % rows) * cols;
  const mapp = Math.trunc(180 / Math.max(cols, rows)) & 0xff;

  const dataSize = SEGMENT.width() * SEGMENT.height() * 2;
  if (!SEGENV.allocateData(dataSize + 2)) { SEGMENT.fill(SEGCOLOR(0)); return; }
  const rMap = SEGENV.data;

  // re-init if SEGMENT dimensions or offset changed
  if (SEGENV.call === 0 || SEGENV.aux0 !== cols || SEGENV.aux1 !== rows || SEGMENT.custom1 !== rMap[dataSize] || SEGMENT.custom2 !== rMap[dataSize + 1]) {
    SEGENV.step = 0; // t
    SEGENV.aux0 = cols;
    SEGENV.aux1 = rows;
    rMap[dataSize] = SEGMENT.custom1;
    rMap[dataSize + 1] = SEGMENT.custom2;
    const C_X = Math.trunc(cols / 2) + Math.trunc(((SEGMENT.custom1 - 128) * cols) / 255);
    const C_Y = Math.trunc(rows / 2) + Math.trunc(((SEGMENT.custom2 - 128) * rows) / 255);
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) {
        const dx = x - C_X;
        const dy = y - C_Y;
        const k = XY(x, y) * 2;
        rMap[k] = Math.trunc(f(f(40.7436) * atan2_t(dy, dx))); // avoid 128*atan2()/PI
        rMap[k + 1] = toU8(f(f(Math.sqrt(dx * dx + dy * dy)) * mapp)); // thanks Sutaburosu
      }
    }
  }

  SEGENV.step = SEGENV.step + (SEGMENT.speed >> 5) + 1; // 1-4 range
  const step = SEGENV.step;
  const legs = (SEGMENT.custom3 >> 2) + 1;
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      const k = XY(x, y) * 2;
      const angle = rMap[k]!;
      const radius = rMap[k + 1]!;
      const intensity = sin8_t(sin8_t(Math.trunc((angle * 4 - radius) / 4) + (step >>> 1)) + radius - step + angle * legs);
      SEGMENT.setPixelColorXY(x, y, ColorFromPalette(SEGPALETTE, ((step >>> 1) - radius) & 0xff, intensity));
    }
  }
}

// Waving Cell
// @Stepko (https://editor.soulmatelights.com/gallery/1704-wavingcells)
// adapted for WLED by @blazoncek, improvements by @dedehai
function mode_2Dwavingcell(): void {
  if (notMatrix()) return;
  const cols = SEG_W;
  const rows = SEG_H;

  const t = (Math.imul(strip.now, SEGMENT.speed + 1) >>> 0) >>> 3;
  const aX = (SEGMENT.custom1 >> 4) + 9;
  const aY = (SEGMENT.custom2 >> 4) + 1;
  const aZ = SEGMENT.custom3 + 1;
  const tShift = t >>> (8 - (SEGMENT.check2 ? 1 : 0) * 3);
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      const wave = sin8_t(x * aX + sin8_t((Math.imul(((y << 8) + t) >>> 0, aY) >>> 0) >>> 8)) + cos8_t(y * aZ); // bit shifts to increase temporal resolution
      const colorIndex = (wave + tShift) & 0xff;
      SEGMENT.setPixelColorXY(x, y, ColorFromPalette(SEGPALETTE, colorIndex));
    }
  }
  SEGMENT.blur(SEGMENT.intensity);
}

export const FX2D_B: EffectDef[] = [
  wledEffect({
    meta: 'Rotozoomer@!,Scale,,,,Alt;;!;2;pal=54',
    mode: mode_2Dplasmarotozoom,
    category: '2D',
    description: 'A swirling plasma pattern spins and zooms in and out across the house.',
  }),
  wledEffect({
    meta: 'Spaceships@!,Blur,,,,Smear;;!;2',
    mode: mode_2Dspaceships,
    category: '2D',
    description: 'A fleet of coloured dots weaves about, leaving streaky trails that drift in one direction.',
  }),
  wledEffect({
    meta: 'Crazy Bees@!,Blur,,,,Smear;;!;2;pal=11,ix=0',
    mode: mode_2Dcrazybees,
    category: '2D',
    description: 'A few pale bees zig-zag across the house from one glowing flower to the next.',
  }),
  wledEffect({
    meta: 'Ghost Rider@Fade rate,Blur;;!;2',
    mode: mode_2Dghostrider,
    category: '2D',
    description: 'A white rider wanders the house trailing a fiery tail of palette sparks.',
  }),
  wledEffect({
    meta: 'Blobs@!,# blobs,Blur,Trail;!;!;2;c1=8',
    mode: mode_2Dfloatingblobs,
    category: '2D',
    description: 'Soft coloured blobs float about, bouncing off the edges while they swell and shrink.',
  }),
  wledEffect({
    meta: 'Drift Rose@Fade,Blur,,,,Smear;;!;2;pal=11',
    mode: mode_2Ddriftrose,
    category: '2D',
    description: 'Thirty-six coloured petals pulse in and out from the centre like a breathing flower.',
  }),
  wledEffect({
    meta: 'Distortion Waves@!,Scale,,,,Fill,Zoom,Alt;;!;2;pal=0',
    mode: mode_2Ddistortionwaves,
    category: '2D',
    description: 'Bright rings of rainbow colour ripple and warp across the house like oil on water.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Noise2D@!,Scale;;!;2',
    mode: mode_2Dnoise,
    category: '2D',
    description: 'Cloudy patches of palette colour slowly drift and change over the house.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Firenoise@X scale,Y scale,,,,Palette;;!;2;pal=66',
    mode: mode_2Dfirenoise,
    category: '2D',
    description: 'Flickering flames rise from the bottom of the house, dark at the top and yellow-hot below.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Squared Swirl@,Fade,,,Blur;;!;2',
    mode: mode_2Dsquaredswirl,
    category: '2D',
    description: 'Three glowing dots swing back and forth, drawing blurry looping trails.',
  }),
  wledEffect({
    meta: 'Matrix@!,Spawning rate,Trail,,,Custom color;Spawn,Trail;;2',
    mode: mode_2Dmatrix,
    category: '2D',
    description: 'Green code rains down the house in streaks, like the film The Matrix.',
  }),
  wledEffect({
    meta: 'Metaballs@!;;!;2',
    mode: mode_2Dmetaballs,
    category: '2D',
    description: 'Three blobs of colour wander about and melt into each other where they meet.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Pulser@!,Blur;;!;2',
    mode: mode_2DPulser,
    category: '2D',
    description: 'A glowing dot sweeps across the house, bouncing up and down like a heartbeat trace.',
  }),
  wledEffect({
    meta: 'Drift@Rotation speed,Blur,,,,Twin,Smear;;!;2;ix=0',
    mode: mode_2DDrift,
    category: '2D',
    description: 'Coloured dots spiral around the middle of the house, drifting in and out of step.',
  }),
  wledEffect({
    meta: 'Sun Radiation@Variance,Brightness;;;2',
    mode: mode_2DSunradiation,
    category: '2D',
    description: 'A glowing sun sits in the middle of the house with flickering heat rays around it.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Colored Bursts@Speed,# of lines,,,Blur,Gradient,Smear,Dots;;!;2;c3=16',
    mode: mode_2DColoredBursts,
    category: '2D',
    description: 'Coloured lines flick and swing across the house like bursts of light.',
  }),
  wledEffect({
    meta: 'Julia@,Max iterations per pixel,X center,Y center,Area size, Blur;!;!;2;ix=24,c1=128,c2=128,c3=16',
    mode: mode_2DJulia,
    category: '2D',
    description: 'A colourful fractal pattern slowly shifts and morphs over the house.',
  }),
  wledEffect({
    meta: 'Game Of Life@!,,Blur,,,,,Mutation;!,!;!;2;pal=11,sx=128',
    mode: mode_2Dgameoflife,
    category: '2D',
    description: 'Coloured cells are born, live and die by the Game of Life rules, starting over when it settles.',
    stateful: { window: 30, warmup: 15 },
  }),
  wledEffect({
    meta: 'Tartan@X scale,Y scale,,,Sharpness;;!;2',
    mode: mode_2Dtartan,
    category: '2D',
    description: 'Criss-crossing bands of colour form a gently shifting plaid pattern.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Polar Lights@!,Scale,,,,Flip Palette;;!;2;pal=71',
    mode: mode_2DPolarLights,
    category: '2D',
    description: 'Wavy curtains of northern-lights colour shimmer across the middle of the house.',
  }),
  wledEffect({
    meta: 'Lissajous@X frequency,Fade rate,Blur,,Speed,Smear;!;!;2;c1=0',
    mode: mode_2DLissajous,
    category: '2D',
    description: 'A looping figure-of-eight curve of colour twists and turns over the house.',
  }),
  wledEffect({
    meta: 'Frizzles@X frequency,Y frequency,Blur,,,Smear;;!;2',
    mode: mode_2DFrizzles,
    category: '2D',
    description: 'Eight dots of colour dart about, drawing frizzy, tangled trails.',
  }),
  wledEffect({
    meta: 'Plasma Ball@Speed,,Fade,Blur;;!;2',
    mode: mode_2DPlasmaball,
    category: '2D',
    description: 'Crackling lines of light dance about like the filaments in a plasma ball.',
  }),
  wledEffect({
    meta: 'Hiphotic@X scale,Y scale,,,Speed;!;!;2',
    mode: mode_2DHiphotic,
    category: '2D',
    description: 'A hypnotic, ever-shifting moire pattern of palette colours fills the house.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Sindots@!,Dot distance,Fade rate,Blur,,Smear;;!;2;',
    mode: mode_2DSindots,
    category: '2D',
    description: 'A chain of coloured dots swings in smooth curves, leaving fading trails.',
  }),
  wledEffect({
    meta: 'DNA Spiral@Scroll speed,Y frequency,Blur,,,Smear;;!;2;c1=0',
    mode: mode_2DDNASpiral,
    category: '2D',
    description: 'A twisting double helix of colour runs up the house with bright white ends.',
  }),
  wledEffect({
    meta: 'Black Hole@Fade rate,Outer Y freq.,Outer X freq.,Inner X freq.,Inner Y freq.,Solid,,Blur;!;!;2;pal=11',
    mode: mode_2DBlackHole,
    category: '2D',
    description: 'Coloured stars orbit a bright white centre, leaving swirling trails.',
  }),
  wledEffect({
    meta: 'Soap@!,Smoothness,Density;;!;2;pal=11',
    mode: mode_2Dsoap,
    category: '2D',
    description: 'Swirling colours slide and smear across the house like a soap-bubble film.',
  }),
  wledEffect({
    meta: 'Octopus@!,,Offset X,Offset Y,Legs,fasttan;;!;2;',
    mode: mode_2Doctopus,
    category: '2D',
    description: 'Wavy coloured tentacles spin out from a centre point like a swimming octopus.',
  }),
  wledEffect({
    meta: 'Waving Cell@!,Blur,Amplitude 1,Amplitude 2,Amplitude 3,,Flow;;!;2;ix=0',
    mode: mode_2Dwavingcell,
    category: '2D',
    description: 'A grid of colour cells ripples and waves across the house.',
    stateful: false,
    history: 0,
  }),
];
