// Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/FX.cpp. Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.

import type { EffectDef } from '../../effects.js';
import { color_blend } from '../color.js';
import { wledEffect } from '../define.js';
import { cubicwave8, hw_random16, hw_random8, map, scale8, sin8_t, triwave8 } from '../math.js';
import { SEG_H, SEG_W, SEGCOLOR, SEGENV, SEGLEN, SEGMENT } from '../segment.js';

const IBN = 5100;

// Water ripple
// propagation velocity from speed
// drop rate from intensity

// struct Ripple { uint8_t state; uint8_t color; uint16_t pos; } -> 4 bytes:
// byte 4i = state, byte 4i+1 = color, uint16 at index 2i+1 = pos
const MAX_RIPPLES = 100;

function ripple_base(blurAmount = 0): void {
  const maxRipples = Math.min(1 + (SEGLEN >> 2), MAX_RIPPLES);
  const dataSize = 4 * maxRipples;

  if (!SEGENV.allocateData(dataSize)) { SEGMENT.fill(SEGCOLOR(0)); return; } // FX_FALLBACK_STATIC
  const u8 = SEGENV.data;
  const u16 = SEGENV.view(Uint16Array);
  const is2D = SEGMENT.is2D() ? 1 : 0;

  // draw wave
  for (let i = 0; i < maxRipples; i++) {
    let ripplestate = u8[i * 4]!;
    if (ripplestate) {
      const rippledecay = (SEGMENT.speed >> 4) + 1; // faster decay if faster propagation
      const rippleorigin = u16[i * 2 + 1]!;
      const col = SEGMENT.color_from_palette(u8[i * 4 + 1]!, false, false, 255);
      const propagation = (((Math.trunc(ripplestate / rippledecay) - 1) * (SEGMENT.speed + 1)) >>> 0); // unsigned in C
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

function mode_ripple(): void {
  if (SEGLEN <= 1) { SEGMENT.fill(SEGCOLOR(0)); return; } // FX_FALLBACK_STATIC
  if (SEGMENT.custom1 || SEGMENT.check2) // blur or overlay
    SEGMENT.fade_out(250);
  else
    SEGMENT.fill(SEGCOLOR(1));

  ripple_base(SEGMENT.custom1 >> 1);
}

export const WAVES: EffectDef[] = [
  wledEffect({
    meta: 'Ripple@!,Wave #,Blur,,,,Overlay;,!;!;12;c1=0',
    mode: mode_ripple,
    category: 'Waves & Patterns',
    description: 'Raindrops land at random and send coloured ripples spreading outwards.',
  }),
];
