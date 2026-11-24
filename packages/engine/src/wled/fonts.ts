// Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/fontmanager.cpp, wled00/fontmanager.h and wled00/util.cpp (utf8_decode, utf8_strlen). Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.
//
// FontManager: loads one of the built-in WBF fonts, caches the glyphs a text needs in SEGENV.data
// (byte for byte the layout WLED uses) and draws glyphs into the segment.
//
// Strings are C strings: a Uint8Array of UTF-8 bytes ending at the first 0 byte.
//
// Deviation: there is no filesystem, so "Custom Font" (.wbf files on the controller) never finds a font
// and always falls back to the built-in font, exactly as WLED does when no .wbf file is uploaded.

import { C64ESQUE_9PX, CONSOLE_FONT_6X8, FONT_5X12, FONT_TINYUNICODE_8PX, FONT_TOM_THUMB_6PX } from './font-data.js';
import { ColorFromPalette, fill_gradient_RGB, LINEARBLEND_NOWRAP, type Palette16 } from './palettes.js';
import { SEGPALETTE, type Segment } from './segment.js';

/** Last standard ASCII char; higher chars are looked up through the font's unicode offset. */
export const LAST_ASCII_CHAR = 127;
export const FONT_HEADER_SIZE = 12;
/** Max segment string length is 64 chars, so this is the absolute worst case. */
export const MAX_CACHED_GLYPHS = 64;
/** Scrolling text supports font numbers 0-4. */
export const MAX_FONTS = 5;

// ---- util.cpp: UTF-8 ------------------------------------------------------------------------------

const UTF8_LEN = (c: number): number => (c < 0x80 ? 1 : c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4);

/** Length of the last utf8_decode() sequence (C: the `uint8_t *len` out-parameter). Unchanged for '\0'. */
export let utf8Len = 0;

/** utf8_decode(&s[i], &len): the code point at byte i; sets utf8Len. Invalid sequences give '?' (length 1). */
export function utf8_decode(s: Uint8Array, i: number): number {
  const c = s[i] ?? 0;
  if (c === 0) return 0;
  const n = UTF8_LEN(c);
  let cp = c;
  utf8Len = n;
  if (n > 1) {
    for (let k = 1; k < n; k++) {
      if (((s[i + k] ?? 0) & 0xc0) !== 0x80) { utf8Len = 1; return 0x3f; } // not a continuation byte (also catches '\0')
    }
    cp &= (1 << (8 - n)) - 1;
    for (let k = 1; k < n; k++) cp = ((cp << 6) | (s[i + k]! & 0x3f)) >>> 0;
  }
  return cp;
}

/** utf8_strlen(): number of UTF-8 characters before the terminating 0. */
export function utf8_strlen(s: Uint8Array): number {
  let len = 0, i = 0;
  while ((s[i] ?? 0) !== 0) {
    const unicode = utf8_decode(s, i);
    if (!unicode) break;
    i += utf8Len;
    len++;
  }
  return len;
}

/** strlen(). */
export function strlen(s: Uint8Array): number {
  let i = 0;
  while ((s[i] ?? 0) !== 0) i++;
  return i;
}

// ---- FontManager ----------------------------------------------------------------------------------

/*
 * Memory layout of the cached font in SEGENV.data:
 *   [SegmentFontMetadata] 4 bytes: availableFonts, cachedFontNum (0xFF none, bit 7 = file font), lastFontNum, glyphCount
 *   [GlyphEntry array]    4 bytes each: code (glyph index), width, height, reserved
 *   [12-byte font header] copy of the font's header
 *   [bitmap data]         glyph bitmaps in registry order
 */
const META_SIZE = 4;
const GLYPH_ENTRY_SIZE = 4;
const M_AVAILABLE = 0, M_CACHED = 1, M_LAST = 2, M_COUNT = 3;
// header field offsets ([0] is the magic 'W')
const H_HEIGHT = 1, H_WIDTH = 2, H_SPACING = 3, H_FLAGS = 4, H_FIRST = 5, H_LAST = 6, H_UNICODE = 8;

