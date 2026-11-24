// Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/FX.cpp. Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.

import type { EffectDef } from '../../effects.js';
import { wledEffect } from '../define.js';
import { FRAMETIME, PALETTE_SOLID_WRAP, SEGCOLOR, SEGENV, SEGLEN, SEGMENT, strip } from '../segment.js';

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
 * Normal blinking. Intensity sets duty cycle.
 */
function mode_blink(): void {
  blink(SEGCOLOR(0), SEGCOLOR(1), false, true);
}

export const BASIC: EffectDef[] = [
  wledEffect({
    meta: 'Blink@!,Duty cycle;!,!;!;01',
    mode: mode_blink,
    category: 'Basic',
    description: 'Flashes between the effect colour (or palette) and the background; intensity sets how long it stays on.',
    // Depends only on strip.now, apart from SEGENV.step remembering the previous cycle.
    stateful: false,
    history: 1,
  }),
];
