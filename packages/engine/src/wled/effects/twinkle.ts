// Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/FX.cpp. Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.

import type { EffectDef } from '../../effects.js';
import { B, color_add, color_fade, G, gamma8inv, R } from '../color.js';
import { wledEffect } from '../define.js';
import { hw_random16, hw_random8 } from '../math.js';
import { ColorFromPalette, NOBLEND } from '../palettes.js';
import { FRAMETIME_FIXED, SEGENV, SEGLEN, SEGMENT, SEGPALETTE, strip } from '../segment.js';

// based on https://gist.github.com/kriegsman/5408ecd397744ba0393e
function mode_colortwinkle(): void {
  const dataSize = (SEGLEN + 7) >> 3; // 1 bit per LED
  if (!SEGENV.allocateData(dataSize)) return; // FX_FALLBACK_STATIC (allocation never fails here)
  const data = SEGENV.data;

  // limit update rate
  if (((strip.now - SEGENV.step) >>> 0) < FRAMETIME_FIXED) return;
  SEGENV.step = strip.now;

  const bri = strip.getBrightness();
  const fadeUpAmount = (bri > 28 ? 8 + (SEGMENT.speed >> 2) : 68 - bri) & 0xff;
  const fadeDownAmount = (bri > 28 ? 8 + (SEGMENT.speed >> 3) : 68 - bri) & 0xff;
  for (let i = 0; i < SEGLEN; i++) {
    const cur = SEGMENT.getPixelColor(i);
    const index = i >> 3;
    const bitNum = i & 0x07;
    const fadeUp = (data[index]! >> bitNum) & 1;

    if (fadeUp) {
      const incrementalColor = color_fade(cur, fadeUpAmount, true);
      let col = color_add(cur, incrementalColor);

      if (R(col) === 255 || G(col) === 255 || B(col) === 255) {
        data[index] = data[index]! & ~(1 << bitNum); // bitWrite(.., false)
      }

      if (col === cur) { // color_add did nothing, fix "stuck" pixels by adding the color to itself
        col = color_add(col, col);
      }
      SEGMENT.setPixelColor(i, col);
    } else {
      const col = color_fade(cur, 255 - fadeDownAmount, false);
      SEGMENT.setPixelColor(i, col);
    }
  }

  for (let j = 0; j <= Math.trunc(SEGLEN / 50); j++) {
    if (hw_random8() <= SEGMENT.intensity) {
      for (let times = 0; times < 5; times++) { // attempt to spawn a new pixel 5 times
        const i = hw_random16(SEGLEN);
        if (SEGMENT.getPixelColor(i) === 0) {
          const index = i >> 3;
          const bitNum = i & 0x07;
          data[index] = data[index]! | (1 << bitNum); // bitWrite(.., true)
          SEGMENT.setPixelColor(i, ColorFromPalette(SEGPALETTE, hw_random8(), gamma8inv(64), NOBLEND)); // note on gamma8inv: inverting results in non-linear brightness fade as originally designed
          break; // only spawn 1 new pixel per frame per 50 LEDs
        }
      }
    }
  }
}

export const TWINKLE: EffectDef[] = [
  wledEffect({
    meta: 'Colortwinkles@Fade speed,Spawn speed;;!;;m12=0',
    mode: mode_colortwinkle,
    category: 'Twinkle & Sparkle',
    description: 'Random lights glow up in palette colours and slowly fade away.',
  }),
];
