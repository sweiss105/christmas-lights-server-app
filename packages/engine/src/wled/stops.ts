// Edited and saved palettes, stored as WLED stores custom palettes (wled00/colors.cpp, loadCustomPalettes:
// `{"palette":[0,"ff0000",128,"00ff00",255,"0000ff"]}`, at most 18 stops) and built into a CRGBPalette16
// with loadDynamicGradientPalette like WLED's own gradient palettes.

/** One stop of a gradient palette: position 0..255 and colour "#rrggbb". */
export type PaletteStop = [number, string];

/** A palette saved in the show state, for any layer to pick. */
export interface SavedPalette { name: string; stops: PaletteStop[] }

/** WLED reads at most 18 stops of a custom palette (tcp[72]); its own gradient palettes have up to 18 too. */
export const MAX_PALETTE_STOPS = 18;

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Check a stop list and return it normalised (lowercase hex). Positions are whole numbers 0..255 in
 * order, the first at 0 and the last at 255 (as WLED's palette editor writes them). Throws on anything else.
 */
export function checkPaletteStops(v: unknown): PaletteStop[] {
  if (!Array.isArray(v) || v.length < 2 || v.length > MAX_PALETTE_STOPS) throw new Error(`palette needs 2..${MAX_PALETTE_STOPS} stops`);
  let last = -1;
  const out = v.map((s, i): PaletteStop => {
    if (!Array.isArray(s) || s.length !== 2) throw new Error('each palette stop is [position, "#rrggbb"]');
    const [at, color] = s as unknown[];
    if (typeof at !== 'number' || !Number.isInteger(at) || at < 0 || at > 255) throw new Error('palette stop positions are whole numbers 0..255');
    if (at < last) throw new Error('palette stops must be in order');
    if (typeof color !== 'string' || !HEX.test(color)) throw new Error(`palette stop ${i + 1} needs a colour like "#ff0000"`);
    last = at;
    return [at, color.toLowerCase()];
  });
  if (out[0]![0] !== 0 || out.at(-1)![0] !== 255) throw new Error('palette stops must start at 0 and end at 255');
  return out;
}

export function isPaletteStops(v: unknown): v is PaletteStop[] {
  try { checkPaletteStops(v); return true; } catch { return false; }
}

/** Stops as the byte list loadDynamicGradientPalette takes: [index, r, g, b, ...]. */
export function stopsToGradient(stops: readonly PaletteStop[]): number[] {
  return stops.flatMap(([at, c]) => { const n = parseInt(c.slice(1), 16); return [at, (n >> 16) & 255, (n >> 8) & 255, n & 255]; });
}
