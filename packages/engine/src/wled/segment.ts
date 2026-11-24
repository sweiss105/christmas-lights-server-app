// Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/FX.h, wled00/FX_fcn.cpp and wled00/FX_2Dfcn.cpp (Segment methods). Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.
//
// A WLED Segment emulation over a uint32 pixel buffer. Simplified where WLED features don't apply here:
// no grouping/spacing/offset/mirror/reverse/transpose, no transitions or clipping, 1D-on-2D mapping is
// always "Pixels" (M12_Pixels), and the segment is always active.
//
// As in WLED, effects reach the segment being drawn through globals: SEGMENT / SEGENV (the same object),
// SEGLEN, SEG_W, SEG_H, SEGPALETTE, SEGCOLOR(i) and `strip`. They are ES-module live bindings updated by
// beginDraw() before every call of a mode function.

import { color_add, color_blend, color_fade, CHSV32, fast_color_scale, G, R, B, RGBW32, W } from './color.js';
import { qadd8 } from './math.js';
import { ColorFromPalette, LINEARBLEND, LINEARBLEND_NOWRAP, NOBLEND, type Palette16 } from './palettes.js';

export const NUM_COLORS = 3;
export const DEFAULT_SPEED = 128, DEFAULT_INTENSITY = 128, DEFAULT_C1 = 128, DEFAULT_C2 = 128, DEFAULT_C3 = 16;
/** Our engine runs effects at 40 fps; WLED's FRAMETIME is the configured frame time. */
export const FRAMETIME = 25;
/** FRAMETIME_FIXED = 1000 / WLED_FPS (42), integer division as in C. */
export const FRAMETIME_FIXED = 23;
/** WLED global paletteBlend (0: blend, wrap only when moving). */
export const paletteBlend = 0;
export const PALETTE_SOLID_WRAP = false; // (paletteBlend == 1 || paletteBlend == 3)
/** PALETTE_MOVING_WRAP: !(paletteBlend == 2 || (paletteBlend == 0 && SEGMENT.speed == 0)). */
export const PALETTE_MOVING_WRAP = (): boolean => !(SEGMENT.speed === 0);

export const M12_Pixels = 0, M12_pBar = 1, M12_pArc = 2, M12_pCorner = 3, M12_sPinwheel = 4;

/** FX.cpp indexToVStrip(index, stripNr): pack a virtual-strip number into a 1D index. */
export const indexToVStrip = (index: number, stripNr: number): number => (index | ((stripNr + 1) << 16)) >>> 0;

type TypedArrayCtor = Uint8ArrayConstructor | Int8ArrayConstructor | Uint16ArrayConstructor | Int16ArrayConstructor
  | Uint32ArrayConstructor | Int32ArrayConstructor | Float32ArrayConstructor;

const EMPTY = new Uint8Array(0);

export class Segment {
  // ---- effect settings (FX.h) ----
  speed = DEFAULT_SPEED;
  intensity = DEFAULT_INTENSITY;
  custom1 = DEFAULT_C1;
  custom2 = DEFAULT_C2;
  private _custom3 = DEFAULT_C3;
  check1 = false;
  check2 = false;
  check3 = false;
  /** Palette id: 0 = Default, 1..71 WLED palettes, >= 100 our own palettes. */
  palette = 0;
  /** colors[0..2] as uint32 0xWWRRGGBB (SEGCOLOR(i) reads these). */
  readonly colors = new Uint32Array(NUM_COLORS);
  mode = 0;
  name = '';
  /** Fixed values for options WLED effects occasionally read. */
  readonly offset = 0;
  readonly reverse = false;
  readonly mirror = false;
  readonly cct = 127;
  readonly soundSim = 0;
  readonly map1D2D = M12_Pixels;

  // ---- runtime state (SEGENV) with C integer widths ----
  private _step = 0;
  private _call = 0;
  private _aux0 = 0;
  private _aux1 = 0;
  /** SEGENV.data: zero-length until allocateData() succeeds (C: nullptr). */
  data: Uint8Array = EMPTY;
  private _dataLen = 0;
  private views = new Map<TypedArrayCtor, ArrayLike<number>>();
  private _dv: DataView | null = null;

  // ---- geometry / buffer ----
  private readonly _w: number;
  private readonly _h: number;
  /** Pixel buffer, vWidth*vHeight uint32 (row-major, y = 0 is the TOP row as in WLED). */
  readonly pixels: Uint32Array;
  /** _currentPalette (SEGPALETTE). */
  readonly currentPalette: Palette16 = new Uint32Array(16);

