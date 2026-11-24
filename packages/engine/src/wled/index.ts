// Registry of effects ported from WLED. Each family file exports an array of EffectDefs; add new
// families here (one import, one spread) and they appear in EFFECTS automatically.
import type { EffectDef } from '../effects.js';
import { BASIC } from './effects/basic.js';
import { FIRE } from './effects/fire.js';
import { TWINKLE } from './effects/twinkle.js';
import { TWO_D } from './effects/twod.js';
import { WAVES } from './effects/waves.js';
import { FX1D_A } from './effects/fx1d-a.js';
import { FX1D_B } from './effects/fx1d-b.js';
import { FX1D_C } from './effects/fx1d-c.js';
import { FX2D } from './effects/fx2d.js';
import { PARTICLES } from './effects/particles.js';

export const WLED_EFFECTS: EffectDef[] = [
  ...BASIC,
  ...TWINKLE,
  ...FIRE,
  ...WAVES,
  ...TWO_D,
  ...FX1D_A,
  ...FX1D_B,
  ...FX1D_C,
  ...FX2D,
  ...PARTICLES,
];

export { PALETTE_NAMES, WLED_PALETTE_NAMES } from './palettes.js';
