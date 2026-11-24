// Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/FX.cpp. Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.

import type { EffectDef } from '../../effects.js';
import { B, CHSV32, color_add, color_blend, G, gamma32inv, gamma8inv, R, RGBW32, W, WHITE } from '../color.js';
import { wledEffect } from '../define.js';
import { beat88, constrain, cos8_t, get_random_wheel_index, hw_random, hw_random16, hw_random8, map, perlin16, sin16_t, sin8_t, triwave16 } from '../math.js';
import { FRAMETIME, PALETTE_SOLID_WRAP, SEGCOLOR, SEGENV, SEGLEN, SEGMENT, strip } from '../segment.js';

const FALLBACK_STATIC = (): void => { SEGMENT.fill(SEGCOLOR(0)); };

// effect utility functions
function sin_gap(inp: number): number {
  inp &= 0xffff;
  if (inp & 0x100) return 0;
  return sin8_t(inp + 192); // correct phase shift of sine so that it starts and stops at 0
}

/*
 * Blink/strobe function
 * Alternate between color1 and color2
 * if(strobe == true) then create a strobe effect
 */
function blink(color1: number, color2: number, strobe: boolean, do_palette: boolean): void {
  let cycleTime = ((255 - SEGMENT.speed) * 20) >>> 0;
  let onTime = FRAMETIME;
  if (!strobe) onTime += (cycleTime * SEGMENT.intensity) >>> 8;
  cycleTime += FRAMETIME * 2;
  const it = Math.floor(strip.now / cycleTime) >>> 0;
  const rem = strip.now % cycleTime;

  let on = false;
  if (it !== SEGENV.step // new iteration, force on state for one frame, even if set time is too brief
      || rem <= onTime) {
    on = true;
  }

  SEGENV.step = it; // save previous iteration

  const color = on ? color1 : color2;
  if (color === color1 && do_palette) {
    for (let i = 0; i < SEGLEN; i++) {
      SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 0));
    }
  } else SEGMENT.fill(color);
}

/*
 * Classic Blink effect. Cycling through the rainbow.
 */
function mode_blink_rainbow(): void {
  blink(SEGMENT.color_wheel(SEGENV.call & 0xff), SEGCOLOR(1), false, false);
}

/*
 * Classic Strobe effect.
 */
function mode_strobe(): void {
  blink(SEGCOLOR(0), SEGCOLOR(1), true, true);
}

/*
 * Classic Strobe effect. Cycling through the rainbow.
 */
function mode_strobe_rainbow(): void {
  blink(SEGMENT.color_wheel(SEGENV.call & 0xff), SEGCOLOR(1), true, false);
}

/*
 * Color wipe function
 * LEDs are turned on (color1) in sequence, then turned off (color2) in sequence.
 * if (bool rev == true) then LEDs are turned off in reverse order
 */
function color_wipe(rev: boolean, useRandomColors: boolean): void {
  if (SEGLEN <= 1) return FALLBACK_STATIC();
  const cycleTime = (750 + (255 - SEGMENT.speed) * 150) >>> 0;
  const perc = strip.now % cycleTime;
  let prog = Math.trunc((perc * 65535) / cycleTime);
  const back = prog > 32767;
  if (back) {
    prog -= 32767;
    if (SEGENV.step === 0) SEGENV.step = 1;
  } else {
    if (SEGENV.step === 2) SEGENV.step = 3; // trigger color change
  }

  if (useRandomColors) {
    if (SEGENV.call === 0) {
      SEGENV.aux0 = hw_random8();
      SEGENV.step = 3;
    }
    if (SEGENV.step === 1) { // if flag set, change to new random color
      SEGENV.aux1 = get_random_wheel_index(SEGENV.aux0);
      SEGENV.step = 2;
    }
    if (SEGENV.step === 3) {
      SEGENV.aux0 = get_random_wheel_index(SEGENV.aux1);
      SEGENV.step = 0;
    }
  }

  const ledIndex = (prog * SEGLEN) >>> 15;
  let rem = ((prog * SEGLEN) * 2) & 0xffff; // mod 0xFFFF by truncating
  rem = Math.trunc(rem / (SEGMENT.intensity + 1));
  if (rem > 255) rem = 255;

  const col1 = useRandomColors ? SEGMENT.color_wheel(SEGENV.aux1) : SEGCOLOR(1);
  for (let i = 0; i < SEGLEN; i++) {
    const index = (rev && back) ? SEGLEN - 1 - i : i;
    const col0 = useRandomColors ? SEGMENT.color_wheel(SEGENV.aux0) : SEGMENT.color_from_palette(index, true, PALETTE_SOLID_WRAP, 0);

    if (i < ledIndex) {
      SEGMENT.setPixelColor(index, back ? col1 : col0);
    } else {
      SEGMENT.setPixelColor(index, back ? col0 : col1);
      if (i === ledIndex) SEGMENT.setPixelColor(index, color_blend(back ? col0 : col1, back ? col1 : col0, rem & 0xff));
    }
  }
}

function mode_color_wipe(): void { color_wipe(false, false); }
function mode_color_sweep(): void { color_wipe(true, false); }
function mode_color_wipe_random(): void { color_wipe(false, true); }
function mode_color_sweep_random(): void { color_wipe(true, true); }

/*
 * Lights all LEDs up in one random color. Then switches them
 * to the next random color.
 */
function mode_random_color(): void {
  const cycleTime = (200 + (255 - SEGMENT.speed) * 50) >>> 0;
  const it = Math.floor(strip.now / cycleTime) >>> 0;
  const rem = strip.now % cycleTime;
  const fadedur = (cycleTime * SEGMENT.intensity) >>> 8;

  let fade = 255;
  if (fadedur) {
    fade = Math.trunc((rem * 255) / fadedur);
    if (fade > 255) fade = 255;
  }

  if (SEGENV.call === 0) {
    SEGENV.aux0 = hw_random8();
    SEGENV.step = 2;
  }
  if (it !== SEGENV.step) { // new color
    SEGENV.aux1 = SEGENV.aux0;
    SEGENV.aux0 = get_random_wheel_index(SEGENV.aux0); // aux0 will store our random color wheel index
    SEGENV.step = it;
  }

  SEGMENT.fill(color_blend(SEGMENT.color_wheel(SEGENV.aux1), SEGMENT.color_wheel(SEGENV.aux0), fade & 0xff));
}

/*
 * Lights every LED in a random color. Changes all LED at the same time
 * to new random colors.
 */
