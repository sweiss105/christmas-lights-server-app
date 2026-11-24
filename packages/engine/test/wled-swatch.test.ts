import { describe, expect, it } from 'vitest';
import { PALETTE_NAMES, paletteColors } from '../src/index.js';

describe('palette swatches for the editor', () => {
  it('returns hex colours for every listed palette', () => {
    for (const name of PALETTE_NAMES) {
      const c = paletteColors(name, {}, 8);
      expect(c, name).toHaveLength(8);
      for (const h of c) expect(h).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('colour palettes follow the layer colours', () => {
    expect(paletteColors('* Color 1', { color1: '#00ff00' }, 4)).toEqual(['#00ff00', '#00ff00', '#00ff00', '#00ff00']);
  });
});
