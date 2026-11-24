// Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/FX.cpp. Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.

import type { EffectDef } from '../../effects.js';
import { B, BLACK, color_blend, G, R, RGBW32, W, WHITE } from '../color.js';
import { wledEffect } from '../define.js';
import { cos_t, cubicwave8, hw_random16, hw_random8, map, qsub8, scale8, sin8_t, sin_t, triwave8 } from '../math.js';
import { FRAMETIME, SEG_H, SEG_W, SEGCOLOR, SEGENV, SEGLEN, SEGMENT, strip } from '../segment.js';
import { FX2D_B } from './fx2d-b.js';

const f = Math.fround;

/*
 * Fireworks function.
 */
function mode_fireworks(): void {
  if (SEGLEN <= 1) { SEGMENT.fill(SEGCOLOR(0)); return; } // FX_FALLBACK_STATIC
  const width = (SEGMENT.is2D() ? SEG_W : SEGLEN) & 0xffff;
  const height = SEG_H & 0xffff;

  if (SEGENV.call === 0) {
    SEGENV.aux0 = 0xffff;
    SEGENV.aux1 = 0xffff;
  }
  SEGMENT.fade_out(128);

  let x = (SEGENV.aux0 % width) & 0xff, y = Math.trunc(SEGENV.aux0 / width) & 0xff; // 2D coordinates stored in upper and lower byte
  if (!SEGENV.step) {
    // fireworks mode (blur flares)
    const valid1 = SEGENV.aux0 < width * height;
    const valid2 = SEGENV.aux1 < width * height;
    let sv1 = 0, sv2 = 0;
    if (valid1) sv1 = SEGMENT.is2D() ? SEGMENT.getPixelColorXY(x, y) : SEGMENT.getPixelColor(SEGENV.aux0); // get spark color
    if (valid2) sv2 = SEGMENT.is2D() ? SEGMENT.getPixelColorXY(x, y) : SEGMENT.getPixelColor(SEGENV.aux1);
    SEGMENT.blur(16); // used in mode_rain()
    if (valid1) { if (SEGMENT.is2D()) SEGMENT.setPixelColorXY(x, y, sv1); else SEGMENT.setPixelColor(SEGENV.aux0, sv1); } // restore spark color after blur
    if (valid2) { if (SEGMENT.is2D()) SEGMENT.setPixelColorXY(x, y, sv2); else SEGMENT.setPixelColor(SEGENV.aux1, sv2); } // restore old spark color after blur
  }

  const n = Math.max(1, Math.trunc(width / 20));
  for (let i = 0; i < n; i++) {
    if (hw_random8(129 - (SEGMENT.intensity >> 1)) === 0) {
      const index = hw_random16(width * height);
      x = (index % width) & 0xff;
      y = Math.trunc(index / width) & 0xff;
      const col = SEGMENT.color_from_palette(hw_random8(), false, false, 0);
      if (SEGMENT.is2D()) SEGMENT.setPixelColorXY(x, y, col);
      else SEGMENT.setPixelColor(index, col);
      SEGENV.aux1 = SEGENV.aux0; // old spark
      SEGENV.aux0 = index; // remember where spark occurred
    }
  }
}

// Twinkling LEDs running. Inspired by https://github.com/kitesurfer1404/WS2812FX/blob/master/src/custom/Rain.h
function mode_rain(): void {
  if (SEGLEN <= 1) { SEGMENT.fill(SEGCOLOR(0)); return; } // FX_FALLBACK_STATIC
  const width = SEG_W;
  const height = SEG_H;
  SEGENV.step = SEGENV.step + FRAMETIME;
  const SPEED_FORMULA_L = (5 + Math.trunc((50 * (255 - SEGMENT.speed)) / SEGLEN)) >>> 0;
  if (SEGENV.call && SEGENV.step > SPEED_FORMULA_L) {
    SEGENV.step = 1;
    if (SEGMENT.is2D()) {
      SEGMENT.move(6, 1, true); // move all pixels down
      SEGENV.aux0 = (SEGENV.aux0 % width) + (Math.trunc(SEGENV.aux0 / width) + 1) * width;
      SEGENV.aux1 = (SEGENV.aux1 % width) + (Math.trunc(SEGENV.aux1 / width) + 1) * width;
    } else {
      // shift all leds left
      const ctemp = SEGMENT.getPixelColor(0);
      for (let i = 0; i < SEGLEN - 1; i++) {
        SEGMENT.setPixelColor(i, SEGMENT.getPixelColor(i + 1));
      }
      SEGMENT.setPixelColor(SEGLEN - 1, ctemp); // wrap around
      SEGENV.aux0++; // increase spark index
      SEGENV.aux1++;
    }
    if (SEGENV.aux0 === 0) SEGENV.aux0 = 0xffff; // reset previous spark position
    if (SEGENV.aux1 === 0) SEGENV.aux0 = 0xffff; // reset previous spark position (sic)
    if (SEGENV.aux0 >= width * height) SEGENV.aux0 = 0; // ignore
    if (SEGENV.aux1 >= width * height) SEGENV.aux1 = 0;
  }
  mode_fireworks();
}

