// Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/palettes.cpp, wled00/colors.cpp, wled00/FX_fcn.cpp (Segment::loadPalette, JSON_palette_names, handleRandomPalette) and wled00/src/dependencies/fastled_slim (CRGBPalette16, fill_gradient_RGB; FastLED-derived, MIT licensed, see that LICENSE.txt). Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.
//
// A palette is a Uint32Array(16) of 0x00RRGGBB entries (CRGBPalette16). Palette parameters store
// WLED's palette NAME; names that are not WLED palettes resolve through our own fx/palettes.ts.

import { createRandom, type Random } from '../fx/random.js';
import { PALETTES as OWN_PALETTES, paletteFor, samplePalette } from '../fx/palettes.js';
import { CHSV, color_blend, CRGB, B, G, R, RGBW32, rgb2hsv } from './color.js';
import { FASTLED_PALETTES, GRADIENT_PALETTES } from './palette-data.js';
import { isPaletteStops, stopsToGradient, type PaletteStop, type SavedPalette } from './stops.js';

export type Palette16 = Uint32Array;

/** The palette list exactly as the controller reports it (palette id = index). */
export const WLED_PALETTE_NAMES: readonly string[] = [
  'Default', '* Random Cycle', '* Color 1', '* Colors 1&2', '* Color Gradient', '* Colors Only', 'Party', 'Cloud', 'Lava', 'Ocean',
  'Forest', 'Rainbow', 'Rainbow Bands', 'Sunset', 'Rivendell', 'Breeze', 'Red & Blue', 'Yellowout', 'Analogous', 'Splash',
  'Pastel', 'Sunset 2', 'Beach', 'Vintage', 'Departure', 'Landscape', 'Beech', 'Sherbet', 'Hult', 'Hult 64',
  'Drywet', 'Jul', 'Grintage', 'Rewhi', 'Tertiary', 'Fire', 'Icefire', 'Cyane', 'Light Pink', 'Autumn',
  'Magenta', 'Magred', 'Yelmag', 'Yelblu', 'Orange & Teal', 'Tiamat', 'April Night', 'Orangery', 'C9', 'Sakura',
  'Aurora', 'Atlantica', 'C9 2', 'C9 New', 'Temperature', 'Aurora 2', 'Retro Clown', 'Candy', 'Toxy Reaf', 'Fairy Reaf',
  'Semi Blue', 'Pink Candy', 'Red Reaf', 'Aqua Flash', 'Yelblu Hot', 'Lite Light', 'Red Flash', 'Blink Red', 'Red Shift', 'Red Tide',
  'Candy2', 'Traffic Light',
];
export const FIXED_PALETTE_COUNT = 72;
const DYNAMIC_PALETTE_COUNT = 6, FASTLED_PALETTE_COUNT = 7;

/** Our own palettes (fx/palettes.ts) whose names WLED doesn't use; they get ids from CUSTOM_PALETTE_BASE up. */
const OWN_EXTRA = Object.keys(OWN_PALETTES).filter((n) => !WLED_PALETTE_NAMES.includes(n));
export const CUSTOM_PALETTE_BASE = 100;

/**
 * Every palette name the editor offers: WLED's 72 in the controller's order, then our own palettes whose
 * names don't clash. Every name resolves (see resolvePaletteId / loadPaletteByName).
 */
export const PALETTE_NAMES: string[] = [...WLED_PALETTE_NAMES, ...OWN_EXTRA];

const ID_BY_NAME = new Map<string, number>([
  ...WLED_PALETTE_NAMES.map((n, i) => [n, i] as [string, number]),
  ...OWN_EXTRA.map((n, i) => [n, CUSTOM_PALETTE_BASE + i] as [string, number]),
]);

/**
 * Palette id for a name, as the effect sees it in SEGMENT.palette: 0..71 for WLED palettes,
 * CUSTOM_PALETTE_BASE+ for our own (like WLED's custom palettes, ids >= 72). Unknown names → -1.
 */
export function resolvePaletteId(name: string): number {
  return ID_BY_NAME.get(name) ?? -1;
}

/**
 * Id of a layer's own palette (params.paletteStops: an edited or saved palette), as WLED numbers custom
 * palettes from WLED_CUSTOM_PALETTE_ID_BASE (200) down. Built-in names always mean the built-in palette.
 */
export const CUSTOM_STOPS_ID = 200;