function mode_dynamic(): void {
  if (!SEGENV.allocateData(SEGLEN)) return FALLBACK_STATIC(); // allocation failed
  const data = SEGENV.data;

  if (SEGENV.call === 0) {
    for (let i = 0; i < SEGLEN; i++) data[i] = hw_random8();
  }

  const cycleTime = (50 + (255 - SEGMENT.speed) * 15) >>> 0;
  const it = Math.floor(strip.now / cycleTime) >>> 0;
  if (it !== SEGENV.step && SEGMENT.speed !== 0) { // new color
    for (let i = 0; i < SEGLEN; i++) {
      if (hw_random8() <= SEGMENT.intensity) data[i] = hw_random8(); // random color index
    }
    SEGENV.step = it;
  }

  if (SEGMENT.check1) {
    for (let i = 0; i < SEGLEN; i++) {
      SEGMENT.blendPixelColor(i, SEGMENT.color_wheel(data[i]!), 16);
    }
  } else {
    for (let i = 0; i < SEGLEN; i++) {
      SEGMENT.setPixelColor(i, SEGMENT.color_wheel(data[i]!));
    }
  }
}

/*
 * Does the "standby-breathing" of well known i-Devices.
 */
function mode_breath(): void {
  let v = 0;
  let counter = Math.imul(strip.now, (SEGMENT.speed >> 3) + 10) & 0xffff;
  counter = (counter >> 2) + (counter >> 4); // 0-16384 + 0-2048
  if (counter < 16384) {
    if (counter > 8192) counter = 8192 - (counter - 8192);
    v = Math.trunc(sin16_t(counter) / 103); // close to parabolic in range 0-8192, max val. 23170
  }

  const lum = (30 + v) & 0xff;
  for (let i = 0; i < SEGLEN; i++) {
    SEGMENT.setPixelColor(i, color_blend(SEGCOLOR(1), SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 0), lum));
  }
}

/*
 * Fades the LEDs between two colors
 */
function mode_fade(): void {
  const counter = Math.imul(strip.now, (SEGMENT.speed >> 3) + 10) >>> 0;
  const lum = triwave16(counter) >> 8;

  for (let i = 0; i < SEGLEN; i++) {
    SEGMENT.setPixelColor(i, color_blend(SEGCOLOR(1), SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 0), lum));
  }
}

/*
 * Scan mode parent function
 */
function scan(dual: boolean): void {
  if (SEGLEN <= 1) return FALLBACK_STATIC();
  const cycleTime = (750 + (255 - SEGMENT.speed) * 150) >>> 0;
  const perc = strip.now % cycleTime;
  const prog = Math.trunc((perc * 65535) / cycleTime);
  const size = 1 + ((SEGMENT.intensity * SEGLEN) >> 9);
  const ledIndex = Math.floor((prog * ((SEGLEN * 2) - size * 2)) / 65536);

  if (!SEGMENT.check2) SEGMENT.fill(SEGCOLOR(1));

  let led_offset = ledIndex - (SEGLEN - size);
  led_offset = Math.abs(led_offset);

  if (dual) {
    for (let j = led_offset; j < led_offset + size; j++) {
      const i2 = SEGLEN - 1 - j;
      SEGMENT.setPixelColor(i2, SEGMENT.color_from_palette(i2, true, PALETTE_SOLID_WRAP, SEGCOLOR(2) ? 2 : 0));
    }
  }

  for (let j = led_offset; j < led_offset + size; j++) {
    SEGMENT.setPixelColor(j, SEGMENT.color_from_palette(j, true, PALETTE_SOLID_WRAP, 0));
  }
}

function mode_scan(): void { scan(false); }
function mode_dual_scan(): void { scan(true); }

/*
 * Cycles all LEDs at once through a rainbow.
 */
function mode_rainbow(): void {
  let counter = Math.imul(strip.now, (SEGMENT.speed >> 2) + 2) & 0xffff;
  counter = counter >> 8;

  if (SEGMENT.intensity < 128) {
    SEGMENT.fill(color_blend(SEGMENT.color_wheel(counter), WHITE, (128 - SEGMENT.intensity) & 0xff));
  } else {
    SEGMENT.fill(SEGMENT.color_wheel(counter));
  }
}

/*
 * Cycles a rainbow over the entire string of LEDs.
 */
function mode_rainbow_cycle(): void {
  let counter = Math.imul(strip.now, (SEGMENT.speed >> 2) + 2) & 0xffff;
  counter = counter >> 8;

  const mult = 16 << Math.trunc(SEGMENT.intensity / 29);
  for (let i = 0; i < SEGLEN; i++) {
    // intensity/29 = 0 (1/16) 1 (1/8) 2 (1/4) 3 (1/2) 4 (1) 5 (2) 6 (4) 7 (8) 8 (16)
    const index = (Math.trunc((i * mult) / SEGLEN) + counter) & 0xff;
    SEGMENT.setPixelColor(i, SEGMENT.color_wheel(index));
  }
}

/*
 * Alternating pixels running function.
 */
function running(color1: number, color2: number, theatre = false): void {
  const width = (theatre ? 3 : 1) + (SEGMENT.intensity >> 4); // window
  const cycleTime = 50 + (255 - SEGMENT.speed);
  const it = Math.floor(strip.now / cycleTime) >>> 0;
  const usePalette = color1 === SEGCOLOR(0);

  for (let i = 0; i < SEGLEN; i++) {
    let col = color2;
    if (usePalette) color1 = SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 0);
    if (theatre) {
      if ((i % width) === SEGENV.aux0) col = color1;
    } else {
      const pos = i % (width << 1);
      if ((pos < SEGENV.aux0 - width) || ((pos >= SEGENV.aux0) && (pos < SEGENV.aux0 + width))) col = color1;
    }
    SEGMENT.setPixelColor(i, col);
  }

  if (it !== SEGENV.step) {
    SEGENV.aux0 = (SEGENV.aux0 + 1) % (theatre ? width : (width << 1));
    SEGENV.step = it;
  }
}

/*
 * Theatre-style crawling lights.
 * Inspired by the Adafruit examples.
 */
function mode_theater_chase(): void {
  running(SEGCOLOR(0), SEGCOLOR(1), true);
}

/*
 * Theatre-style crawling lights with rainbow effect.
 * Inspired by the Adafruit examples.
 */
function mode_theater_chase_rainbow(): void {
  running(SEGMENT.color_wheel(SEGENV.step & 0xff), SEGCOLOR(1), true);
}

/*
 * Alternating color/sec pixels running.
 */
function mode_running_color(): void {
  running(SEGCOLOR(0), SEGCOLOR(1));
}