// ESP32 path (float maths)
const maxAngle = f(Math.PI / 256.0);
const animatedRotationScale = f((2 * Math.PI) / 0xffff);

function mode_palette(): void {
  const isMatrix = strip.isMatrix;
  const cols = SEG_W;
  const rows = isMatrix ? SEG_H : strip.getActiveSegmentsNum();

  const inputShift = SEGMENT.speed;
  const inputSize = SEGMENT.intensity;
  const inputRotation = SEGMENT.custom1;
  const inputAnimateShift = SEGMENT.check1;
  const inputAnimateRotation = SEGMENT.check2;
  const inputAssumeSquare = SEGMENT.check3;

  const theta = !inputAnimateRotation
    ? f(f((inputRotation + 128) * maxAngle) / 1)
    : f((Math.imul(strip.now, (inputRotation >> 4) + 1) & 0xffff) * animatedRotationScale);
  const sinTheta = sin_t(theta);
  const cosTheta = cos_t(theta);

  const maxX = Math.max(1, cols - 1);
  const maxY = Math.max(1, rows - 1);
  const maxXIn = inputAssumeSquare ? maxX : 1;
  const maxYIn = inputAssumeSquare ? maxY : 1;
  const maxXOut = !inputAssumeSquare ? maxX : 1;
  const maxYOut = !inputAssumeSquare ? maxY : 1;
  const centerX = f(maxXOut / 2);
  const centerY = f(maxYOut / 2);
  const scale = f(Math.abs(sinTheta) + f(f(Math.abs(cosTheta) * maxYOut) / maxXOut));
  const yFrom = isMatrix ? 0 : strip.getCurrSegmentId();
  const yTo = isMatrix ? maxY : yFrom;
  const paletteOffset = !inputAnimateShift ? inputShift : (Math.imul(strip.now, (inputShift >> 3) + 1) & 0xffff) >> 8;
  for (let y = yFrom; y <= yTo; ++y) {
    // translate, scale, rotate
    const ytCosTheta = f(f(cosTheta * f(y - f(centerY * maxYIn))) / f(maxYIn * scale));
    for (let x = 0; x < cols; ++x) {
      const xtSinTheta = f(f(sinTheta * f(x - f(centerX * maxXIn))) / f(maxXIn * scale));
      const sourceX = f(f(xtSinTheta + ytCosTheta) + centerX);
      let colorIndex = Math.trunc(f(f(Math.min(Math.max(sourceX, 0), maxXOut) * 255) / maxXOut));
      if (inputSize <= 128) {
        colorIndex = Math.trunc((colorIndex * inputSize) / 128);
      } else {
        // Linear function that maps colorIndex 128=>1, 256=>9.
        colorIndex = Math.trunc(((inputSize - 112) * colorIndex) / 16);
      }
      // Finally, shift the palette a bit.
      colorIndex -= paletteOffset;
      const color = SEGMENT.color_wheel(colorIndex & 0xff);
      if (isMatrix) SEGMENT.setPixelColorXY(x, y, color);
      else SEGMENT.setPixelColor(x, color);
    }
  }
}

// struct EyeData { uint8 state @0; uint8 color @1; uint16 startPos @2; uint16 duration @4; (pad 2);
//                  uint32 startTime @8; uint32 blinkEndTime @12 } = 16 bytes.
// Bytes 16..17 (uint16) stand in for SEGMENT.offset, which WLED reuses on matrices (ours is read-only).
const EYE_initializeOn = 0, EYE_on = 1, EYE_blink = 2, EYE_initializeOff = 3, EYE_off = 4, EYE_count = 5;