/** Palette id for a layer: its palette name, or its own stops when the name isn't a built-in palette. */
export function layerPaletteId(name: string, params: Record<string, unknown>): number {
  const id = resolvePaletteId(name);
  if (id >= 0) return id;
  return isPaletteStops(params.paletteStops) ? CUSTOM_STOPS_ID : 0;
}

/**
 * The colours that define a built-in palette, as gradient stops, for editing a copy of it: a gradient
 * palette's own stops, a 16-entry palette's entries (stop k at 17k, which loadDynamicGradientPalette
 * builds back into exactly the same 16 entries), or our own palette's stops at 0..255. Null for
 * palettes that aren't fixed colours: Default, "* Random Cycle" and the "* Color…" ones.
 */
export function builtinPaletteStops(name: string): PaletteStop[] | null {
  const id = resolvePaletteId(name);
  const hex = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
  if (id >= CUSTOM_PALETTE_BASE) {
    const own = OWN_PALETTES[OWN_EXTRA[id - CUSTOM_PALETTE_BASE]!];
    if (!own) return null;
    const stops = own.map((s): PaletteStop => [Math.min(255, Math.max(0, Math.round(s.at * 255))), hex(RGBW32(Math.round(s.rgb[0] * 255), Math.round(s.rgb[1] * 255), Math.round(s.rgb[2] * 255)))]);
    stops[0]![0] = 0;
    stops.at(-1)![0] = 255;
    for (let i = 1; i < stops.length; i++) stops[i]![0] = Math.max(stops[i]![0], stops[i - 1]![0]);
    return stops;
  }
  if (id < DYNAMIC_PALETTE_COUNT) return null;
  if (id < DYNAMIC_PALETTE_COUNT + FASTLED_PALETTE_COUNT) return FASTLED_PALETTES[id - DYNAMIC_PALETTE_COUNT]!.map((c, k): PaletteStop => [k * 17, hex(c)]);
  const g = GRADIENT_PALETTES[id - DYNAMIC_PALETTE_COUNT - FASTLED_PALETTE_COUNT]!;
  const stops: PaletteStop[] = [];
  for (let i = 0; i < g.length; i += 4) stops.push([g[i]!, hex(RGBW32(g[i + 1]!, g[i + 2]!, g[i + 3]!))]);
  return stops;
}

/**
 * The stops a layer's palette is drawn from: a built-in palette's own (see builtinPaletteStops), else
 * the layer's own copy (params.paletteStops), else a saved palette of that name. Null when the palette
 * has no fixed colours or the name is unknown.
 */
export function paletteStopsFor(name: string, params: Record<string, unknown> = {}, saved: Record<string, SavedPalette> = {}): PaletteStop[] | null {
  if (resolvePaletteId(name) >= 0) return builtinPaletteStops(name);
  if (isPaletteStops(params.paletteStops)) return params.paletteStops;
  const s = Object.hasOwn(saved, name) ? saved[name] : undefined;
  return s && isPaletteStops(s.stops) ? s.stops : null;
}

// ---- CRGBPalette16 construction (fastled_slim) ---------------------------------------------------

/** fill_gradient_RGB(colors, startpos, startcolor, endpos, endcolor). */
export function fill_gradient_RGB(colors: Palette16, startpos: number, startcolor: number, endpos: number, endcolor: number): void {
  if (endpos < startpos) { const t = endpos, tc = endcolor; endcolor = startcolor; endpos = startpos; startpos = t; startcolor = tc; }
  const rdist = R(endcolor) - R(startcolor), gdist = G(endcolor) - G(startcolor), bdist = B(endcolor) - B(startcolor);
  let divisor = endpos - startpos;
  if (divisor === 0) divisor = 1;
  const rdelta = Math.trunc((rdist << 16) / divisor), gdelta = Math.trunc((gdist << 16) / divisor), bdelta = Math.trunc((bdist << 16) / divisor);
  let rs = R(startcolor) << 16, gs = G(startcolor) << 16, bs = B(startcolor) << 16;
  for (let i = startpos; i <= endpos; i++) {
    colors[i] = CRGB(rs >> 16, gs >> 16, bs >> 16);
    rs = (rs + rdelta) | 0; gs = (gs + gdelta) | 0; bs = (bs + bdelta) | 0;
  }
}