/*
 * Running lights effect with smooth sine transition base.
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

function mode_running_lights(): void { running_base(false); }
function mode_saw(): void { running_base(true); }

/*
 * Blink several LEDs in random colors on, reset, repeat.
 * Inspired by www.tweaking4all.com/hardware/arduino/adruino-led-strip-effects/
 */
function mode_twinkle(): void {
  SEGMENT.fade_out(224);

  const cycleTime = (20 + (255 - SEGMENT.speed) * 5) >>> 0;
  const it = Math.floor(strip.now / cycleTime) >>> 0;
  if (it !== SEGENV.step) {
    const maxOn = map(SEGMENT.intensity, 0, 255, 1, SEGLEN) >>> 0; // make sure at least one LED is on
    if (SEGENV.aux0 >= maxOn) {
      SEGENV.aux0 = 0;
      SEGENV.aux1 = hw_random(); // new seed for our PRNG
    }
    SEGENV.aux0++;
    SEGENV.step = it;
  }

  let PRNG16 = SEGENV.aux1;

  for (let i = 0; i < SEGENV.aux0; i++) {
    PRNG16 = ((Math.imul(PRNG16, 2053) & 0xffff) + 13849) & 0xffff; // next 'random' number
    const p = (SEGLEN * PRNG16) >>> 0;
    const j = p >>> 16;
    SEGMENT.setPixelColor(j, SEGMENT.color_from_palette(j, true, PALETTE_SOLID_WRAP, 0));
  }
}

/*
 * Dissolve function
 */
function dissolve(color: number): void {
  const dataSize = 4 * SEGLEN;
  if (!SEGENV.allocateData(dataSize)) return FALLBACK_STATIC(); // allocation failed
  const pixels = SEGENV.view(Uint32Array);

  if (SEGENV.call === 0) {
    for (let i = 0; i < SEGLEN; i++) pixels[i] = SEGCOLOR(1);
    SEGENV.aux0 = 1;
  }

  for (let j = 0; j <= Math.trunc(SEGLEN / 15); j++) {
    if (hw_random8() <= SEGMENT.intensity) {
      for (let times = 0; times < 10; times++) { // attempt to spawn a new pixel 10 times
        const i = hw_random16(SEGLEN);
        if (SEGENV.aux0) { // dissolve to primary/palette
          if (pixels[i] === SEGCOLOR(1)) {
            let c = color === SEGCOLOR(0) ? SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 0) : color;
            if (SEGMENT.check2 && c === SEGCOLOR(1)) c = (c ^ 0x00000001) >>> 0; // change the color slightly so the effect doesn't get stuck in Complete mode if color is same as bkg color
            pixels[i] = c;
            break; // only spawn 1 new pixel per frame
          }
        } else { // dissolve to secondary
          if (pixels[i] !== SEGCOLOR(1)) {
            pixels[i] = SEGCOLOR(1);
            break;
          }
        }
      }
    }
  }
  let incompletePixels = 0;
  for (let i = 0; i < SEGLEN; i++) {
    SEGMENT.setPixelColor(i, pixels[i]!); // fix for #4401
    if (SEGMENT.check2) {
      if (SEGENV.aux0) {
        if (pixels[i] === SEGCOLOR(1)) incompletePixels++;
      } else {
        if (pixels[i] !== SEGCOLOR(1)) incompletePixels++;
      }
    }
  }

  if (SEGENV.step > (255 - SEGMENT.speed) + 15) {
    SEGENV.aux0 = SEGENV.aux0 ? 0 : 1;
    SEGENV.step = 0;
  } else {
    if (SEGMENT.check2) {
      if (incompletePixels === 0) SEGENV.step++; // only advance step once all pixels have changed
    } else SEGENV.step++;
  }
}

/*
 * Blink several LEDs on and then off
 */
function mode_dissolve(): void {
  dissolve(SEGMENT.check1 ? SEGMENT.color_wheel(hw_random8()) : SEGCOLOR(0));
}

/*
 * Blink several LEDs on and then off in random colors
 */
function mode_dissolve_random(): void {
  dissolve(SEGMENT.color_wheel(hw_random8()));
}

/*
 * Lights all LEDs in the color. Flashes single col 1 pixels randomly. (List name: Sparkle Dark)
 * Inspired by www.tweaking4all.com/hardware/arduino/adruino-led-strip-effects/
 */
function mode_flash_sparkle(): void {
  if (!SEGMENT.check2) for (let i = 0; i < SEGLEN; i++) {
    SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 0));
  }

  if (((strip.now - SEGENV.aux0) >>> 0) > SEGENV.step) {
    if (hw_random8((255 - SEGMENT.intensity) >> 4) === 0) {
      SEGMENT.setPixelColor(hw_random16(SEGLEN), SEGCOLOR(1)); // flash
    }
    SEGENV.step = strip.now;
    SEGENV.aux0 = 255 - SEGMENT.speed;
  }
}

/*
 * Like flash sparkle. With more flash.
 * Inspired by www.tweaking4all.com/hardware/arduino/adruino-led-strip-effects/
 */
function mode_hyper_sparkle(): void {
  if (!SEGMENT.check2) for (let i = 0; i < SEGLEN; i++) {
    SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 0));
  }

  if (((strip.now - SEGENV.aux0) >>> 0) > SEGENV.step) {
    if (hw_random8((255 - SEGMENT.intensity) >> 4) === 0) {
      const len = Math.max(1, Math.trunc(SEGLEN / 3));
      for (let i = 0; i < len; i++) {
        SEGMENT.setPixelColor(hw_random16(SEGLEN), SEGCOLOR(1));
      }
    }
    SEGENV.step = strip.now;
    SEGENV.aux0 = 255 - SEGMENT.speed;
  }
}

/*
 * Strobe effect with different strobe count and pause, controlled by speed.
 */
function mode_multi_strobe(): void {
  for (let i = 0; i < SEGLEN; i++) {
    SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 1));
  }

  SEGENV.aux0 = 50 + 20 * (255 - SEGMENT.speed);
  const count = 2 * (Math.trunc(SEGMENT.intensity / 10) + 1);
  if (SEGENV.aux1 < count) {
    if ((SEGENV.aux1 & 1) === 0) {
      SEGMENT.fill(SEGCOLOR(0));
      SEGENV.aux0 = 15;
    } else {
      SEGENV.aux0 = 50;
    }
  }

  if (((strip.now - SEGENV.aux0) >>> 0) > SEGENV.step) {
    SEGENV.aux1++;
    if (SEGENV.aux1 > count) SEGENV.aux1 = 0;
    SEGENV.step = strip.now;
  }
}

/*
 * Android loading circle, refactored by @dedehai
 */