/** Built-in fonts by number (Font size slider). */
const FLASH_FONTS: readonly Uint8Array[] = [FONT_TOM_THUMB_6PX, FONT_TINYUNICODE_8PX, CONSOLE_FONT_6X8, C64ESQUE_9PX, FONT_5X12];

const u32le = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** getGlyphIndex() on a header stored at `o` in `b`. */
function glyphIndex(unicode: number, b: Uint8Array, o: number): number {
  const first = b[o + H_FIRST]!, last = b[o + H_LAST]!;
  if (unicode <= LAST_ASCII_CHAR) {
    if (unicode >= first && unicode <= last) return unicode - first;
  } else {
    const firstUnicode = u32le(b, o + H_UNICODE);
    if (firstUnicode > 0 && unicode >= firstUnicode) {
      const adjusted = unicode - firstUnicode + LAST_ASCII_CHAR + 1;
      if (adjusted >= first && adjusted <= last) return adjusted - first;
    }
  }
  return -1;
}

const S_NUMS = new Uint8Array([...'0123456789:. '].map((c) => c.charCodeAt(0)));
// scratch buffers (C: stack arrays)
const neededScratch = new Uint8Array(MAX_CACHED_GLYPHS);
const widthTable = new Uint8Array(256);
const headerScratch = new Uint8Array(FONT_HEADER_SIZE);
const gradScratch: Palette16 = new Uint32Array(16);

export class FontManager {
  private _segment: Segment;
  private _fontNum = 0;
  private _useFileFont = false;
  private _cacheNumbers = false;
  /** Offset of the cached font header in _segment.data (C: _fontBase pointer; -1 = nullptr). */
  private _fontBase = -1;

  constructor(seg: Segment) { this._segment = seg; }

  /** Re-run the constructor on an existing instance (WLED builds a new FontManager every frame). */
  init(seg: Segment): this {
    this._segment = seg; this._fontNum = 0; this._useFileFont = false; this._cacheNumbers = false; this._fontBase = -1;
    return this;
  }

  cacheNumbers(cache: boolean): void { this._cacheNumbers = cache; }

  getFontHeight(): number { return this._segment.data[this._fontBase + H_HEIGHT]!; }
  getFontWidth(): number { return this._segment.data[this._fontBase + H_WIDTH]!; }
  getFontSpacing(): number { return this._segment.data[this._fontBase + H_SPACING]!; }

  private updateFontBase(): void {
    this._fontBase = META_SIZE + this._segment.data[M_COUNT]! * GLYPH_ENTRY_SIZE;
  }

  /** No filesystem: no .wbf fonts are ever available. */
  private scanAvailableFonts(): void {
    this._segment.data[M_AVAILABLE] = 0;
  }

  /** Load font by number and prepare the glyph cache; the font must not be used if this returns false. */
  loadFont(fontNum: number, text: Uint8Array, useFile: boolean): boolean {
    const seg = this._segment;
    seg.allocateData(META_SIZE);
    const meta = seg.data;
    if (!meta.length) return false;

    this._fontNum = fontNum;
    this._useFileFont = useFile;
    const fontRequested = (fontNum | (useFile ? 0x80 : 0x00)) & 0xff;

    if (useFile) {
      if (meta[M_LAST] !== fontRequested) this.scanAvailableFonts();
      if (!(meta[M_AVAILABLE]! & (1 << fontNum))) {
        this._fontNum = 0xff;
        for (let i = 0; i < MAX_FONTS; i++) {
          if (meta[M_AVAILABLE]! & (1 << i)) { this._fontNum = i; break; }
        }
        if (this._fontNum === 0xff) {
          this._fontNum = fontNum; // no custom fonts available, use flash font
          this._useFileFont = false;
        }
      }
    }
    meta[M_LAST] = fontRequested;

    const fontToUse = (this._fontNum | (this._useFileFont ? 0x80 : 0x00)) & 0xff;
    if (fontToUse !== meta[M_CACHED]) meta[M_COUNT] = 0;
    this.cacheGlyphs(text);
    if (seg.data[M_COUNT] === 0) return false; // cache build failed
    return true;
  }