  constructor(width: number, height = 1) {
    this._w = Math.max(1, width | 0);
    this._h = Math.max(1, height | 0);
    this.pixels = new Uint32Array(this._w * this._h);
  }

  get custom3(): number { return this._custom3; }
  set custom3(v: number) { this._custom3 = v & 0x1f; }
  /** uint32 */
  get step(): number { return this._step; }
  set step(v: number) { this._step = v >>> 0; }
  /** uint32 call counter */
  get call(): number { return this._call; }
  set call(v: number) { this._call = v >>> 0; }
  /** uint16 */
  get aux0(): number { return this._aux0; }
  set aux0(v: number) { this._aux0 = v & 0xffff; }
  /** uint16 */
  get aux1(): number { return this._aux1; }
  set aux1(v: number) { this._aux1 = v & 0xffff; }

  /** Clears runtime state like Segment::resetIfRequired() (keeps the data buffer, zeroed). */
  reset(): void {
    this.data.fill(0);
    this.pixels.fill(0);
    this._step = 0; this._call = 0; this._aux0 = 0; this._aux1 = 0;
  }

  // ---- SEGENV data ----
  dataSize(): number { return this._dataLen; }
  /** Allocates (and clears) `len` bytes of effect data; keeps a large-enough buffer, clearing it on the first call. */
  allocateData(len: number): boolean {
    len = Math.trunc(len);
    if (len <= 0) return false;
    if (this.data.length && this._dataLen >= len) {
      if (this._call === 0) this.data.fill(0, 0, len);
      return true;
    }
    this.data = new Uint8Array(len);
    this._dataLen = len;
    this.views.clear();
    this._dv = null;
    return true;
  }
  deallocateData(): void { this.data = EMPTY; this._dataLen = 0; this.views.clear(); this._dv = null; }
  /**
   * A typed view over SEGENV.data, cached until data is reallocated (C: reinterpret_cast<T*>(SEGENV.data)).
   * Little-endian, like the ESP32. Length is floor(dataSize / element size).
   */
  view<C extends TypedArrayCtor>(ctor: C): InstanceType<C> {
    let v = this.views.get(ctor);
    if (!v) {
      v = new ctor(this.data.buffer as ArrayBuffer, this.data.byteOffset, Math.floor(this.data.byteLength / ctor.BYTES_PER_ELEMENT));
      this.views.set(ctor, v);
    }
    return v as InstanceType<C>;
  }
  /** DataView over SEGENV.data, for C structs with mixed field types (always pass littleEndian = true). */
  get dataView(): DataView {
    if (!this._dv) this._dv = new DataView(this.data.buffer as ArrayBuffer, this.data.byteOffset, this.data.byteLength);
    return this._dv;
  }

  // ---- geometry ----
  isActive(): boolean { return true; }
  width(): number { return this._w; }
  height(): number { return this._h; }
  length(): number { return this._w * this._h; }
  is2D(): boolean { return this._w > 1 && this._h > 1; }
  virtualWidth(): number { return this._w; }
  virtualHeight(): number { return this._h; }
  virtualLength(): number { return this._w * this._h; }
  vWidth(): number { return this._w; }
  vHeight(): number { return this._h; }
  vLength(): number { return this._w * this._h; }
  nrOfVStrips(): number { return 1; }
  rawLength(): number { return this._w * this._h; }
  maxMappingLength(): number { return this._w * this._h; }
  setDrawDimensions(): void { /* dimensions are fixed per segment */ }

  // ---- 1D drawing ----
  setPixelColor(i: number, col: number): void {
    i = Math.trunc(i);
    if (i < 0) return;
    const vL = this._w * this._h;
    if (i >= vL) { i &= 0xffff; if (i >= vL) return; }
    // 2D with M12_Pixels maps i to XY(i % vW, i / vW), i.e. the same raw index
    this.pixels[i] = col;
  }
  getPixelColor(i: number): number {
    i = Math.trunc(i);
    if (i < 0) return 0;
    i &= 0xffff;
    if (i >= this._w * this._h) return 0;
    return this.pixels[i]!;
  }
  isPixelClipped(_i: number): boolean { return false; }
  setRawPixelColor(i: number, col: number): void { if (i >= 0 && i < this.pixels.length) this.pixels[i] = col; }
  setPixelColorRaw(i: number, col: number): void { this.pixels[i] = col; }
  getPixelColorRaw(i: number): number { return this.pixels[i]!; }
  blendPixelColor(n: number, color: number, blend: number): void { this.setPixelColor(n, color_blend(this.getPixelColor(n), color, blend)); }
  addPixelColor(n: number, color: number, preserveCR = true): void { this.setPixelColor(n, color_add(this.getPixelColor(n), color, preserveCR)); }
  fadePixelColor(n: number, fade: number): void { this.setPixelColor(n, color_fade(this.getPixelColor(n), fade, true)); }

