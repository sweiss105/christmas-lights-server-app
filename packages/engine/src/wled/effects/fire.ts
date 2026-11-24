// Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/FX.cpp. Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.

import type { EffectDef } from '../../effects.js';
import { wledEffect } from '../define.js';
import { hw_random8, qadd8, qsub8 } from '../math.js';
import { ColorFromPalette, NOBLEND } from '../palettes.js';
import { indexToVStrip, SEGENV, SEGLEN, SEGMENT, SEGPALETTE, strip } from '../segment.js';

// Fire2012 by Mark Kriegsman, July 2012, as part of "Five Elements" shown here: http://youtu.be/knWiGsmgycY
// There are two main parameters you can play with to control the look and
// feel of your fire: COOLING (used in step 1 above) (Speed = COOLING), and SPARKING (used
// in step 3 above) (Effect Intensity = Sparking).
function runStrip(stripNr: number, heat: Uint8Array, it: number): void {
  const ignition = Math.max(3, Math.trunc(SEGLEN / 10)) & 0xff; // ignition area: 10% of segment length or minimum 3 pixels

  // Step 1.  Cool down every cell a little
  for (let i = 0; i < SEGLEN; i++) {
    const cool = it !== SEGENV.step ? hw_random8(Math.trunc(((20 + Math.trunc(SEGMENT.speed / 3)) * 16) / SEGLEN) + 2) : hw_random8(4);
    const minTemp = (i < ignition ? ((ignition - i) >> 2) + 16 : 0) & 0xff; // should not become black in ignition area
    const temp = qsub8(heat[i]!, cool);
    heat[i] = temp < minTemp ? minTemp : temp;
  }

  if (it !== SEGENV.step) {
    // Step 2.  Heat from each cell drifts 'up' and diffuses a little
    for (let k = SEGLEN - 1; k > 1; k--) {
      heat[k] = Math.trunc((heat[k - 1]! + (heat[k - 2]! << 1)) / 3); // heat[k-2] multiplied by 2
    }

    // Step 3.  Randomly ignite new 'sparks' of heat near the bottom
    if (hw_random8() <= SEGMENT.intensity) {
      const y = hw_random8(ignition);
      const boost = Math.trunc(((17 + SEGMENT.custom3) * (ignition - (y >> 1))) / ignition) & 0xff; // integer math!
      heat[y] = qadd8(heat[y]!, hw_random8(96 + 2 * boost, 207 + boost));
    }
  }

  // Step 4.  Map from heat cells to LED colors
  for (let j = 0; j < SEGLEN; j++) {
    SEGMENT.setPixelColor(indexToVStrip(j, stripNr), ColorFromPalette(SEGPALETTE, Math.min(heat[j]!, 240), 255, NOBLEND));
  }
}

function mode_fire_2012(): void {
  if (SEGLEN <= 1) { SEGMENT.fill(SEGMENT.colors[0]!); return; } // FX_FALLBACK_STATIC
  const strips = SEGMENT.nrOfVStrips();
  if (!SEGENV.allocateData(strips * SEGLEN)) return;
  const heat = SEGENV.data;

  const it = strip.now >>> 5; // div 32

  for (let stripNr = 0; stripNr < strips; stripNr++) runStrip(stripNr, heat.subarray(stripNr * SEGLEN), it);

  if (SEGMENT.is2D()) {
    let blurAmount = SEGMENT.custom2 >> 2;
    if (blurAmount > 48) blurAmount += blurAmount - 48; // extra blur when slider > 192  (bush burn)
    if (blurAmount < 16) SEGMENT.blurCols(SEGMENT.custom2 >> 1); // no side-burn when slider < 64 (faster)
    else SEGMENT.blur(blurAmount);
  }

  if (it !== SEGENV.step) SEGENV.step = it;
}

export const FIRE: EffectDef[] = [
  wledEffect({
    meta: 'Fire 2012@Cooling,Spark rate,,2D Blur,Boost;;!;1;pal=35,sx=64,ix=160,m12=1,c2=128',
    mode: mode_fire_2012,
    category: 'Fire & Fireworks',
    description: 'Classic flickering fire: heat rises from the start of each string and cools as it climbs.',
  }),
];