function mode_halloween_eyes(): void {
  if (SEGLEN <= 1) { SEGMENT.fill(SEGCOLOR(0)); return; } // FX_FALLBACK_STATIC
  const maxWidth = strip.isMatrix ? SEG_W : SEGLEN;
  const HALLOWEEN_EYE_SPACE = Math.max(2, strip.isMatrix ? SEG_W >> 4 : SEGLEN >> 5);
  const HALLOWEEN_EYE_WIDTH = HALLOWEEN_EYE_SPACE >> 1;
  const eyeLength = 2 * HALLOWEEN_EYE_WIDTH + HALLOWEEN_EYE_SPACE;
  if (eyeLength >= maxWidth) { SEGMENT.fill(SEGCOLOR(0)); return; } // bail if segment too short

  if (!SEGENV.allocateData(16 + 2)) { SEGMENT.fill(SEGCOLOR(0)); return; }
  const u8 = SEGENV.data;
  const u16 = SEGENV.view(Uint16Array);
  const u32 = SEGENV.view(Uint32Array);

  if (!SEGMENT.check2) SEGMENT.fill(SEGCOLOR(1)); // fill background

  u8[0] = u8[0]! % EYE_count;
  let duration = Math.max(1, u16[2]!);
  const elapsedTime = (strip.now - u32[2]!) >>> 0;

  switch (u8[0]!) {
    case EYE_initializeOn: {
      u16[1] = hw_random16(0, maxWidth - eyeLength - 1);
      u8[1] = hw_random8();
      if (strip.isMatrix) u16[8] = hw_random16(SEG_H - 1); // a hack: reuse offset since it is not used in matrices
      duration = 128 + hw_random16(SEGMENT.intensity * 64);
      u16[2] = duration;
      u8[0] = EYE_on;
    }
    // falls through
    case EYE_on: {
      const startPos = u16[1]!;
      const start2ndEye = startPos + HALLOWEEN_EYE_WIDTH + HALLOWEEN_EYE_SPACE;
      // If the user reduces the input while in this state, limit the duration.
      duration = Math.min(duration, 128 + SEGMENT.intensity * 64);

      const minimumOnTimeBegin = 1024;
      const minimumOnTimeEnd = 1024;
      const fadeInAnimationState = Math.trunc((Math.imul(elapsedTime, 256 * 8) >>> 0) / duration);
      const backgroundColor = SEGCOLOR(1);
      const eyeColor = SEGMENT.color_from_palette(u8[1]!, false, false, 0);
      let c = eyeColor;
      if (fadeInAnimationState < 256) {
        c = color_blend(backgroundColor, eyeColor, fadeInAnimationState);
      } else if (elapsedTime > minimumOnTimeBegin) {
        const remainingTime = elapsedTime >= duration ? 0 : duration - elapsedTime;
        if (remainingTime > minimumOnTimeEnd) {
          if (hw_random8() < 4) {
            c = backgroundColor;
            u8[0] = EYE_blink;
            u32[3] = (strip.now + hw_random8(8, 128)) >>> 0;
          }
        }
      }

      if (c !== backgroundColor) {
        // render eyes
        for (let i = 0; i < HALLOWEEN_EYE_WIDTH; i++) {
          if (strip.isMatrix) {
            SEGMENT.setPixelColorXY(startPos + i, u16[8]!, c);
            SEGMENT.setPixelColorXY(start2ndEye + i, u16[8]!, c);
          } else {
            SEGMENT.setPixelColor(startPos + i, c);
            SEGMENT.setPixelColor(start2ndEye + i, c);
          }
        }
      }
      break;
    }
    case EYE_blink: {
      if (strip.now >= u32[3]!) u8[0] = EYE_on;
      break;
    }
    case EYE_initializeOff: {
      const eyeOffTimeBase = SEGMENT.speed * 128;
      duration = eyeOffTimeBase + hw_random16(eyeOffTimeBase);
      u16[2] = duration;
      u8[0] = EYE_off;
    }
    // falls through
    case EYE_off: {
      const eyeOffTimeBase = SEGMENT.speed * 128;
      duration = Math.min(duration, 2 * eyeOffTimeBase);
      break;
    }
    case EYE_count: {
      u8[0] = EYE_initializeOn;
      break;
    }
  }

  if (elapsedTime > duration) {
    // The current state duration is over, switch to the next state.
    switch (u8[0]!) {
      case EYE_initializeOn:
      case EYE_on:
      case EYE_blink:
        u8[0] = EYE_initializeOff;
        break;
      default:
        u8[0] = EYE_initializeOn;
        break;
    }
    u32[2] = strip.now;
  }
}

