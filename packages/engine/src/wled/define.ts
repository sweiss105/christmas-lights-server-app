// Ported from WLED v16.0.1 (https://github.com/wled/WLED): effect metadata format and defaults as in wled00/FX.cpp (_data_FX_MODE_* strings), wled00/util.cpp (extractModeDefaults), wled00/FX_fcn.cpp (Segment::setMode) and wled00/data/index.js (setEffectParameters). Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.
//
// wledEffect() turns a WLED metadata string plus a ported mode function into one of our EffectDefs.

import { parseColor } from '../color.js';
import type { EffectCategory, EffectDef, ParamSpec, Params, RenderFn } from '../effects.js';
import { map1D, map2D, MAPPING_LABELS, MAPPINGS_1D, type Mapping1D } from '../fx/mapping.js';
import { simulation } from '../fx/sim.js';
import type { Layout } from '../layout.js';
import { RGBW32 } from './color.js';
import { setMillis, setRandomSource } from './math.js';
import { loadPalette, resolvePaletteId, WLED_PALETTE_NAMES } from './palettes.js';
import { beginDraw, DEFAULT_C1, DEFAULT_C2, DEFAULT_C3, DEFAULT_INTENSITY, DEFAULT_SPEED, Segment } from './segment.js';

/** A ported WLED mode function: draws one frame into SEGMENT (C: `void mode_xxx(void)`). */
export type ModeFn = () => void;

export interface WledEffectOptions {
  /** The `_data_FX_MODE_*` string from FX.cpp, verbatim. */
  meta: string;
  mode: ModeFn;
  category: EffectCategory;
  /** One line of plain English. */
  description: string;
  /**
   * How the effect's state over time is reproduced (see PORTING.md):
   * - default / object: a deterministic simulation stepped at 40 fps in windows (default 30 s) that start
   *   `warmup` seconds early (default 5 s). Use for anything that reads back pixels or keeps SEGENV state.
   * - `false`: the effect depends only on strip.now; each frame is drawn on a freshly reset segment after
   *   `history` earlier frames (default 1, so "previous value" checks such as SEGENV.step work).
   */
  stateful?: false | { window?: number; warmup?: number };
  history?: number;
  /**
   * For effects that read SEGMENT.name (Scrolling Text): expose the segment name as a `text` param
   * (key `text`, at most WLED_MAX_SEGNAME_LEN characters) with this default.
   */
  text?: { default: string; label?: string };
}

export interface WledMeta {
  name: string;
  /** Slider labels for speed, intensity, custom1..3 ('' = not used). */
  sliders: [string, string, string, string, string];
  /** Checkbox labels for check1..3 ('' = not used). */
  checks: [string, string, string];
  /** Colour slot labels ('' = not used). */
  colors: [string, string, string];
  /** Palette label, or '' when the effect doesn't use a palette. */
  palette: string;
  flags: string;
  is2D: boolean;
  /** Defaults from the last section (sx, ix, c1, c2, c3, o1, o2, o3, pal, m12, ...). */
  defaults: Record<string, number>;
}

const SLIDER_DEFAULT_LABELS = ['Effect speed', 'Effect intensity', 'Custom 1', 'Custom 2', 'Custom 3'];
const CHECK_DEFAULT_LABELS = ['Option 1', 'Option 2', 'Option 3'];
const COLOR_DEFAULT_LABELS = ['Effect colour', 'Background colour', 'Colour 3'];
/** Segment colours a new WLED segment gets: DEFAULT_COLOR, black, black. */
const DEFAULT_COLORS = ['#ffa000', '#000000', '#000000'];

/** Parse a WLED effect metadata string (`Name@sliders;colors;palette;flags;defaults`). */
export function parseWledMeta(meta: string): WledMeta {
  const at = meta.indexOf('@');
  const name = at < 0 ? meta : meta.slice(0, at);
  const controlDefined = at >= 0;
  const parts = controlDefined ? meta.slice(at + 1).split(';') : [];
  const sl = parts.length === 0 || parts[0] === '' ? [] : parts[0]!.split(',');
  const co = parts.length < 2 || parts[1] === '' ? [] : parts[1]!.split(',');
  const pa = parts.length < 3 || parts[2] === '' ? [] : parts[2]!.split(',');

  const sliders = [0, 1, 2, 3, 4].map((i) => {
    if (!controlDefined) return i < 2 ? SLIDER_DEFAULT_LABELS[i]! : '';
    const v = sl[i];
    if (v === undefined || v === '') return '';
    return v === '!' ? SLIDER_DEFAULT_LABELS[i]! : v;
  }) as WledMeta['sliders'];
  const checks = [0, 1, 2].map((i) => {
    const v = sl[5 + i];
    if (v === undefined || v === '') return '';
    return v === '!' ? CHECK_DEFAULT_LABELS[i]! : v;
  }) as WledMeta['checks'];
  const colors = [0, 1, 2].map((i) => {
    if (!controlDefined) return COLOR_DEFAULT_LABELS[i]!;
    const v = co[i];
    if (v === undefined || v === '') return '';
    return v === '!' ? COLOR_DEFAULT_LABELS[i]! : v;
  }) as WledMeta['colors'];
  let palette = '';
  if (!controlDefined) palette = 'Palette';
  else if (pa.length > 0 && pa[0] !== '' && Number.isNaN(Number(pa[0]))) {
    const p = pa[0]!.split('=')[0]!;
    palette = p === '!' ? 'Palette' : p;
  }
  const flags = parts[3] ?? '';
  // Defaults live after the LAST ';' (extractModeDefaults uses strrchr).
  const defaults: Record<string, number> = {};
  const last = meta.lastIndexOf(';');
  if (last >= 0) {
    for (const kv of meta.slice(last + 1).split(',')) {
      const eq = kv.indexOf('=');
      if (eq <= 0) continue;
      const v = parseInt(kv.slice(eq + 1), 10);
      if (Number.isFinite(v)) defaults[kv.slice(0, eq).trim()] = v;
    }
  }
  const is2D = flags.includes('2') && !flags.includes('1');
  return { name, sliders, checks, colors, palette, flags, is2D, defaults };
}