function mode_android(): void {
  if (!SEGENV.allocateData(4)) return FALLBACK_STATIC();
  const counter = SEGENV.view(Uint32Array); // uint32_t* counter = counter[0]
  let size = SEGENV.aux1 >> 1; // upper 15 bit
  let shrinking = SEGENV.aux1 & 0x01; // lowest bit
  if (strip.now >= SEGENV.step) {
    SEGENV.step = strip.now + 3 + Math.trunc((8 * (255 - SEGMENT.speed)) / SEGLEN);
    if (size > Math.trunc((SEGMENT.intensity * SEGLEN) / 255))
      shrinking = 1;
    else if (size < 2)
      shrinking = 0;
    if (!shrinking) { // growing
      if ((counter[0]! % 3) === 1)
        SEGENV.aux0++; // advance start position
      else
        size++;
    } else { // shrinking
      SEGENV.aux0++;
      if ((counter[0]! % 3) !== 1)
        size--;
    }
    SEGENV.aux1 = (size << 1) | shrinking; // save back
    counter[0] = counter[0]! + 1;
    if (SEGENV.aux0 >= SEGLEN) SEGENV.aux0 = 0;
  }
  const start = SEGENV.aux0;
  const end = (SEGENV.aux0 + size) % SEGLEN;
  for (let i = 0; i < SEGLEN; i++) {
    if ((start < end && i >= start && i < end) || (start >= end && (i >= start || i < end)))
      SEGMENT.setPixelColor(i, SEGCOLOR(0));
    else
      SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 1));
  }
}

/*
 * color chase function.
 * color1 = background color
 * color2 and color3 = colors of two adjacent leds
 * (C checks SEGMENT.mode == FX_MODE_CHASE_RANDOM; here the caller passes chase_random.)
 */
function chase(color1: number, color2: number, color3: number, do_palette: boolean, chase_random = false): void {
  const counter = Math.imul(strip.now, (SEGMENT.speed >> 2) + 1) & 0xffff;
  const a = ((counter * SEGLEN) >>> 16) & 0xffff;

  if (chase_random) {
    if (a < SEGENV.step) { // we hit the start again, choose new color for Chase random
      SEGENV.aux1 = SEGENV.aux0; // store previous random color
      SEGENV.aux0 = get_random_wheel_index(SEGENV.aux0);
    }
    color1 = SEGMENT.color_wheel(SEGENV.aux0);
  }
  SEGENV.step = a;

  // Use intensity setting to vary chase up to 1/2 string length
  const size = 1 + ((SEGMENT.intensity * SEGLEN) >> 10);

  let b = (a + size) & 0xffff; // "trail" of chase, filled with color1
  if (b > SEGLEN) b = (b - SEGLEN) & 0xffff;
  let c = (b + size) & 0xffff;
  if (c > SEGLEN) c = (c - SEGLEN) & 0xffff;

  // background
  if (do_palette) {
    for (let i = 0; i < SEGLEN; i++) {
      SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 1));
    }
  } else SEGMENT.fill(color1);

  // if random, fill old background between a and end
  if (chase_random) {
    color1 = SEGMENT.color_wheel(SEGENV.aux1);
    for (let i = a; i < SEGLEN; i++)
      SEGMENT.setPixelColor(i, color1);
  }

  // fill between points a and b with color2
  if (a < b) {
    for (let i = a; i < b; i++)
      SEGMENT.setPixelColor(i, color2);
  } else {
    for (let i = a; i < SEGLEN; i++) // fill until end
      SEGMENT.setPixelColor(i, color2);
    for (let i = 0; i < b; i++) // fill from start until b
      SEGMENT.setPixelColor(i, color2);
  }

  // fill between points b and c with color2
  if (b < c) {
    for (let i = b; i < c; i++)
      SEGMENT.setPixelColor(i, color3);
  } else {
    for (let i = b; i < SEGLEN; i++) // fill until end
      SEGMENT.setPixelColor(i, color3);
    for (let i = 0; i < c; i++) // fill from start until c
      SEGMENT.setPixelColor(i, color3);
  }
}

/*
 * Bicolor chase, more primary color.
 */
function mode_chase_color(): void {
  chase(SEGCOLOR(1), SEGCOLOR(2) ? SEGCOLOR(2) : SEGCOLOR(0), SEGCOLOR(0), true);
}

/*
 * Primary running followed by random color.
 */
function mode_chase_random(): void {
  chase(SEGCOLOR(1), SEGCOLOR(2) ? SEGCOLOR(2) : SEGCOLOR(0), SEGCOLOR(0), false, true);
}

/*
 * Primary, secondary running on rainbow.
 */
function mode_chase_rainbow(): void {
  let color_sep = Math.trunc(256 / SEGLEN);
  if (color_sep === 0) color_sep = 1; // correction for segments longer than 256 LEDs
  const color_index = SEGENV.call & 0xff;
  const color = SEGMENT.color_wheel(((SEGENV.step * color_sep) + color_index) & 0xff);

  chase(color, SEGCOLOR(0), SEGCOLOR(1), false);
}

/*
 * Primary running on rainbow.
 */
function mode_chase_rainbow_white(): void {
  const n = SEGENV.step & 0xffff;
  const m = ((SEGENV.step + 1) % SEGLEN) & 0xffff;
  const color2 = SEGMENT.color_wheel((Math.trunc((n * 256) / SEGLEN) + (SEGENV.call & 0xff)) & 0xff);
  const color3 = SEGMENT.color_wheel((Math.trunc((m * 256) / SEGLEN) + (SEGENV.call & 0xff)) & 0xff);

  chase(SEGCOLOR(0), color2, color3, false);
}

/*
 * Red - Amber - Green - Blue lights running
 */
const colorfulCols = new Uint32Array(9);
function mode_colorful(): void {
  let numColors = 4; // 3, 4, or 5
  const cols = colorfulCols;
  cols.fill(0);
  cols[0] = 0x00ff0000; cols[1] = 0x00eebb00; cols[2] = 0x0000ee00; cols[3] = 0x000077cc;
  if (SEGMENT.intensity > 160 || SEGMENT.palette) { // palette or color
    if (!SEGMENT.palette) {
      numColors = 3;
      for (let i = 0; i < 3; i++) cols[i] = SEGCOLOR(i);
    } else {
      let fac = 80;
      if (SEGMENT.palette === 52) { numColors = 5; fac = 61; } // C9 2 has 5 colors
      for (let i = 0; i < numColors; i++) {
        cols[i] = SEGMENT.color_from_palette(i * fac, false, true, 255);
      }
    }
  } else if (SEGMENT.intensity < 80) { // pastel (easter) colors
    cols[0] = 0x00ff8040;
    cols[1] = 0x00e5d241;
    cols[2] = 0x0077ff77;
    cols[3] = 0x0077f0f0;
  }
  for (let i = numColors; i < numColors * 2 - 1; i++) cols[i] = cols[i - numColors]!;

  const cycleTime = 50 + 8 * (255 - SEGMENT.speed);
  const it = Math.floor(strip.now / cycleTime) >>> 0;
  if (it !== SEGENV.step) {
    if (SEGMENT.speed > 0) SEGENV.aux0++;
    if (SEGENV.aux0 >= numColors) SEGENV.aux0 = 0;
    SEGENV.step = it;
  }

  for (let i = 0; i < SEGLEN; i += numColors) {
    for (let j = 0; j < numColors; j++) SEGMENT.setPixelColor(i + j, cols[SEGENV.aux0 + j]!);
  }
}