/** CRGBPalette16(c1[, c2[, c3[, c4]]]) or CRGBPalette16(16 colours). */
export function CRGBPalette16(...c: number[]): Palette16 {
  const p = new Uint32Array(16);
  setPalette16(p, c);
  return p;
}
function setPalette16(p: Palette16, c: number[]): void {
  const n = 16;
  switch (c.length) {
    case 1: p.fill(c[0]! & 0xffffff); break;
    case 2: fill_gradient_RGB(p, 0, c[0]!, n - 1, c[1]!); break;
    case 3: { const half = n >> 1; fill_gradient_RGB(p, 0, c[0]!, half, c[1]!); fill_gradient_RGB(p, half, c[1]!, n - 1, c[2]!); break; }
    case 4: {
      const third = Math.trunc(n / 3), twothirds = Math.trunc((n * 2) / 3);
      fill_gradient_RGB(p, 0, c[0]!, third, c[1]!); fill_gradient_RGB(p, third, c[1]!, twothirds, c[2]!); fill_gradient_RGB(p, twothirds, c[2]!, n - 1, c[3]!);
      break;
    }
    case 16: for (let i = 0; i < 16; i++) p[i] = c[i]! & 0xffffff; break;
    default: throw new Error('CRGBPalette16 takes 1-4 or 16 colours');
  }
}

/** CRGBPalette16::loadDynamicGradientPalette: [index, r, g, b, ...] ending with index 255. */
export function loadGradientPalette(target: Palette16, gpal: readonly number[]): Palette16 {
  let count = 0;
  while (gpal[count * 4] !== 255) count++;
  count++;
  let lastSlotUsed = -1;
  let rgbstart = RGBW32(gpal[1]!, gpal[2]!, gpal[3]!);
  let indexstart = 0, ent = 0;
  while (indexstart < 255) {
    ent++;
    const indexend = gpal[ent * 4]!;
    const rgbend = RGBW32(gpal[ent * 4 + 1]!, gpal[ent * 4 + 2]!, gpal[ent * 4 + 3]!);
    let istart8 = indexstart >> 4, iend8 = indexend >> 4;
    if (count < 16) {
      if (istart8 <= lastSlotUsed && lastSlotUsed < 15) {
        istart8 = lastSlotUsed + 1;
        if (iend8 < istart8) iend8 = istart8;
      }
      lastSlotUsed = iend8;
    }
    fill_gradient_RGB(target, istart8, rgbstart, iend8, rgbend);
    indexstart = indexend;
    rgbstart = rgbend;
  }
  return target;
}

// ---- ColorFromPalette (colors.cpp) ---------------------------------------------------------------

export const NOBLEND = 0, LINEARBLEND = 1, LINEARBLEND_NOWRAP = 2;
export type TBlendType = typeof NOBLEND | typeof LINEARBLEND | typeof LINEARBLEND_NOWRAP;

/** Colour (W = 0) at `index` (0..255, unsigned; upper bits ignored) of a 16-entry palette. */
export function ColorFromPalette(pal: Palette16, index: number, brightness = 255, blendType: number = LINEARBLEND): number {
  index >>>= 0;
  if (blendType === LINEARBLEND_NOWRAP) index = (Math.imul(index, 0xf0) >>> 0) >>> 8;
  const hi4 = (index & 0xff) >> 4, lo4 = index & 0x0f;
  const e = pal[hi4]!;
  let r = (e >>> 16) & 0xff, g = (e >>> 8) & 0xff, b = e & 0xff;
  if (lo4 && blendType !== NOBLEND) {
    const e2 = hi4 === 15 ? pal[0]! : pal[hi4 + 1]!;
    const f2 = lo4 << 4, f1 = 256 - f2;
    r = (r * f1 + ((e2 >>> 16) & 0xff) * f2) >> 8;
    g = (g * f1 + ((e2 >>> 8) & 0xff) * f2) >> 8;
    b = (b * f1 + (e2 & 0xff) * f2) >> 8;
  }
  brightness &= 0xff;
  if (brightness < 255) {
    const scale = brightness + 1;
    r = (r * scale) >> 8; g = (g * scale) >> 8; b = (b * scale) >> 8;
  }
  return RGBW32(r, g, b, 0);
}

/** nblendPaletteTowardPalette (fastled_slim.cpp), on the byte layout r,g,b per entry. */
export function nblendPaletteTowardPalette(current: Palette16, target: Palette16, maxChanges: number): void {
  let changes = 0;
  for (let i = 0; i < 48; i++) {
    const e = (i / 3) | 0, shift = 16 - 8 * (i % 3);
    let p1 = (current[e]! >>> shift) & 0xff;
    const p2 = (target[e]! >>> shift) & 0xff;
    if (p1 === p2) continue;
    if (p1 < p2) { p1++; changes++; }
    if (p1 > p2) { p1--; changes++; if (p1 > p2) p1--; }
    current[e] = ((current[e]! & ~(0xff << shift)) | (p1 << shift)) >>> 0;
    if (changes >= (maxChanges & 0xff)) break;
  }
}