  fill(c: number): void { this.pixels.fill(c >>> 0); }
  clear(): void { this.fill(0); }
  fill_solid(c: number): void { this.fill(c & 0xffffff); }

  /** Fade towards colors[1]; higher rate = quicker fade. */
  fade_out(rate: number): void {
    rate = ((256 - (rate & 0xff)) >> 1) & 0xff;
    const mappedRate = Math.trunc(256 / (rate + 1));
    const bg = this.colors[1]!;
    const px = this.pixels, n = px.length;
    for (let j = 0; j < n; j++) {
      let color = px[j]!;
      if (color === bg) continue;
      for (let i = 0; i < 32; i += 8) {
        const c2 = (bg >>> i) & 0xff, c1 = (color >>> i) & 0xff;
        let delta = Math.trunc(((c2 - c1) * mappedRate) / 256);
        if (delta === 0) delta += c2 === c1 ? 0 : c2 > c1 ? 1 : -1;
        color = ((color & ~(0xff << i)) | (((c1 + delta) & 0xff) << i)) >>> 0;
      }
      px[j] = color;
    }
  }
  fadeToSecondaryBy(fadeBy: number): void {
    fadeBy &= 0xff;
    if (fadeBy === 0) return;
    const bg = this.colors[1]!, px = this.pixels;
    for (let i = 0; i < px.length; i++) px[i] = color_blend(px[i]!, bg, fadeBy);
  }
  fadeToBlackBy(fadeBy: number): void {
    fadeBy &= 0xff;
    if (fadeBy === 0) return;
    const keep = 255 - fadeBy, px = this.pixels;
    for (let i = 0; i < px.length; i++) px[i] = fast_color_scale(px[i]!, keep);
  }

  /** FastLED-style blur (1D), or a symmetric blur2D() on 2D segments. */
  blur(blurAmount: number, smear = false): void {
    blurAmount &= 0xff;
    if (blurAmount === 0) return;
    if (this.is2D()) { this.blur2D(blurAmount, blurAmount, smear); return; }
    const keep = smear ? 255 : 255 - blurAmount, seep = blurAmount >> 1;
    const px = this.pixels, n = this.vLength();
    let cur = px[0]!;
    let carry = fast_color_scale(cur, seep);
    px[0] = fast_color_scale(cur, keep);
    for (let i = 1; i < n; i++) {
      cur = px[i]!;
      const part = fast_color_scale(cur, seep);
      cur = color_add(fast_color_scale(cur, keep), carry);
      px[i - 1] = color_add(px[i - 1]!, part);
      px[i] = cur;
      carry = part;
    }
  }

  /** Colour from the effect's palette, or SEGCOLOR(mcol) when the palette is Default and mcol < 3. */
  color_from_palette(i: number, mapping: boolean, moving: boolean, mcol: number, pbri = 255): number {
    mcol &= 0xff; pbri &= 0xff; i &= 0xffff;
    const color = this.colors[mcol < NUM_COLORS ? mcol : 0]!;
    if (this.palette === 0 && mcol < NUM_COLORS) return color_fade(color, pbri, true);
    let paletteIndex = i;
    if (mapping) paletteIndex = Math.min(Math.trunc((i * 255) / this.vLength()), 255);
    const blend = moving ? LINEARBLEND : LINEARBLEND_NOWRAP; // paletteBlend == 0
    const palcol = ColorFromPalette(this.currentPalette, paletteIndex, pbri, blend);
    return (palcol | ((W(color) << 24) >>> 0)) >>> 0;
  }
  /** Colour wheel: palette when one is selected, else HSV rainbow (hue = pos << 8). */
  color_wheel(pos: number): number {
    pos &= 0xff;
    if (this.palette) return this.color_from_palette(pos, false, true, 0);
    return (CHSV32(pos << 8, 255, 255) | ((W(this.colors[0]!) << 24) >>> 0)) >>> 0;
  }