/*
 * Emulates a traffic light.
 */
function mode_traffic_light(): void {
  if (SEGLEN <= 1) return FALLBACK_STATIC();
  for (let i = 0; i < SEGLEN; i++)
    SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 1));
  let mdelay = 500;
  for (let i = 0; i < SEGLEN - 2; i += 3) {
    switch (SEGENV.aux0) {
      case 0: SEGMENT.setPixelColor(i, 0x00ff0000); mdelay = 150 + 100 * (255 - SEGMENT.speed); break;
      case 1: SEGMENT.setPixelColor(i, 0x00ff0000); mdelay = 150 + 20 * (255 - SEGMENT.speed); SEGMENT.setPixelColor(i + 1, 0x00eecc00); break;
      case 2: SEGMENT.setPixelColor(i + 2, 0x0000ff00); mdelay = 150 + 100 * (255 - SEGMENT.speed); break;
      case 3: SEGMENT.setPixelColor(i + 1, gamma32inv(0x00eecc00)); mdelay = 150 + 20 * (255 - SEGMENT.speed); break; // gamma inversion to restore original pre 16.0 looks
    }
  }

  if (((strip.now - SEGENV.step) >>> 0) > mdelay) {
    SEGENV.aux0++;
    if (SEGENV.aux0 === 1 && SEGMENT.intensity > 140) SEGENV.aux0 = 2; // skip Red + Amber, to get US-style sequence
    if (SEGENV.aux0 > 3) SEGENV.aux0 = 0;
    SEGENV.step = strip.now;
  }
}

/*
 * Sec flashes running on prim.
 */
const FLASH_COUNT = 4;
function mode_chase_flash(): void {
  if (SEGLEN <= 1) return FALLBACK_STATIC();
  const now = strip.now; // save time for delay calculation
  let advance = true;
  const flash_step = SEGENV.aux1 % ((FLASH_COUNT * 2) + 1);
  if (now < SEGENV.step)
    advance = false; // limit update rate but render every frame for smooth transitions
  else
    SEGENV.aux1++;

  for (let i = 0; i < SEGLEN; i++) {
    SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(i, true, PALETTE_SOLID_WRAP, 0));
  }
  const index = SEGENV.aux0;
  const n = index;
  const m = (index + 1) % SEGLEN;

  let delay = 10 + Math.trunc((30 * (255 - SEGMENT.speed)) / SEGLEN);
  if (flash_step < (FLASH_COUNT * 2)) {
    if (flash_step % 2 === 0) {
      SEGMENT.setPixelColor(n, SEGCOLOR(1));
      SEGMENT.setPixelColor(m, SEGCOLOR(1));
      delay = 20;
    } else {
      delay = 30;
    }
  } else if (advance) {
    SEGENV.aux0 = m; // advance to next position
  }
  if (advance)
    SEGENV.step = now + delay; // set next update time
}

/*
 * Prim flashes running, followed by random color.
 */
function mode_chase_flash_random(): void {
  if (SEGLEN <= 1) return FALLBACK_STATIC();
  const now = strip.now; // save time for delay calculation
  let advance = true;
  if (now < SEGENV.step) {
    SEGENV.call--; // revert increment to skip moving the animation forward and just render the same frame again
    advance = false;
  }
  const flash_step = SEGENV.call % ((FLASH_COUNT * 2) + 1);

  for (let i = 0; i < SEGENV.aux1; i++) {
    SEGMENT.setPixelColor(i, SEGMENT.color_wheel(SEGENV.aux0));
  }

  let delay = 1 + Math.trunc((10 * (255 - SEGMENT.speed)) / SEGLEN);
  if (flash_step < (FLASH_COUNT * 2)) {
    const n = SEGENV.aux1;
    const m = (SEGENV.aux1 + 1) % SEGLEN;
    if (flash_step % 2 === 0) {
      SEGMENT.setPixelColor(n, SEGCOLOR(0));
      SEGMENT.setPixelColor(m, SEGCOLOR(0));
      delay = 20;
    } else {
      SEGMENT.setPixelColor(n, SEGMENT.color_wheel(SEGENV.aux0));
      SEGMENT.setPixelColor(m, SEGCOLOR(1));
      delay = 30;
    }
  } else if (advance) {
    SEGENV.aux1 = (SEGENV.aux1 + 1) % SEGLEN;

    if (SEGENV.aux1 === 0) {
      SEGENV.aux0 = get_random_wheel_index(SEGENV.aux0);
    }
  }
  if (advance)
    SEGENV.step = now + delay; // set next update time
}

/*
 * Random colored pixels running. ("Stream")
 */
function mode_running_random(): void {
  const cycleTime = 25 + 3 * (255 - SEGMENT.speed);
  const it = Math.floor(strip.now / cycleTime) >>> 0;
  if (SEGENV.call === 0) SEGENV.aux0 = hw_random(); // random seed for PRNG on start

  const zoneSize = ((255 - SEGMENT.intensity) >> 4) + 1;
  let PRNG16 = SEGENV.aux0;

  let z = it % zoneSize;
  let nzone = !z && it !== SEGENV.aux1;
  for (let i = SEGLEN - 1; i >= 0; i--) {
    if (nzone || z >= zoneSize) {
      const lastrand = PRNG16 >> 8;
      let diff = 0;
      while (Math.abs(diff) < 42) { // make sure the difference between adjacent colors is big enough
        PRNG16 = ((Math.imul(PRNG16, 2053) & 0xffff) + 13849) & 0xffff; // next zone, next 'random' number
        diff = (((PRNG16 >> 8) - lastrand) << 16) >> 16; // int16_t of an unsigned difference
      }
      if (nzone) {
        SEGENV.aux0 = PRNG16; // save next starting seed
        nzone = false;
      }
      z = 0;
    }
    SEGMENT.setPixelColor(i, SEGMENT.color_wheel(PRNG16 >> 8));
    z++;
  }

  SEGENV.aux1 = it;
}