/** wled-<slug of name>, e.g. "Fire 2012" → "wled-fire-2012". */
export const wledSlug = (name: string): string =>
  'wled-' + name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const SLIDER_KEYS = ['speed', 'intensity', 'custom1', 'custom2', 'custom3'] as const;
const SLIDER_DEFAULT_KEYS = ['sx', 'ix', 'c1', 'c2', 'c3'];
const SLIDER_DEFAULTS = [DEFAULT_SPEED, DEFAULT_INTENSITY, DEFAULT_C1, DEFAULT_C2, DEFAULT_C3];
const CHECK_KEYS = ['check1', 'check2', 'check3'] as const;
const COLOR_KEYS = ['color1', 'color2', 'color3'] as const;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Parameters generated from the metadata (WLED labels and defaults). */
export function paramsFromMeta(m: WledMeta): ParamSpec[] {
  const ps: ParamSpec[] = [];
  m.sliders.forEach((label, i) => {
    if (!label) return;
    const max = i === 4 ? 31 : 255;
    const d = m.defaults[SLIDER_DEFAULT_KEYS[i]!];
    ps.push({ key: SLIDER_KEYS[i]!, label, type: 'number', min: 0, max, step: 1, default: clamp(d ?? SLIDER_DEFAULTS[i]!, 0, max) });
  });
  m.checks.forEach((label, i) => {
    if (!label) return;
    const d = m.defaults[`o${i + 1}`];
    ps.push({ key: CHECK_KEYS[i]!, label, type: 'boolean', default: d !== undefined ? d !== 0 : false });
  });
  m.colors.forEach((label, i) => {
    if (!label) return;
    ps.push({ key: COLOR_KEYS[i]!, label, type: 'color', default: DEFAULT_COLORS[i]! });
  });
  // A WLED segment always has three colours, and the "* Color…" palettes are built from them even when
  // the effect shows no colour controls. Keep the unused slots too, shown only with such a palette.
  if (m.palette) {
    m.colors.forEach((label, i) => {
      if (label) return;
      ps.push({ key: COLOR_KEYS[i]!, label: `Palette colour ${i + 1}`, type: 'color', default: DEFAULT_COLORS[i]!, when: { key: 'palette', startsWith: '* ' } });
    });
  }
  if (m.palette) {
    // Selecting an effect in WLED loads `pal=` into the segment's palette (setMode with loadDefaults).
    const pal = m.defaults.pal;
    // Owner's choice (2026-11-24): an effect that names no palette starts on Party, not WLED's "Default"
    // (which draws many effects in plain colour 1). An explicit pal=0 still means Default.
    const def = pal === undefined ? 'Party' : pal > 0 && pal < WLED_PALETTE_NAMES.length ? WLED_PALETTE_NAMES[pal]! : 'Default';
    ps.push({ key: 'palette', label: m.palette === 'Palette' ? 'Palette' : m.palette, type: 'palette', default: def });
  }
  if (!m.is2D) {
    ps.push({ key: 'mapping', label: 'Lights run', type: 'select', options: [...MAPPINGS_1D], labels: { ...MAPPING_LABELS }, default: 'each' });
  }
  return ps;
}

/** Longest segment name WLED keeps (const.h), in bytes there; our `text` param counts characters. */
export const WLED_MAX_SEGNAME_LEN = 64;

/** Cells across the virtual 2D grid; its height follows the house front's aspect ratio. */
export const GRID_WIDTH = 64;
export function gridSize(aspect: number): { w: number; h: number } {
  return { w: GRID_WIDTH, h: clamp(Math.round(GRID_WIDTH / (aspect > 0 ? aspect : 1)), 8, 64) };
}

const FPS = 40;
const BYTE = new Float32Array(256).map((_, i) => i / 255);

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 1000003;
}