  // ---- 2D drawing (FX_2Dfcn.cpp) ----
  setPixelColorXY(x: number, y: number, col: number): void {
    x = Math.trunc(x); y = Math.trunc(y);
    if (x < 0 || y < 0 || x >= this._w || y >= this._h) return;
    this.pixels[x + y * this._w] = col;
  }
  getPixelColorXY(x: number, y: number): number {
    x = Math.trunc(x); y = Math.trunc(y);
    if (x < 0 || y < 0 || x >= this._w || y >= this._h) return 0;
    return this.pixels[x + y * this._w]!;
  }
  isPixelXYClipped(_x: number, _y: number): boolean { return false; }
  blendPixelColorXY(x: number, y: number, color: number, blend: number): void {
    // C signature takes uint16 coordinates
    x &= 0xffff; y &= 0xffff;
    this.setPixelColorXY(x, y, color_blend(this.getPixelColorXY(x, y), color, blend));
  }
  addPixelColorXY(x: number, y: number, color: number, preserveCR = true): void {
    this.setPixelColorXY(x, y, color_add(this.getPixelColorXY(x, y), color, preserveCR));
  }
  fadePixelColorXY(x: number, y: number, fade: number): void {
    x &= 0xffff; y &= 0xffff;
    this.setPixelColorXY(x, y, color_fade(this.getPixelColorXY(x, y), fade, true));
  }
  blurCols(amount: number, smear = false): void { this.blur2D(0, amount, smear); }
  blurRows(amount: number, smear = false): void { this.blur2D(amount, 0, smear); }

  blur2D(blurX: number, blurY: number, smear = false): void {
    blurX &= 0xff; blurY &= 0xff;
    const cols = this._w, rows = this._h, px = this.pixels;
    if (blurX) {
      const keep = smear ? 255 : 255 - blurX, seep = blurX >> 1;
      for (let row = 0; row < rows; row++) {
        const o = row * cols;
        let cur = px[o]!;
        let carry = fast_color_scale(cur, seep);
        px[o] = fast_color_scale(cur, keep);
        for (let x = 1; x < cols; x++) {
          cur = px[o + x]!;
          const part = fast_color_scale(cur, seep);
          cur = color_add(fast_color_scale(cur, keep), carry);
          px[o + x - 1] = color_add(px[o + x - 1]!, part);
          px[o + x] = cur;
          carry = part;
        }
      }
    }
    if (blurY) {
      const keep = smear ? 255 : 255 - blurY, seep = blurY >> 1;
      for (let col = 0; col < cols; col++) {
        let cur = px[col]!;
        let carry = fast_color_scale(cur, seep);
        px[col] = fast_color_scale(cur, keep);
        for (let y = 1; y < rows; y++) {
          const k = col + y * cols;
          cur = px[k]!;
          const part = fast_color_scale(cur, seep);
          cur = color_add(fast_color_scale(cur, keep), carry);
          px[k - cols] = color_add(px[k - cols]!, part);
          px[k] = cur;
          carry = part;
        }
      }
    }
  }

  private tmpLine = new Uint32Array(0);
  private line(n: number): Uint32Array { if (this.tmpLine.length < n) this.tmpLine = new Uint32Array(n); return this.tmpLine; }

