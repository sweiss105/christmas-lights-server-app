// Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/FX.cpp. Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.

import type { EffectDef } from '../../effects.js';
import { wledEffect } from '../define.js';
import { beatsin8_t } from '../math.js';
import { ColorFromPalette, LINEARBLEND } from '../palettes.js';
import { SEG_H, SEG_W, SEGMENT, SEGPALETTE, strip } from '../segment.js';

/////////////////////
//      2D DNA     //
/////////////////////
function mode_2Ddna(): void { // dna originally by by ldirko at https://pastebin.com/pCkkkzcs. Updated by Preyy. WLED conversion by Andrew Tuline.
  if (!strip.isMatrix || !SEGMENT.is2D()) { SEGMENT.fill(SEGMENT.colors[0]!); return; } // FX_FALLBACK_STATIC

  const cols = SEG_W;
  const rows = SEG_H;

  SEGMENT.fadeToBlackBy(64);
  const t17 = Math.trunc(strip.now / 17);
  for (let i = 0; i < cols; i++) {
    SEGMENT.setPixelColorXY(i, beatsin8_t(SEGMENT.speed >> 3, 0, rows - 1, 0, i * 4), ColorFromPalette(SEGPALETTE, i * 5 + t17, beatsin8_t(5, 55, 255, 0, i * 10), LINEARBLEND));
    SEGMENT.setPixelColorXY(i, beatsin8_t(SEGMENT.speed >> 3, 0, rows - 1, 0, i * 4 + 128), ColorFromPalette(SEGPALETTE, i * 5 + 128 + t17, beatsin8_t(5, 55, 255, 0, i * 10 + 128), LINEARBLEND));
  }
  SEGMENT.blur(Math.trunc(SEGMENT.intensity / (8 - (SEGMENT.check1 ? 1 : 0) * 2)), SEGMENT.check1);
}

export const TWO_D: EffectDef[] = [
  wledEffect({
    meta: 'DNA@Scroll speed,Blur,,,,Smear;;!;2;ix=0',
    mode: mode_2Ddna,
    category: '2D',
    description: 'Two intertwined strands of palette colour wave across the house like a DNA helix.',
  }),
];