  /** Check that every glyph the text needs is cached; rebuild the cache if not. */
  cacheGlyphs(text: Uint8Array): void {
    const data = this._segment.data;
    if (data[M_COUNT] === 0) { this.rebuildCache(text); return; }

    this.updateFontBase();
    const neededCount = this.collectNeededCodes(text, data, this._fontBase, neededScratch);
    const count = data[M_COUNT]!;
    for (let k = 0; k < neededCount; k++) {
      let found = false;
      for (let j = 0; j < count; j++) {
        if (data[META_SIZE + j * GLYPH_ENTRY_SIZE] === neededScratch[k]) { found = true; break; }
      }
      if (!found) { this.rebuildCache(text); return; }
    }
  }

  private rebuildCache(text: Uint8Array): void {
    const seg = this._segment;
    seg.data[M_COUNT] = 0; // invalidates cached font
    const savedAvailable = seg.data[M_AVAILABLE]!, savedLast = seg.data[M_LAST]!;

    // file fonts: none (no filesystem), fall straight back to the flash font
    if (this._useFileFont) this._useFileFont = false;
    const savedCached = (this._fontNum | (this._useFileFont ? 0x80 : 0x00)) & 0xff;

    const flashFont = FLASH_FONTS[this._fontNum] ?? FLASH_FONTS[0]!; // default: case 0
    const hdr = headerScratch;
    hdr.set(flashFont.subarray(0, FONT_HEADER_SIZE));

    const neededCount = this.collectNeededCodes(text, hdr, 0, neededScratch);
    const numGlyphs = hdr[H_LAST]! - hdr[H_FIRST]! + 1;
    const height = hdr[H_HEIGHT]!;

    if (hdr[H_FLAGS]! & 0x01) widthTable.set(flashFont.subarray(FONT_HEADER_SIZE, FONT_HEADER_SIZE + numGlyphs));
    else widthTable.fill(hdr[H_WIDTH]!, 0, numGlyphs);

    let ramFontSize = META_SIZE + neededCount * GLYPH_ENTRY_SIZE + FONT_HEADER_SIZE;
    for (let k = 0; k < neededCount; k++) {
      const code = neededScratch[k]!;
      if (code < numGlyphs) {
        const bits = (widthTable[code]! * height) & 0xffff;
        ramFontSize += (bits + 7) >> 3;
      }
    }
    if (!seg.allocateData(ramFontSize)) return;

    const data = seg.data;
    data[M_AVAILABLE] = savedAvailable; data[M_CACHED] = savedCached; data[M_LAST] = savedLast;
    data[M_COUNT] = neededCount;

    let p = META_SIZE;
    for (let k = 0; k < neededCount; k++) {
      const code = neededScratch[k]!;
      if (code >= numGlyphs) continue;
      const e = p + k * GLYPH_ENTRY_SIZE;
      data[e] = code; data[e + 1] = widthTable[code]!; data[e + 2] = height;
    }
    p += neededCount * GLYPH_ENTRY_SIZE;

    data.set(hdr, p);
    p += FONT_HEADER_SIZE;

    const dataStart = FONT_HEADER_SIZE + (hdr[H_FLAGS]! & 0x01 ? numGlyphs : 0);
    for (let k = 0; k < neededCount; k++) {
      const glyphIdx = neededScratch[k]!;
      const bytes = (((widthTable[glyphIdx]! * height) & 0xffff) + 7) >> 3;
      let offset = dataStart;
      for (let j = 0; j < glyphIdx; j++) offset += (((widthTable[j]! * height) & 0xffff) + 7) >> 3;
      for (let b = 0; b < bytes; b++) data[p + b] = flashFont[offset + b] ?? 0;
      p += bytes;
    }
    this.updateFontBase();
  }

  /** Width of a cached glyph (0 if the character isn't in the font or not cached). */
  getGlyphWidth(unicode: number): number {
    const data = this._segment.data;
    const idx = glyphIndex(unicode, data, this._fontBase);
    if (idx < 0) return 0;
    const count = data[M_COUNT]!;
    for (let k = 0; k < count; k++) {
      const e = META_SIZE + k * GLYPH_ENTRY_SIZE;
      if (data[e] === idx) return data[e + 1]!;
    }
    return 0;
  }