/*
  Aurora effect by @Mazen
  improved and converted to integer math by @dedehai
*/

// CONFIG
const W_MAX_COUNT = 20; // Number of simultaneous waves (ESP32)
const W_MAX_SPEED = 6; // Higher number, higher speed
const W_WIDTH_FACTOR = 6; // Higher number, smaller waves

// fixed-point math scaling
const AW_SHIFT = 16;
const AW_SCALE = 1 << AW_SHIFT; // 65536 representing 1.0

// class AuroraWave as laid out by GCC (28 bytes per wave, all fields naturally aligned):
//   0 int32 center | 4 uint32 ageFactor_cached | 8 uint16 ttl | 10 uint16 age | 12 uint16 width
//  14 uint16 basealpha | 16 uint16 speed_factor | 18 int16 wave_start | 20 int16 wave_end
//  22 bool goingleft | 23 bool alive | 24 CRGBW basecolor (uint32)
const AW_SIZE = 28;

function aw_init(dv: DataView, o: number, segment_length: number, color: number): void {
  dv.setUint16(o + 8, hw_random16(500, 1501), true); // ttl
  dv.setUint32(o + 24, color >>> 0, true); // basecolor
  dv.setUint16(o + 14, Math.trunc((hw_random8(60, 100) * AW_SCALE) / 100), true); // basealpha: 0-99%
  dv.setUint16(o + 10, 0, true); // age
  dv.setUint16(o + 12, (hw_random16(Math.trunc(segment_length / 20), Math.trunc(segment_length / W_WIDTH_FACTOR)) + 1) & 0xffff, true); // width
  dv.setInt32(o, Math.imul(Math.trunc(((hw_random8(101) << AW_SHIFT) >>> 0) / 100), segment_length), true); // center: 0-100%
  dv.setUint8(o + 22, hw_random8() & 0x01); // goingleft: 50/50 chance
  dv.setUint16(o + 16, Math.trunc(((hw_random8(10, 31) * W_MAX_SPEED) << AW_SHIFT) / (100 * 255)), true); // speed_factor
  dv.setUint8(o + 23, 1); // alive
}

function aw_updateCachedValues(dv: DataView, o: number): void {
  const ttl = dv.getUint16(o + 8, true), age = dv.getUint16(o + 10, true);
  const half_ttl = ttl >> 1;
  let ageFactor_cached: number;
  if (age < half_ttl) {
    ageFactor_cached = Math.trunc((age * AW_SCALE) / half_ttl);
  } else {
    ageFactor_cached = Math.trunc((((ttl - age) << AW_SHIFT) >>> 0) / half_ttl); // (uint32_t)(ttl - age) << 16
  }
  ageFactor_cached >>>= 0;
  if (ageFactor_cached >= AW_SCALE) ageFactor_cached = AW_SCALE - 1; // prevent overflow
  dv.setUint32(o + 4, ageFactor_cached, true);

  // uint32_t center_led = center >> 16 (arithmetic shift of the int32); (int16_t)center_led keeps its low 16 bits
  const center_led16 = ((dv.getInt32(o, true) >> AW_SHIFT) << 16) >> 16;
  const width16 = (dv.getUint16(o + 12, true) << 16) >> 16;
  dv.setInt16(o + 18, center_led16 - width16, true);
  dv.setInt16(o + 20, center_led16 + width16, true);
}

function aw_getColorForLED(dv: DataView, o: number, ledIndex: number): number {
  // linear brightness falloff from center to edge of wave
  if (ledIndex < dv.getInt16(o + 18, true) || ledIndex > dv.getInt16(o + 20, true)) return 0;
  const ledIndex_scaled = (ledIndex << AW_SHIFT) | 0;
  let offset = (ledIndex_scaled - dv.getInt32(o, true)) | 0;
  if (offset < 0) offset = -offset;
  const offsetFactor = Math.trunc(offset / dv.getUint16(o + 12, true)); // scaled by AW_SCALE
  if (offsetFactor > AW_SCALE) return 0; // outside of wave
  let brightness_factor = AW_SCALE - offsetFactor;
  brightness_factor = ((brightness_factor * dv.getUint32(o + 4, true)) >>> 0) >>> AW_SHIFT;
  brightness_factor = ((brightness_factor * dv.getUint16(o + 14, true)) >>> 0) >>> AW_SHIFT;

  const c = dv.getUint32(o + 24, true);
  return RGBW32(
    (R(c) * brightness_factor) >>> AW_SHIFT,
    (G(c) * brightness_factor) >>> AW_SHIFT,
    (B(c) * brightness_factor) >>> AW_SHIFT,
    (W(c) * brightness_factor) >>> AW_SHIFT,
  );
}

// Change position and age of wave; determine if it's still "alive"
function aw_update(dv: DataView, o: number, segment_length: number, speed: number): void {
  const step = Math.imul(dv.getUint16(o + 16, true), speed) | 0;
  const goingleft = dv.getUint8(o + 22) !== 0;
  const center = (dv.getInt32(o, true) + (goingleft ? -step : step)) | 0;
  dv.setInt32(o, center, true);
  const age = (dv.getUint16(o + 10, true) + 1) & 0xffff;
  dv.setUint16(o + 10, age, true);

  if (age > dv.getUint16(o + 8, true)) {
    dv.setUint8(o + 23, 0);
  } else {
    const width_scaled = (dv.getUint16(o + 12, true) << AW_SHIFT) >>> 0;
    const segment_length_scaled = (segment_length << AW_SHIFT) >>> 0;

    if (goingleft) {
      if (center < -(width_scaled | 0)) dv.setUint8(o + 23, 0);
    } else {
      if (center > (((segment_length_scaled | 0) + (width_scaled | 0)) | 0)) dv.setUint8(o + 23, 0);
    }
  }
}