  moveX(delta: number, wrap = false): void {
    if (!delta) return;
    const vW = this._w, vH = this._h, px = this.pixels;
    const absDelta = Math.abs(delta);
    if (absDelta >= vW) return;
    const tmp = this.line(vW);
    let newDelta: number, stop = vW, start = 0;
    if (wrap) newDelta = (delta + vW) % vW;
    else { if (delta < 0) start = absDelta; stop = vW - absDelta; newDelta = delta > 0 ? delta : 0; }
    for (let y = 0; y < vH; y++) {
      for (let x = 0; x < stop; x++) { let sx = x + newDelta; if (wrap) sx %= vW; tmp[x] = px[sx + y * vW]!; }
      for (let x = 0; x < stop; x++) px[x + start + y * vW] = tmp[x]!;
    }
  }
  moveY(delta: number, wrap = false): void {
    if (!delta) return;
    const vW = this._w, vH = this._h, px = this.pixels;
    const absDelta = Math.abs(delta);
    if (absDelta >= vH) return;
    const tmp = this.line(vH);
    let newDelta: number, stop = vH, start = 0;
    if (wrap) newDelta = (delta + vH) % vH;
    else { if (delta < 0) start = absDelta; stop = vH - absDelta; newDelta = delta > 0 ? delta : 0; }
    for (let x = 0; x < vW; x++) {
      for (let y = 0; y < stop; y++) { let sy = y + newDelta; if (wrap) sy %= vH; tmp[y] = px[x + sy * vW]!; }
      for (let y = 0; y < stop; y++) px[x + (y + start) * vW] = tmp[y]!;
    }
  }
  /** dir: 0=left, 1=left-up, 2=up, 3=right-up, 4=right, 5=right-down, 6=down, 7=left-down. */
  move(dir: number, delta: number, wrap = false): void {
    if (delta === 0) return;
    switch (dir) {
      case 0: this.moveX(delta, wrap); break;
      case 1: this.moveX(delta, wrap); this.moveY(delta, wrap); break;
      case 2: this.moveY(delta, wrap); break;
      case 3: this.moveX(-delta, wrap); this.moveY(delta, wrap); break;
      case 4: this.moveX(-delta, wrap); break;
      case 5: this.moveX(-delta, wrap); this.moveY(-delta, wrap); break;
      case 6: this.moveY(-delta, wrap); break;
      case 7: this.moveX(delta, wrap); this.moveY(-delta, wrap); break;
    }
  }