  // getGlyphBitmap() out-parameters
  private _outW = 0;
  private _outH = 0;

  /** Offset of the glyph's bitmap in _segment.data, or -1 (C: nullptr). */
  private getGlyphBitmap(unicode: number): number {
    const data = this._segment.data;
    const idx = glyphIndex(unicode, data, this._fontBase);
    if (idx < 0) return -1;
    const count = data[M_COUNT]!;
    let bitmapOffset = 0;
    for (let k = 0; k < count; k++) {
      const e = META_SIZE + k * GLYPH_ENTRY_SIZE;
      if (data[e] === idx) {
        this._outW = data[e + 1]!; this._outH = data[e + 2]!;
        return this._fontBase + FONT_HEADER_SIZE + bitmapOffset;
      }
      const bits = (data[e + 1]! * data[e + 2]!) & 0xffff;
      bitmapOffset += (bits + 7) >> 3;
    }
    return -1;
  }

  /** Glyph indices the text needs (unique, unknown chars as '?'), plus the clock digits if cacheNumbers is set. */
  private collectNeededCodes(text: Uint8Array, hb: Uint8Array, ho: number, outCodes: Uint8Array): number {
    let count = 0;
    if (this._cacheNumbers) {
      for (let p = 0; p < S_NUMS.length && count < MAX_CACHED_GLYPHS; p++) {
        const idx = glyphIndex(S_NUMS[p]!, hb, ho);
        if (idx >= 0 && idx < 256) outCodes[count++] = idx;
      }
    }
    let i = 0;
    const len = strlen(text);
    while (i < len && count < MAX_CACHED_GLYPHS) {
      utf8Len = 0;
      const unicode = utf8_decode(text, i);
      if (!utf8Len) break;
      i += utf8Len;
      let idx = glyphIndex(unicode, hb, ho);
      if (idx < 0) idx = glyphIndex(0x3f, hb, ho); // '?'
      if (idx >= 0 && idx < 256) {
        let exists = false;
        for (let k = 0; k < count; k++) if (outCodes[k] === idx) { exists = true; break; }
        if (!exists) outCodes[count++] = idx;
      }
    }
    return count;
  }

  /**
   * Draw one glyph with its top-left corner at (x, y). Each row gets a colour from a gradient: color → col2,
   * or the segment palette when col2 is black. rotate: 0 normal, -1 90° CW, 1 90° CCW, ±2 upside down.
   */
  drawCharacter(unicode: number, x: number, y: number, color: number, col2: number, rotate: number): void {
    const bitmap = this.getGlyphBitmap(unicode);
    const w = this._outW, h = this._outH;
    if (bitmap < 0 || w === 0) return;
    let grad: Palette16;
    if (col2) { fill_gradient_RGB(gradScratch, 0, color & 0xffffff, 15, col2 & 0xffffff); grad = gradScratch; } else grad = SEGPALETTE;
    x = (x << 16) >> 16; y = (y << 16) >> 16; // int16_t
    const data = this._segment.data;
    let bitIndex = 0;
    for (let row = 0; row < h; row++) {
      const c = ColorFromPalette(grad, Math.trunc(((row + 1) * 255) / h), 255, LINEARBLEND_NOWRAP);
      for (let col = 0; col < w; col++) {
        const bytePos = bitIndex >> 3;
        const bitPos = 7 - (bitIndex & 7);
        if ((data[bitmap + bytePos]! >> bitPos) & 1) {
          let x0: number, y0: number;
          switch (rotate) {
            case -1: x0 = x + row; y0 = y + col; break; // 90° CW
            case 1: x0 = x + (h - 1) - row; y0 = y + (w - 1) - col; break; // 90° CCW
            case -2:
            case 2: x0 = x + (w - 1) - col; y0 = y + (h - 1) - row; break;
            default: x0 = x + col; y0 = y + row; break;
          }
          this._segment.setPixelColorXY(x0, y0, c); // bounds checking is done in setPixelColorXY
        }
        bitIndex = (bitIndex + 1) & 0xffff;
      }
    }
  }
}