function mode_aurora(): void {
  SEGENV.aux1 = map(SEGMENT.intensity, 0, 255, 2, W_MAX_COUNT); // aux1 = Wavecount
  if (!SEGENV.allocateData(AW_SIZE * SEGENV.aux1)) return FALLBACK_STATIC();
  const dv = SEGENV.dataView;

  // note: on first call, SEGENV.data is zero -> all waves are dead and will be initialized
  for (let i = 0; i < SEGENV.aux1; i++) {
    const o = i * AW_SIZE;
    aw_update(dv, o, SEGLEN, SEGMENT.speed);
    if (dv.getUint8(o + 23) === 0) {
      // C++ leaves the evaluation order of the two hw_random8() arguments unspecified; GCC evaluates
      // call arguments right to left, so the colour slot is drawn before the palette index.
      const mcol = hw_random8(0, 3);
      const idx = hw_random8();
      aw_init(dv, o, SEGLEN, SEGMENT.color_from_palette(idx, false, false, mcol));
    }
    aw_updateCachedValues(dv, o);
  }

  let backlight = 0; // note: original code used 1, with inverse gamma applied background would never be black
  if (SEGCOLOR(0)) backlight++;
  if (SEGCOLOR(1)) backlight++;
  if (SEGCOLOR(2)) backlight++;
  backlight = gamma8inv(backlight); // preserve backlight when using gamma correction

  const back = RGBW32(backlight, backlight, backlight);
  for (let i = 0; i < SEGLEN; i++) {
    let mixedRgb = back;
    for (let j = 0; j < SEGENV.aux1; j++) {
      const rgb = aw_getColorForLED(dv, j * AW_SIZE, i);
      mixedRgb = color_add(mixedRgb, rgb); // sum all waves influencing this pixel
    }
    SEGMENT.setPixelColor(i, mixedRgb);
  }
}

/** Softly floating colorful clouds.
 * This is a very smooth effect that moves colorful clouds randomly around the LED strip.
 * It was initially intended for rather unobtrusive ambient lights (with very slow speed settings).
 * Nevertheless, it appears completely different and quite vibrant when the sliders are moved near
 * to their limits. No matter in which direction or in which combination...
 * Ported to WLED from https://github.com/JoaDick/EyeCandy/blob/master/ColorClouds.h
 */
function mode_ColorClouds(): void {
  // Set random start points for clouds and color.
  if (SEGENV.call === 0) {
    SEGENV.aux0 = hw_random16();
    SEGENV.aux1 = hw_random16();
  }
  const volX0 = SEGENV.aux0;
  const hueX0 = SEGENV.aux1;
  const hueOffset0 = (volX0 + hueX0) & 0xff; // derive a 3rd random number

  // Makes a very soft wraparound of the color palette by putting more emphasis on the begin & end
  // of the palette (or on the red'ish colors in case of a rainbow spectrum).
  const cozy = SEGMENT.check3;
  const volSpeed = 1 + SEGMENT.speed; // Higher values make the clouds move faster.
  const hueSpeed = 1 + SEGMENT.intensity; // Higher values make the color change faster.
  const volSqueeze = 8 + SEGMENT.custom1; // Higher values make more clouds (but smaller ones).
  const hueSqueeze = SEGMENT.custom2; // Higher values make the clouds more colorful.

  // Higher values make larger gaps between the clouds.
  const volCutoff = 12500 + SEGMENT.custom3 * 900;
  const volSaturate = 52000;

  const now = strip.now;
  const volT = (Math.imul(now, volSpeed) >>> 0) >>> 3; // now * volSpeed / 8
  const hueT = (Math.imul(now, hueSpeed) >>> 0) >>> 3;
  const hueOffset = beat88(64) >> 8;

  for (let i = 0; i < SEGLEN; i++) {
    const volX = (i * volSqueeze * 64) >>> 0;
    let vol = perlin16((volX0 + volX) >>> 0, volT);
    vol = map(vol, volCutoff, volSaturate, 0, 255);
    vol = constrain(vol, 0, 255);

    const hueX = (i * hueSqueeze * 8) >>> 0;
    let hue = (perlin16((hueX0 + hueX) >>> 0, hueT) >> 7) & 0xff;
    hue = (hue + hueOffset0) & 0xff;
    hue = (hue + hueOffset) & 0xff;
    if (cozy) {
      hue = cos8_t(128 + (hue >> 1));
    }

    let pixel: number;
    if (SEGMENT.palette) { pixel = SEGMENT.color_from_palette(hue, false, true, 0, vol); }
    else { pixel = CHSV32(hue << 8, 255, vol); } // CHSV32(uint8_t h, ...) takes the 8-bit hue as h << 8

    // Suppress extremely dark pixels to avoid flickering of plain r/g/b.
    if (R(pixel) + G(pixel) + B(pixel) <= 2) {
      pixel = 0;
    }

    SEGMENT.setPixelColor(i, pixel);
  }
}

