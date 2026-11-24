import { parseColor, type RGB } from '../color.js';

/** A gradient: colour stops at positions 0..1, sorted. */
export interface Stop { at: number; rgb: RGB }
export type Palette = Stop[];

const hex = (h: string): RGB => parseColor(h);
/** Evenly spaced stops from a list of hex colours. */
const even = (...colors: string[]): Palette => colors.map((c, i) => ({ at: colors.length === 1 ? 0 : i / (colors.length - 1), rgb: hex(c) }));
/** Hard-edged bands (each colour holds, then switches), for stripes such as candy cane. */
const bands = (...colors: string[]): Palette => colors.flatMap((c, i) => {
  const a = i / colors.length, b = (i + 1) / colors.length - 1e-4;
  return [{ at: a, rgb: hex(c) }, { at: b, rgb: hex(c) }];
});

/**
 * Built-in palettes. Our own colour choices, named for what they look like. Gradients that start and
 * end on the same colour loop seamlessly when an effect scrolls through them.
 */
export const PALETTES: Record<string, Palette> = {
  Rainbow: even('#ff0000', '#ff8000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#8000ff', '#ff0000'),
  'Rainbow Bands': bands('#ff0000', '#ff8000', '#ffff00', '#00ff00', '#0080ff', '#8000ff'),
  Party: even('#5500ab', '#84007c', '#b5004b', '#e5001b', '#e81700', '#b84700', '#ab7700', '#abab00', '#ab5500', '#dd2200', '#f2000e', '#c2003e', '#8f0071', '#5f00a1', '#2f00d0', '#5500ab'),
  Ocean: even('#000040', '#003070', '#0070a0', '#00a0c0', '#40e0e0', '#0070a0', '#000040'),
  Forest: even('#003000', '#006000', '#2a8000', '#70b020', '#2a8000', '#004010', '#003000'),
  Lava: even('#000000', '#400000', '#900000', '#ff2000', '#ff8000', '#ffd060', '#ff8000', '#900000', '#000000'),
  Heat: even('#000000', '#600000', '#d01000', '#ff6000', '#ffc000', '#ffffa0'),
  Fire: even('#000000', '#800000', '#ff2000', '#ff8000', '#ffd000', '#ff8000', '#800000', '#000000'),
  Cloud: even('#0000ff', '#4080ff', '#ffffff', '#87ceeb', '#0000ff'),
  Ice: even('#000020', '#002060', '#4080ff', '#a0e0ff', '#ffffff', '#4080ff', '#000020'),
  Sunset: even('#200040', '#800060', '#ff2040', '#ff8020', '#ffd040', '#ff2040', '#200040'),
  Aurora: even('#001030', '#00ff60', '#00c0a0', '#4000ff', '#a000ff', '#00ff60', '#001030'),
  Pastel: even('#ffb3ba', '#ffdfba', '#ffffba', '#baffc9', '#bae1ff', '#e0bbff', '#ffb3ba'),
  Autumn: even('#401000', '#a03000', '#e06000', '#f0a020', '#a03000', '#401000'),
  Sakura: even('#ff2060', '#ff80a0', '#ffd0e0', '#ff80a0', '#ff2060'),
  Toxic: even('#00ff00', '#80ff00', '#004000', '#00ff40', '#00ff00'),
  Icefire: even('#000000', '#0040ff', '#00ffff', '#ffffff', '#ffff00', '#ff4000', '#000000'),
  Magenta: even('#000000', '#4000ff', '#ff00ff', '#ffffff', '#ff00ff', '#4000ff', '#000000'),
  Christmas: even('#ff0000', '#008000', '#ff0000', '#008000'),
  'Christmas Bands': bands('#ff0000', '#00a000'),
  'Candy Cane': bands('#ff0000', '#ffffff'),
  Holly: even('#004000', '#00a020', '#004000', '#c00000', '#004000'),
  'Warm White': even('#ff9020', '#ffb46b', '#ffd2a0', '#ffb46b', '#ff9020'),
  'Cool White': even('#a0c0ff', '#e0eaff', '#ffffff', '#e0eaff', '#a0c0ff'),
  'Warm & Cool': even('#ffb46b', '#ffe0c0', '#e0eaff', '#a0c0ff', '#e0eaff', '#ffe0c0', '#ffb46b'),
  'Gold & Silver': even('#ffb000', '#fff0c0', '#c0c0c8', '#ffffff', '#ffb000'),
  Americana: bands('#ff0000', '#ffffff', '#0030ff'),
  Halloween: even('#ff4000', '#800080', '#000000', '#ff4000'),
};

/** Palettes made from the layer's own colours (params `color1`..`color3`), as in WLED. */
export const COLOR_PALETTES = ['Colors 1&2', 'Colors 1-3', 'Color Gradient', 'Color 1'] as const;
export const PALETTE_NAMES = [...COLOR_PALETTES, ...Object.keys(PALETTES)];

/** Resolve a palette name against the layer's params. Unknown names fall back to Rainbow. */
export function paletteFor(name: string, p: Record<string, unknown>): Palette {
  const c = (k: string, d: string) => (typeof p[k] === 'string' ? (p[k] as string) : d);
  const c1 = c('color1', '#ff0000'), c2 = c('color2', '#0000ff'), c3 = c('color3', '#00ff00');
  switch (name) {
    case 'Colors 1&2': return even(c1, c2);
    case 'Colors 1-3': return bands(c1, c2, c3);
    case 'Color Gradient': return even(c1, c2, c3, c1);
    case 'Color 1': return even(c1, c1);
    default: return PALETTES[name] ?? PALETTES.Rainbow!;
  }
}

/** Colour at position x of a palette, written into `out`. Wraps around by default. */
export function samplePalette(pal: Palette, x: number, out: RGB | Float32Array, wrap = true, offset = 0): void {
  let u = wrap ? x - Math.floor(x) : x < 0 ? 0 : x > 1 ? 1 : x;
  const n = pal.length;
  if (u <= pal[0]!.at) { const c = pal[0]!.rgb; out[offset] = c[0]; out[offset + 1] = c[1]; out[offset + 2] = c[2]; return; }
  if (u >= pal[n - 1]!.at) { const c = pal[n - 1]!.rgb; out[offset] = c[0]; out[offset + 1] = c[1]; out[offset + 2] = c[2]; return; }
  let i = 1;
  while (pal[i]!.at < u) i++;
  const a = pal[i - 1]!, b = pal[i]!;
  const f = b.at === a.at ? 0 : (u - a.at) / (b.at - a.at);
  out[offset] = a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f;
  out[offset + 1] = a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f;
  out[offset + 2] = a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f;
}
