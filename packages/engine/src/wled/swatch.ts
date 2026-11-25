// Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/FX_fcn.cpp (palette loading for previews). Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.

import { ColorFromPalette, layerPaletteId, loadPalette, type Palette16 } from './palettes.js';

const toU32 = (hex: unknown, fallback: number): number => {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return fallback;
  return parseInt(hex.slice(1), 16);
};
const toHex = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;

/**
 * Colours of a palette as hex strings, for previews in the editor (gradient swatches). Colour-based
 * palettes ("* Color 1" etc.) use the layer's color1..3 params; "Default" shows WLED's Party palette;
 * an edited or saved palette uses the layer's paletteStops.
 */
export function paletteColors(name: string, params: Record<string, unknown> = {}, samples = 16): string[] {
  const pal: Palette16 = new Uint32Array(16);
  const id = layerPaletteId(name, params);
  const colors = [toU32(params.color1, 0xffa000), toU32(params.color2, 0), toU32(params.color3, 0)];
  loadPalette(pal, id, 0, colors, 0, params);
  return Array.from({ length: samples }, (_, i) => toHex(ColorFromPalette(pal, Math.round((i * 255) / Math.max(1, samples - 1)), 255)));
}