export const FX1D_A: EffectDef[] = [
  wledEffect({
    meta: 'Breathe@!;!,!;!;01',
    mode: mode_breath,
    category: 'Basic',
    description: 'The whole house slowly breathes in and out between the effect colour and the background.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Wipe@!,!;!,!;!',
    mode: mode_color_wipe,
    category: 'Basic',
    description: 'The effect colour fills the lights one after another, then the background wipes over it the same way.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Wipe Random@!;;!',
    mode: mode_color_wipe_random,
    category: 'Basic',
    description: 'Each pass wipes a new random colour across the lights from start to end.',
  }),
  wledEffect({
    meta: 'Random Colors@!,Fade time;;!;01',
    mode: mode_random_color,
    category: 'Basic',
    description: 'All lights change together to a new random colour, fading from one to the next.',
  }),
  wledEffect({
    meta: 'Sweep@!,!;!,!;!',
    mode: mode_color_sweep,
    category: 'Basic',
    description: 'The effect colour wipes in from the start, then the background wipes back from the end.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Dynamic@!,!,,,,Smooth;;!',
    mode: mode_dynamic,
    category: 'Basic',
    description: 'Every light shows its own random colour, and they keep jumping to new ones.',
  }),
  wledEffect({
    meta: 'Colorloop@!,Saturation;;!;01',
    mode: mode_rainbow,
    category: 'Basic',
    description: 'All lights cycle together through the colours of the rainbow.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Rainbow@!,Size;;!',
    mode: mode_rainbow_cycle,
    category: 'Basic',
    description: 'A rainbow stretched along the lights slowly rolls past.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Scan@!,# of dots,,,,,Overlay;!,!,!;!',
    mode: mode_scan,
    category: 'Chase & Running',
    description: 'A block of light bounces back and forth along the lights.',
  }),
  wledEffect({
    meta: 'Scan Dual@!,# of dots,,,,,Overlay;!,!,!;!',
    mode: mode_dual_scan,
    category: 'Chase & Running',
    description: 'Two blocks of light bounce back and forth, crossing each other in the middle.',
  }),
  wledEffect({
    meta: 'Fade@!;!,!;!;01',
    mode: mode_fade,
    category: 'Basic',
    description: 'All lights fade smoothly back and forth between the effect colour and the background.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Theater@!,Gap size;!,!;!',
    mode: mode_theater_chase,
    category: 'Chase & Running',
    description: 'Classic theatre marquee: every few lights glow and the pattern crawls along.',
  }),
  wledEffect({
    meta: 'Theater Rainbow@!,Gap size;,!;!',
    mode: mode_theater_chase_rainbow,
    category: 'Chase & Running',
    description: 'Theatre marquee lights crawl along while their colour shifts through the rainbow.',
  }),
  wledEffect({
    meta: 'Running@!,Wave width;!,!;!',
    mode: mode_running_lights,
    category: 'Chase & Running',
    description: 'Smooth waves of light run along the lights over the background.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Saw@!,Width;!,!;!',
    mode: mode_saw,
    category: 'Chase & Running',
    description: 'Sharp-edged waves of light run along the lights, brightening and fading like saw teeth.',
    stateful: false,
    history: 0,
  }),
  wledEffect({
    meta: 'Twinkle@!,!;!,!;!;;m12=0',
    mode: mode_twinkle,
    category: 'Twinkle & Sparkle',
    description: 'More and more random lights blink on, then they all reset and it starts again.',
  }),
  wledEffect({
    meta: 'Dissolve@Repeat speed,Dissolve speed,,,,Random,Complete;!,!;!',
    mode: mode_dissolve,
    category: 'Twinkle & Sparkle',
    description: 'Lights switch on one by one at random until all are lit, then dissolve away the same way.',
  }),
  wledEffect({
    meta: 'Dissolve Rnd@Repeat speed,Dissolve speed;,!;!',
    mode: mode_dissolve_random,
    category: 'Twinkle & Sparkle',
    description: 'Lights switch on one by one in random colours, then dissolve back to the background.',
  }),
  wledEffect({
    meta: 'Sparkle Dark@!,!,,,,,Overlay;Bg,Fx;!;;m12=0',
    mode: mode_flash_sparkle,
    category: 'Twinkle & Sparkle',
    description: 'Lights glow steadily while single lights flash briefly in the second colour.',
  }),
  wledEffect({
    meta: 'Sparkle+@!,!,,,,,Overlay;Bg,Fx;!;;m12=0',
    mode: mode_hyper_sparkle,
    category: 'Twinkle & Sparkle',
    description: 'Lights glow steadily while bursts of many flashes pop up all over.',
  }),
  wledEffect({
    meta: 'Strobe@!;!,!;!;01',
    mode: mode_strobe,
    category: 'Basic',
    description: 'All lights flash briefly in the effect colour, like a strobe.',
    stateful: false,
    history: 1,
  }),
  wledEffect({
    meta: 'Strobe Rainbow@!;,!;!;01',
    mode: mode_strobe_rainbow,
    category: 'Basic',
    description: 'A strobe flash that changes colour through the rainbow.',
  }),
  wledEffect({
    meta: 'Strobe Mega@!,!;!,!;!;01',
    mode: mode_multi_strobe,
    category: 'Basic',
    description: 'Quick bursts of several strobe flashes, then a pause.',
  }),
  wledEffect({
    meta: 'Blink Rainbow@Frequency,Blink duration;!,!;!;01',
    mode: mode_blink_rainbow,
    category: 'Basic',
    description: 'All lights blink on and off, changing colour through the rainbow.',
  }),
  wledEffect({
    meta: 'Android@!,Width;!,!;!;;m12=1',
    mode: mode_android,
    category: 'Chase & Running',
    description: 'A band of light runs around, growing and shrinking like a phone loading spinner.',
  }),
  wledEffect({
    meta: 'Chase@!,Width;!,!,!;!',
    mode: mode_chase_color,
    category: 'Chase & Running',
    description: 'A short two-colour band chases along the lights over the background.',
  }),
  wledEffect({
    meta: 'Chase Random@!,Width;!,,!;!',
    mode: mode_chase_random,
    category: 'Chase & Running',
    description: 'A short band chases along, painting the lights behind it a new random colour each lap.',
  }),
  wledEffect({
    meta: 'Chase Rainbow@!,Width;!,!;!',
    mode: mode_chase_rainbow,
    category: 'Chase & Running',
    description: 'A two-colour band chases along over a background that cycles through the rainbow.',
  }),
  wledEffect({
    meta: 'Chase Flash@!;Bg,Fx;!',
    mode: mode_chase_flash,
    category: 'Chase & Running',
    description: 'A pair of flashing lights steps along the lights over the background.',
  }),
  wledEffect({
    meta: 'Chase Flash Rnd@!;!,!;!',
    mode: mode_chase_flash_random,
    category: 'Chase & Running',
    description: 'A flashing pair steps along, leaving a random colour behind it that changes each lap.',
  }),
  wledEffect({
    meta: 'Rainbow Runner@!,Size;Bg;!',
    mode: mode_chase_rainbow_white,
    category: 'Chase & Running',
    description: 'A short rainbow-coloured band runs along over the background colour.',
  }),
  wledEffect({
    meta: 'Colorful@!,Saturation;1,2,3;!',
    mode: mode_colorful,
    category: 'Chase & Running',
    description: 'Repeating red, amber, green and blue lights step along the string.',
  }),
  wledEffect({
    meta: 'Traffic Light@!,US style;,!;!',
    mode: mode_traffic_light,
    category: 'Basic',
    description: 'Groups of three lights cycle red, amber and green like traffic lights.',
  }),
  wledEffect({
    meta: 'Sweep Random@!;;!',
    mode: mode_color_sweep_random,
    category: 'Basic',
    description: 'Random colours wipe in alternately from the start and from the end of the lights.',
  }),
  wledEffect({
    meta: 'Chase 2@!,Width;!,!;!',
    mode: mode_running_color,
    category: 'Chase & Running',
    description: 'Alternating blocks of the effect colour and background march along the lights.',
  }),
  wledEffect({
    meta: 'Aurora@!,!;1,2,3;!;;sx=24,pal=50',
    mode: mode_aurora,
    category: 'Noise & Flow',
    description: 'Soft coloured waves drift and fade along the lights like the northern lights.',
  }),
  wledEffect({
    meta: 'Stream@!,Zone size;;!',
    mode: mode_running_random,
    category: 'Chase & Running',
    description: 'Blocks of random colours stream along the lights.',
  }),
  wledEffect({
    meta: 'Color Clouds@!,!,Clouds,Colors,Distance,,,Cozy;;!;;sx=24,ix=32,c1=48,c2=64,c3=12,pal=0',
    mode: mode_ColorClouds,
    category: 'Noise & Flow',
    description: 'Soft colourful clouds float slowly along the lights with dark gaps between them.',
  }),
];