  drawCircle(cx: number, cy: number, radius: number, col: number, soft = false): void {
    cx &= 0xffff; cy &= 0xffff; radius &= 0xff;
    if (radius === 0) return;
    const fr = Math.fround;
    if (soft) {
      const rsq = radius * radius;
      let x = 0, y = radius, oldFade = 0;
      while (x < y) {
        const yf = fr(Math.sqrt(rsq - x * x));
        const fade = Math.trunc(fr(255 * fr(Math.ceil(yf) - yf))) & 0xff;
        if (oldFade > fade) y--;
        oldFade = fade;
        for (let i = 0; i < 16; i++) {
          const swaps = i & 0x4 ? 1 : 0, adj = i < 8 ? 0 : 1;
          const dx = i & 1 ? -1 : 1, dy = i & 2 ? -1 : 1;
          let px: number, py: number;
          if (swaps) { px = cx + (y - adj) * dx; py = cy + x * dy; } else { px = cx + x * dx; py = cy + (y - adj) * dy; }
          const pixCol = this.getPixelColorXY(px, py);
          this.setPixelColorXY(px, py, adj ? color_blend(pixCol, col, fade) : color_blend(col, pixCol, fade));
        }
        x++;
      }
    } else {
      let d = 3 - 2 * radius, y = radius, x = 0;
      while (y >= x) {
        for (let i = 0; i < 4; i++) {
          const dx = i & 1 ? -x : x, dy = i & 2 ? -y : y;
          this.setPixelColorXY(cx + dx, cy + dy, col);
          this.setPixelColorXY(cx + dy, cy + dx, col);
        }
        x++;
        if (d > 0) { y--; d += 4 * (x - y) + 10; } else d += 4 * x + 6;
      }
    }
  }
  fillCircle(cx: number, cy: number, radius: number, col: number, soft = false): void {
    cx &= 0xffff; cy &= 0xffff; radius &= 0xff;
    if (radius === 0) return;
    const vW = this._w, vH = this._h;
    if (soft) this.drawCircle(cx, cy, radius, col, soft);
    for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
      if (x * x + y * y <= radius * radius && cx + x >= 0 && cy + y >= 0 && cx + x < vW && cy + y < vH) this.setPixelColorXY(cx + x, cy + y, col);
    }
  }
  drawLine(x0: number, y0: number, x1: number, y1: number, c: number, soft = false): void {
    x0 &= 0xffff; y0 &= 0xffff; x1 &= 0xffff; y1 &= 0xffff;
    const vW = this._w, vH = this._h;
    if (x0 >= vW || x1 >= vW || y0 >= vH || y1 >= vH) return;
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    if (dx + dy === 0) { this.setPixelColorXY(x0, y0, c); return; }
    if (soft) {
      const fr = Math.fround;
      const steep = dy > dx;
      if (steep) { [x0, y0] = [y0, x0]; [x1, y1] = [y1, x1]; }
      if (x0 > x1) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; }
      const gradient = x1 - x0 === 0 ? 1 : fr((y1 - y0) / (x1 - x0));
      let intersectY = y0;
      for (let x = x0; x <= x1; x++) {
        const keep = Math.trunc(fr(255 * fr(intersectY - Math.trunc(intersectY)))) & 0xff;
        const seep = 0xff - keep;
        const y = Math.trunc(intersectY);
        if (steep) {
          this.blendPixelColorXY(y, x, c, seep);
          this.blendPixelColorXY(y + 1, x, c, keep);
        } else {
          this.blendPixelColorXY(x, y, c, seep);
          this.blendPixelColorXY(x, y + 1, c, keep);
        }
        intersectY = fr(intersectY + gradient);
      }
    } else {
      let err = Math.trunc((dx > dy ? dx : -dy) / 2);
      for (;;) {
        this.setPixelColorXY(x0, y0, c);
        if (x0 === x1 && y0 === y1) break;
        const e2 = err;
        if (e2 > -dx) { err -= dy; x0 += sx; }
        if (e2 < dy) { err += dx; y0 += sy; }
      }
    }
  }
  /** Anti-aliased pixel at 8.8 fixed-point coordinates (saturating add). */
  wu_pixel(x: number, y: number, c: number): void {
    x >>>= 0; y >>>= 0;
    const xx = x & 0xff, yy = y & 0xff, ix = 255 - xx, iy = 255 - yy;
    const wuw = (a: number, b: number) => ((a * b + a + b) >> 8) & 0xff;
    const wu0 = wuw(ix, iy), wu1 = wuw(xx, iy), wu2 = wuw(ix, yy), wu3 = wuw(xx, yy);
    for (let i = 0; i < 4; i++) {
      const w = i === 0 ? wu0 : i === 1 ? wu1 : i === 2 ? wu2 : wu3;
      const wx = (x >>> 8) + (i & 1), wy = (y >>> 8) + ((i >> 1) & 1);
      const led = this.getPixelColorXY(wx, wy) & 0xffffff;
      const nl = RGBW32(qadd8(R(led), (R(c) * w) >> 8), qadd8(G(led), (G(c) * w) >> 8), qadd8(B(led), (B(c) * w) >> 8));
      if (nl !== led) this.setPixelColorXY(wx, wy, nl);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Globals seen by mode functions (live bindings, set by beginDraw)
// ---------------------------------------------------------------------------------------------

const NULL_SEGMENT = new Segment(1, 1);
export let SEGMENT: Segment = NULL_SEGMENT;
/** SEGENV is the same object as SEGMENT (runtime fields: step, call, aux0, aux1, data). */
export let SEGENV: Segment = NULL_SEGMENT;
export let SEGLEN = 1;
export let SEG_W = 1;
export let SEG_H = 1;
export let SEGPALETTE: Palette16 = NULL_SEGMENT.currentPalette;
/** SEGCOLOR(x): the segment's colour x (0..2), as uint32. */
export const SEGCOLOR = (i: number): number => SEGMENT.colors[i < NUM_COLORS ? i : 0]!;

/** The parts of WLED's `strip` object effects use. */
export const strip = {
  /** Effect time in ms (uint32), the same clock as millis(). */
  now: 0,
  /** true while a 2D effect is drawn (WLED: the setup is a matrix). */
  isMatrix: false,
  /** Master brightness: ours is applied after the effect, so effects see full brightness. */
  getBrightness: (): number => 255,
  getFrameTime: (): number => FRAMETIME,
  getSegmentsNum: (): number => 1,
  getActiveSegmentsNum: (): number => 1,
  getCurrSegmentId: (): number => 0,
  getMaxSegments: (): number => 1,
  getMainSegmentId: (): number => 0,
};

/** Make `seg` the current segment for the next mode-function call (Segment::beginDraw + strip state). */
export function beginDraw(seg: Segment, nowMs: number): void {
  SEGMENT = seg; SEGENV = seg;
  SEGLEN = seg.vLength(); SEG_W = seg.vWidth(); SEG_H = seg.vHeight();
  SEGPALETTE = seg.currentPalette;
  strip.now = nowMs >>> 0;
  strip.isMatrix = seg.is2D();
}

export { NOBLEND, LINEARBLEND, LINEARBLEND_NOWRAP };