// ---- Random palettes (colors.cpp), driven by a seeded source ---------------------------------------

function rand8From(r: Random) { return (lo?: number, hi?: number): number => {
  const v = Math.floor(r() * 256) & 0xff;
  if (lo === undefined) return v;
  if (hi === undefined) return ((v * lo) >>> 8) & 0xff;
  return (lo + (((v * ((hi - lo) >>> 0)) >>> 8) & 0xff)) & 0xff;
}; }

/** generateRandomPalette(): four random CHSV colours. */
export function generateRandomPalette(r: Random): Palette16 {
  const h8 = rand8From(r);
  const c = [0, 1, 2, 3].map(() => { const h = h8(), s = h8(160, 255), v = h8(128, 255); return CHSV(h, s, v); });
  return CRGBPalette16(c[0]!, c[1]!, c[2]!, c[3]!);
}

/** generateHarmonicRandomPalette(base): keeps one colour of `base`, picks harmonic hues for the rest. */
export function generateHarmonicRandomPalette(base: Palette16, r: Random): Palette16 {
  const h8 = rand8From(r);
  const hue = [0, 0, 0, 0], sat = [0, 0, 0, 0], val = [0, 0, 0, 0];
  const keep = h8(4);
  const k = rgb2hsv(base[keep * 5]!);
  hue[keep] = ((k.h >> 8) + h8(10) - 5) & 0xff; sat[keep] = k.s; val[keep] = k.v;
  for (let i = 0; i < 3; i++) { sat[i] = h8(200, 255); val[i] = h8(220, 255); }
  sat[3] = h8(20, 255); val[3] = h8(80, 255);
  for (let i = 3; i > 0; i--) {
    let j = h8(i + 1); [sat[i], sat[j]] = [sat[j]!, sat[i]!];
    j = h8(i + 1); [val[i], val[j]] = [val[j]!, val[i]!];
  }
  const basehue = hue[keep]!;
  const harm = [0, 0, 0];
  switch (h8(5)) {
    case 0: harm[0] = basehue + h8(30, 50); harm[1] = basehue + h8(10, 30); harm[2] = basehue - h8(10, 30); break;
    case 1: harm[0] = basehue + 113 + h8(15); harm[1] = basehue + 233 + h8(15); harm[2] = basehue - 7 + h8(15); break;
    case 2: harm[0] = basehue + 145 + h8(10); harm[1] = basehue + 205 + h8(10); harm[2] = basehue - 5 + h8(10); break;
    case 3: harm[0] = basehue + 85 + h8(10); harm[1] = basehue + 175 + h8(10); harm[2] = basehue + 265 + h8(10); break;
    default: harm[0] = basehue + 80 + h8(20); harm[1] = basehue + 170 + h8(20); harm[2] = basehue - 15 + h8(30); break;
  }
  for (let i = 0; i < 3; i++) harm[i] = harm[i]! & 0xff;
  if (h8() < 128) for (let i = 2; i > 0; i--) { const j = h8(i + 1); [harm[i], harm[j]] = [harm[j]!, harm[i]!]; }
  let j = 0;
  for (let i = 0; i < 4; i++) { if (i === keep) continue; hue[i] = harm[j++]!; }
  const pastel = h8() < 25;
  const c = [0, 1, 2, 3].map((i) => {
    if (pastel && sat[i]! > 180) sat[i] = sat[i]! - 160;
    return CHSV(hue[i]!, sat[i]!, val[i]!);
  });
  return CRGBPalette16(c[0]!, c[1]!, c[2]!, c[3]!);
}

/**
 * Palette 1 ("* Random Cycle"). WLED changes it every randomPaletteChangeTime (5 s; the check is `>`, so
 * every 6 s) and blends towards the new one over the transition time (default 750 ms). Ours is a pure
 * function of time so server and preview agree: slot k's palette is generated from a seed derived from k
 * (harmonic, based on a random palette from the same seed), and the blend is a straight colour blend.
 */