/** Turn a WLED metadata string and a ported mode function into an EffectDef. */
export function wledEffect(opts: WledEffectOptions): EffectDef {
  const meta = parseWledMeta(opts.meta);
  const id = wledSlug(meta.name);
  const seed = hashString(id);
  const defaultPal = meta.defaults.pal !== undefined && meta.defaults.pal > 0 ? meta.defaults.pal : 6; // Party if zero or unset

  return {
    id,
    name: meta.name,
    wled: meta.name,
    category: opts.category,
    description: opts.description,
    params: opts.text
      ? [{ key: 'text', label: opts.text.label ?? 'Text', type: 'text', default: opts.text.default, maxLength: WLED_MAX_SEGNAME_LEN }, ...paramsFromMeta(meta)]
      : paramsFromMeta(meta),
    create(p: Params, layout: Layout): RenderFn {
      // ---- geometry: virtual strip or grid, and where each real pixel samples it ----
      const index = new Int32Array(layout.count).fill(-1);
      let width: number, height: number;
      if (meta.is2D) {
        const m = map2D(layout);
        ({ w: width, h: height } = gridSize(m.aspect));
        for (let i = 0; i < layout.count; i++) {
          if (m.x[i]! < 0) continue;
          const cx = Math.round(m.x[i]! * (width - 1)), cy = Math.round((1 - m.y[i]!) * (height - 1)); // WLED row 0 is the top
          index[i] = cx + cy * width;
        }
      } else {
        const m = map1D(layout, ((p.mapping as Mapping1D | undefined) ?? 'each'));
        width = m.length; height = 1;
        for (let i = 0; i < layout.count; i++) if (m.pos[i]! >= 0) index[i] = Math.round(m.pos[i]! * (width - 1));
      }

      // ---- settings shared by every segment instance ----
      const num = (k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d);
      const colors = COLOR_KEYS.map((k, i) => {
        const [r, g, b] = parseColor(typeof p[k] === 'string' ? (p[k] as string) : DEFAULT_COLORS[i]!);
        return RGBW32(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255));
      });
      const palName = typeof p.palette === 'string' ? p.palette : 'Default';
      const palId = Math.max(0, resolvePaletteId(palName));
      const randomPal = palId === 1 || (palId === 0 && defaultPal === 1);
      const colorParams: Record<string, unknown> = { color1: p.color1, color2: p.color2, color3: p.color3 };
      const segName = !opts.text ? '' : typeof p.text === 'string' ? p.text : opts.text.default;

      const makeSegment = (): Segment => {
        const s = new Segment(width, height);
        s.speed = num('speed', meta.defaults.sx ?? DEFAULT_SPEED) & 0xff;
        s.intensity = num('intensity', meta.defaults.ix ?? DEFAULT_INTENSITY) & 0xff;
        s.custom1 = num('custom1', meta.defaults.c1 ?? DEFAULT_C1) & 0xff;
        s.custom2 = num('custom2', meta.defaults.c2 ?? DEFAULT_C2) & 0xff;
        s.custom3 = num('custom3', meta.defaults.c3 ?? DEFAULT_C3);
        s.check1 = typeof p.check1 === 'boolean' ? p.check1 : !!meta.defaults.o1;
        s.check2 = typeof p.check2 === 'boolean' ? p.check2 : !!meta.defaults.o2;
        s.check3 = typeof p.check3 === 'boolean' ? p.check3 : !!meta.defaults.o3;
        s.palette = palId;
        s.name = segName;
        s.colors.set(colors);
        loadPalette(s.currentPalette, palId, defaultPal, colors, 0, colorParams);
        return s;
      };

      const drawFrame = (seg: Segment, rnd: () => number, frame: number) => {
        const now = (frame * 25) >>> 0; // 1000 / FPS ms per frame, uint32 like millis()
        setMillis(now);
        setRandomSource(rnd);
        if (randomPal) loadPalette(seg.currentPalette, palId, defaultPal, colors, now, colorParams);
        beginDraw(seg, now);
        opts.mode();
        seg.call++;
      };

      const stateful = opts.stateful ?? {};
      const sim = stateful === false
        ? simulation<Segment>({
          fps: FPS, window: 1 / FPS, warmup: Math.max(0, opts.history ?? 1) / FPS, seed,
          init: (_r, reuse) => { if (reuse) { reuse.reset(); return reuse; } return makeSegment(); },
          step: (seg, rnd, _dt, frame) => drawFrame(seg, rnd, frame),
        })
        : simulation<Segment>({
          fps: FPS, window: stateful.window ?? 30, warmup: stateful.warmup ?? 5, seed,
          init: (_r, reuse) => { if (reuse) { reuse.reset(); return reuse; } return makeSegment(); },
          step: (seg, rnd, _dt, frame) => drawFrame(seg, rnd, frame),
        });

      return (t, out) => {
        const px = sim.at(t).pixels;
        for (let i = 0, o = 0; i < index.length; i++, o += 3) {
          const k = index[i]!;
          if (k < 0) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; continue; }
          const c = px[k]!;
          out[o] = BYTE[(c >>> 16) & 0xff]!; out[o + 1] = BYTE[(c >>> 8) & 0xff]!; out[o + 2] = BYTE[c & 0xff]!;
        }
      };
    },
  };
}