// Water ripple (copy of ripple_base from waves.ts, which doesn't export it)
// struct Ripple { uint8_t state; uint8_t color; uint16_t pos; } -> 4 bytes
const MAX_RIPPLES = 100;
const IBN = 5100;
function ripple_base(blurAmount = 0): void {
  const maxRipples = Math.min(1 + (SEGLEN >> 2), MAX_RIPPLES);
  const dataSize = 4 * maxRipples;

  if (!SEGENV.allocateData(dataSize)) { SEGMENT.fill(SEGCOLOR(0)); return; } // FX_FALLBACK_STATIC
  const u8 = SEGENV.data;
  const u16 = SEGENV.view(Uint16Array);
  const is2D = SEGMENT.is2D() ? 1 : 0;

  for (let i = 0; i < maxRipples; i++) {
    let ripplestate = u8[i * 4]!;
    if (ripplestate) {
      const rippledecay = (SEGMENT.speed >> 4) + 1; // faster decay if faster propagation
      const rippleorigin = u16[i * 2 + 1]!;
      const col = SEGMENT.color_from_palette(u8[i * 4 + 1]!, false, false, 255);
      const propagation = ((Math.trunc(ripplestate / rippledecay) - 1) * (SEGMENT.speed + 1)) >>> 0;
      let propI = propagation >>> 8;
      const propF = propagation & 0xff;
      const amp = ripplestate < 17 ? triwave8((ripplestate - 1) * 8) : map(ripplestate, 17, 255, 255, 2);

      if (is2D) {
        propI = Math.trunc(propI / 2);
        const cx = rippleorigin >> 8;
        const cy = rippleorigin & 0xff;
        const mag = scale8(sin8_t(propF >> 2), amp);
        if (propI > 0) SEGMENT.drawCircle(cx, cy, propI, color_blend(SEGMENT.getPixelColorXY(cx + propI, cy), col, mag), true);
      } else {
        const left = (rippleorigin - propI - 1) | 0;
        const right = (rippleorigin + propI + 2) | 0;
        for (let v = 0; v < 4; v++) {
          const mag = scale8(cubicwave8((propF >> 2) + v * 64), amp);
          SEGMENT.setPixelColor(left + v, color_blend(SEGMENT.getPixelColor(left + v), col, mag));
          SEGMENT.setPixelColor(right - v, color_blend(SEGMENT.getPixelColor(right - v), col, mag));
        }
      }
      ripplestate += rippledecay;
      u8[i * 4] = ripplestate > 254 ? 0 : ripplestate;
    } else { // randomly create new wave
      if (hw_random16(IBN + 10000) <= (SEGMENT.intensity >> (is2D * 3))) {
        u8[i * 4] = 1;
        u16[i * 2 + 1] = is2D ? ((hw_random8(SEG_W) << 8) | hw_random8(SEG_H)) : hw_random16(SEGLEN);
        u8[i * 4 + 1] = hw_random8(); // color
      }
    }
  }
  SEGMENT.blur(blurAmount);
}

function mode_ripple_rainbow(): void {
  if (SEGLEN <= 1) { SEGMENT.fill(SEGCOLOR(0)); return; } // FX_FALLBACK_STATIC
  if (SEGENV.call === 0) {
    SEGENV.aux0 = hw_random8();
    SEGENV.aux1 = hw_random8();
  }
  if (SEGENV.aux0 === SEGENV.aux1) {
    SEGENV.aux1 = hw_random8();
  } else if (SEGENV.aux1 > SEGENV.aux0) {
    SEGENV.aux0++;
  } else {
    SEGENV.aux0--;
  }
  SEGMENT.fill(color_blend(SEGMENT.color_wheel(SEGENV.aux0), BLACK, 235));
  ripple_base();
}

/*
 * Exploding fireworks effect
 * adapted from: http://www.anirama.com/1000leds/1d-fireworks/
 * adapted for 2D WLED by blazoncek (Blaz Kristan (AKA blazoncek))
 */
// typedef struct Spark { float pos, posX; float vel, velX; uint16_t col; uint8_t colIndex; } -> 20 bytes:
// f32[5i] pos, f32[5i+1] posX, f32[5i+2] vel, f32[5i+3] velX, u16[10i+8] col, u8[20i+18] colIndex
const SPARK_SIZE = 20;
// ESP32 without PSRAM: MAX_SEGMENT_DATA 64k / MAX_NUM_SEGMENTS 32 (our strip.getMaxSegments() reports 1)
const FAIR_DATA_PER_SEG = (64 * 1024) / 32;
const MAX_NUM_SEGMENTS = 32;