const RANDOM_PERIOD_MS = 6000, RANDOM_BLEND_MS = 750;
const randomCache = new Map<number, Palette16>();
function randomSlot(k: number): Palette16 {
  let p = randomCache.get(k);
  if (!p) {
    const r = createRandom(0x5eed + k * 7919);
    p = generateHarmonicRandomPalette(generateRandomPalette(r), r);
    if (randomCache.size > 8) randomCache.clear();
    randomCache.set(k, p);
  }
  return p;
}
export function randomCyclePalette(target: Palette16, nowMs: number): void {
  const k = Math.floor(nowMs / RANDOM_PERIOD_MS);
  const into = nowMs - k * RANDOM_PERIOD_MS;
  const cur = randomSlot(k);
  if (into >= RANDOM_BLEND_MS) { target.set(cur); return; }
  const prev = randomSlot(k - 1);
  const amt = Math.floor((into * 255) / RANDOM_BLEND_MS);
  for (let i = 0; i < 16; i++) target[i] = color_blend(prev[i]!, cur[i]!, amt) & 0xffffff;
}

// ---- Segment::loadPalette ---------------------------------------------------------------------

const PARTY = Uint32Array.from(FASTLED_PALETTES[0]!);
const ownCache = new Map<string, Palette16>();

/** Our own (fx/palettes.ts) gradient sampled into 16 entries, as WLED stores custom palettes. */
function ownPalette16(name: string, colorParams: Record<string, unknown>): Palette16 {
  const key = name + '|' + String(colorParams.color1) + String(colorParams.color2) + String(colorParams.color3);
  let p = ownCache.get(key);
  if (!p) {
    const pal = paletteFor(name, colorParams);
    const rgb: [number, number, number] = [0, 0, 0];
    p = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
      samplePalette(pal, i / 16, rgb, false);
      p[i] = RGBW32(Math.round(rgb[0] * 255), Math.round(rgb[1] * 255), Math.round(rgb[2] * 255));
    }
    if (ownCache.size > 256) ownCache.clear();
    ownCache.set(key, p);
  }
  return p;
}

/**
 * Segment::loadPalette: fill `target` for palette id `pal` (0 = the effect's default palette `defaultPal`).
 * `colors` are the segment colours (uint32). `nowMs` drives "* Random Cycle". `colorParams` (the layer's
 * params) resolve our own palettes (ids >= CUSTOM_PALETTE_BASE) and the layer's own stops (CUSTOM_STOPS_ID).
 */
export function loadPalette(target: Palette16, pal: number, defaultPal: number, colors: ArrayLike<number>, nowMs = 0, colorParams: Record<string, unknown> = {}): void {
  if (pal === 0) pal = defaultPal;
  if (pal === CUSTOM_STOPS_ID) {
    // A layer's own palette, built like WLED builds a custom palette (loadCustomPalettes).
    if (isPaletteStops(colorParams.paletteStops)) { loadGradientPalette(target, stopsToGradient(colorParams.paletteStops)); return; }
    pal = 0;
  } else if (pal >= CUSTOM_PALETTE_BASE) {
    const name = OWN_EXTRA[pal - CUSTOM_PALETTE_BASE];
    if (name) { target.set(ownPalette16(name, colorParams)); return; }
    pal = 0;
  } else if (pal >= FIXED_PALETTE_COUNT) pal = 0;
  const prim = colors[0]! & 0xffffff, sec = colors[1]! & 0xffffff, ter = colors[2]! & 0xffffff;
  switch (pal) {
    case 0: target.set(PARTY); break;
    case 1: randomCyclePalette(target, nowMs); break;
    case 2: setPalette16(target, [prim]); break;
    case 3: setPalette16(target, [prim, prim, sec, sec]); break;
    case 4: setPalette16(target, [ter, sec, prim]); break;
    case 5:
      if (colors[2]) setPalette16(target, [prim, prim, prim, prim, prim, sec, sec, sec, sec, sec, ter, ter, ter, ter, ter, prim]);
      else setPalette16(target, [prim, prim, prim, prim, prim, prim, prim, prim, sec, sec, sec, sec, sec, sec, sec, sec]);
      break;
    default:
      if (pal < DYNAMIC_PALETTE_COUNT + FASTLED_PALETTE_COUNT) target.set(FASTLED_PALETTES[pal - DYNAMIC_PALETTE_COUNT]!);
      else loadGradientPalette(target, GRADIENT_PALETTES[pal - DYNAMIC_PALETTE_COUNT - FASTLED_PALETTE_COUNT]!);
  }
}