function mode_exploding_fireworks(): void {
  if (SEGLEN <= 1) { SEGMENT.fill(SEGCOLOR(0)); return; } // FX_FALLBACK_STATIC
  const is2D = SEGMENT.is2D();
  const cols = is2D ? SEG_W : 1;
  const rows = is2D ? SEG_H : SEGLEN;

  // allocate segment data
  let maxData = FAIR_DATA_PER_SEG;
  const segs = strip.getActiveSegmentsNum();
  if (segs <= MAX_NUM_SEGMENTS / 2) maxData *= 2;
  if (segs <= MAX_NUM_SEGMENTS / 4) maxData *= 2;
  const maxSparks = Math.trunc(maxData / SPARK_SIZE);

  const numSparks = Math.min(5 + ((rows * cols) >> 1), maxSparks);
  const dataSize = SPARK_SIZE * numSparks;
  if (!SEGENV.allocateData(dataSize + 4)) { SEGMENT.fill(SEGCOLOR(0)); return; }
  const f32 = SEGENV.view(Float32Array);
  const u16 = SEGENV.view(Uint16Array);
  const u8 = SEGENV.data;
  const DG = dataSize >> 2; // dying_gravity

  if (dataSize !== SEGENV.aux1) { // reset to flare if sparks were reallocated
    f32[DG] = 0;
    SEGENV.aux0 = 0;
    SEGENV.aux1 = dataSize;
  }

  SEGMENT.fade_out(252);

  // flare = sparks[0]
  let gravity = f(f(-0.0004) - f(SEGMENT.speed / f(800000.0))); // m/s/s
  gravity = f(gravity * rows);

  if (SEGENV.aux0 < 2) { // FLARE
    if (SEGENV.aux0 === 0) { // init flare
      f32[0] = 0;
      f32[1] = is2D ? hw_random16(2, cols - 3) : (SEGMENT.intensity > hw_random8() ? 1 : 0); // will enable random firing side on 1D
      let peakHeight = 75 + hw_random8(180); // 0-255
      peakHeight = (peakHeight * (rows - 1)) >> 8;
      f32[2] = Math.sqrt(f(f(f(-2.0) * gravity) * peakHeight));
      f32[3] = is2D ? f((hw_random8(9) - 4) / f(64.0)) : 0; // no X velocity on 1D
      u16[8] = 255; // brightness
      SEGENV.aux0 = 1;
    }

    // launch
    if (f32[2]! > f(12 * gravity)) {
      const col = u16[8]! & 0xff;
      if (is2D) SEGMENT.setPixelColorXY(Math.trunc(f32[1]!) >>> 0, rows - (Math.trunc(f32[0]!) & 0xffff) - 1, RGBW32(col, col, col));
      else SEGMENT.setPixelColor(f32[1]! > 0 ? rows - Math.trunc(f32[0]!) - 1 : Math.trunc(f32[0]!), RGBW32(col, col, col));
      f32[0] = f32[0]! + f32[2]!;
      f32[0] = f32[0]! < 0 ? 0 : f32[0]! > rows - 1 ? rows - 1 : f32[0]!;
      if (is2D) {
        f32[1] = f32[1]! + f32[3]!;
        f32[1] = f32[1]! < 0 ? 0 : f32[1]! > cols - 1 ? cols - 1 : f32[1]!;
      }
      f32[2] = f32[2]! + gravity;
      u16[8] = u16[8]! - 2;
    } else {
      SEGENV.aux0 = 2; // ready to explode
    }
  } else if (SEGENV.aux0 < 4) {
    // Explode! Explosion happens where the flare ended. Size is proportional to the height.
    let nSparks = Math.trunc(f(f32[0]! + hw_random8(4))) >>> 0;
    nSparks = Math.max(nSparks, 4);
    nSparks = Math.min(nSparks, numSparks);

    // initialize sparks
    if (SEGENV.aux0 === 2) {
      for (let i = 1; i < nSparks; i++) {
        const o = i * 5;
        f32[o] = f32[0]!;
        f32[o + 1] = f32[1]!;
        f32[o + 2] = f(f(hw_random16(20001) / f(10000.0)) - f(0.9)); // from -0.9 to 1.1
        f32[o + 2] = f32[o + 2]! * (rows < 32 ? 0.5 : 1); // reduce velocity for smaller strips
        f32[o + 3] = is2D ? f(f(hw_random16(20001) / f(10000.0)) - 1) : 0; // from -1 to 1
        u16[i * 10 + 8] = 345; // set colors before scaling velocity to keep them bright
        u8[i * SPARK_SIZE + 18] = hw_random8();
        f32[o + 2] = f32[o + 2]! * f(f32[0]! / rows); // proportional to height
        f32[o + 3] = f32[o + 3]! * (is2D ? f(f32[1]! / cols) : 0); // proportional to width
        f32[o + 2] = f32[o + 2]! * f(-gravity * 50);
      }
      f32[DG] = gravity / 2;
      SEGENV.aux0 = 3;
    }

    if (u16[10 + 8]! > 4) { // as long as our known spark is lit, work with all the sparks
      for (let i = 1; i < nSparks; i++) {
        const o = i * 5;
        f32[o] = f32[o]! + f32[o + 2]!;
        f32[o + 1] = f32[o + 1]! + f32[o + 3]!;
        f32[o + 2] = f32[o + 2]! + f32[DG]!;
        f32[o + 3] = f32[o + 3]! + (is2D ? f32[DG]! : 0);
        if (u16[i * 10 + 8]! > 3) u16[i * 10 + 8] = u16[i * 10 + 8]! - 4;

        const pos = f32[o]!, posX = f32[o + 1]!;
        if (pos > 0 && pos < rows) {
          if (is2D && !(posX >= 0 && posX < cols)) continue;
          const prog = u16[i * 10 + 8]!;
          const spColor = SEGMENT.palette ? SEGMENT.color_wheel(u8[i * SPARK_SIZE + 18]!) : SEGCOLOR(0);
          let c = BLACK;
          if (prog > 300) { // fade from white to spark color
            c = color_blend(spColor, WHITE, (prog - 300) * 5);
          } else if (prog > 45) { // fade from spark color to black
            c = color_blend(BLACK, spColor, prog - 45);
            const cooling = (300 - prog) >> 5;
            c = RGBW32(R(c), qsub8(G(c), cooling), qsub8(B(c), cooling * 2), W(c));
          }
          if (is2D) SEGMENT.setPixelColorXY(Math.trunc(posX), rows - Math.trunc(pos) - 1, c);
          else SEGMENT.setPixelColor(Math.trunc(posX) ? rows - Math.trunc(pos) - 1 : Math.trunc(pos), c);
        }
      }
      if (SEGMENT.check3) SEGMENT.blur(16);
      f32[DG] = f32[DG]! * f(0.8); // as sparks burn out they fall slower
    } else {
      SEGENV.aux0 = 6 + hw_random8(10); // wait for this many frames
    }
  } else {
    SEGENV.aux0--;
    if (SEGENV.aux0 < 4) {
      SEGENV.aux0 = 0; // back to flare
    }
  }
}

export const FX2D: EffectDef[] = [
  wledEffect({
    meta: 'Rain@!,Spawning rate;!,!;!;12;ix=128,pal=0',
    mode: mode_rain,
    category: 'Twinkle & Sparkle',
    description: 'Coloured sparks appear at random and drift along the lights like falling rain.',
  }),
  wledEffect({
    meta: 'Fireworks@,Frequency;!,!;!;12;ix=192,pal=11',
    mode: mode_fireworks,
    category: 'Fire & Fireworks',
    description: 'Bright sparks of colour pop up at random spots and slowly fade out.',
  }),
  wledEffect({
    meta: 'Palette@Shift,Size,Rotation,,,Animate Shift,Animate Rotation,Anamorphic;;!;12;ix=112,c1=0,o1=1,o2=0,o3=1',
    mode: mode_palette,
    category: 'Waves & Patterns',
    description: 'The whole palette is spread along the lights and slowly slides through them.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Halloween Eyes@Eye off time,Eye on time,,,,,Overlay;!,!;!;12',
    mode: mode_halloween_eyes,
    category: 'Twinkle & Sparkle',
    description: 'A pair of glowing eyes opens somewhere on the house, blinks now and then, and vanishes.',
  }),
  wledEffect({
    meta: 'Fireworks 1D@Gravity,Firing side;!,!;!;12;pal=11,ix=128',
    mode: mode_exploding_fireworks,
    category: 'Fire & Fireworks',
    description: 'A rocket climbs along the lights and bursts into a shower of falling, fading sparks.',
  }),
  wledEffect({
    meta: 'Ripple Rainbow@!,Wave #;;!;12',
    mode: mode_ripple_rainbow,
    category: 'Waves & Patterns',
    description: 'Ripples spread from random spots over a dim background that slowly cycles through the rainbow.',
  }),
  ...FX2D_B,
];
