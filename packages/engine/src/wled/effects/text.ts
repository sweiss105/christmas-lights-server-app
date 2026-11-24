// Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/FX.cpp (mode_2Dscrollingtext) and wled00/src/dependencies/time/DateStrings.cpp (month and day names). Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.
//
// Scrolling Text. WLED takes the text from the segment name; here it is the effect's `text` param (put
// into SEGMENT.name by define.ts). Clock tokens (#TIME, #DATE, ...) and the empty-text clock read the
// wall clock injected with setWallClock(), never the system clock, so renders stay deterministic.

import type { EffectDef } from '../../effects.js';
import { BLACK } from '../color.js';
import { wledEffect } from '../define.js';
import { FontManager, utf8_decode, utf8_strlen, utf8Len } from '../fonts.js';
import { map } from '../math.js';
import { FRAMETIME, PALETTE_SOLID_WRAP, SEG_H, SEG_W, SEGCOLOR, SEGENV, SEGMENT, strip } from '../segment.js';

// ---- wall clock (WLED: localTime) -----------------------------------------------------------------

/** Christmas Eve 2026, 18:00:00 local time: the default so renders don't depend on when they run. */
const DEFAULT_WALL_CLOCK = new Date(2026, 11, 24, 18, 0, 0).getTime();
let wallClock: () => Date | number = () => DEFAULT_WALL_CLOCK;

/**
 * Where Scrolling Text's clock tokens and its empty-text clock get the time of day: a function returning a
 * Date or epoch milliseconds, read in the runtime's local time zone (WLED's `localTime`). Pass null to
 * restore the fixed default (2026-12-24 18:00:00 local), which keeps renders deterministic in tests.
 */
export function setWallClock(fn: (() => Date | number) | null): void {
  wallClock = fn ?? (() => DEFAULT_WALL_CLOCK);
  cacheKey = ''; // force the text to be rebuilt
}

/** WLED's useAMPM setting (default off: 24-hour clock). */
const useAMPM = false;

const scratchDate = new Date(0);
// the fields of localTime, refreshed when the wall clock moves to another second
let clockSecond = NaN;
let tYear = 0, tMonth = 1, tDay = 1, tWeekday = 1, tHour = 0, tMinute = 0, tSecond = 0;

function readClock(): void {
  const v = wallClock();
  const ms = typeof v === 'number' ? v : v.getTime();
  const sec = Math.floor(ms / 1000);
  if (sec === clockSecond) return;
  clockSecond = sec;
  const d = typeof v === 'number' ? (scratchDate.setTime(ms), scratchDate) : v;
  tYear = d.getFullYear(); tMonth = d.getMonth() + 1; tDay = d.getDate(); tWeekday = d.getDay() + 1;
  tHour = d.getHours(); tMinute = d.getMinutes(); tSecond = d.getSeconds();
}

// DateStrings.cpp
const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthShortNames = 'ErrJanFebMarAprMayJunJulAugSepOctNovDec';
const dayNames = ['Err', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayShortNames = 'ErrSunMonTueWedThuFriSat';
const monthStr = (m: number): string => monthNames[m]!;
const monthShortStr = (m: number): string => monthShortNames.slice(m * 3, m * 3 + 3);
const dayStr = (d: number): string => dayNames[d]!;
const dayShortStr = (d: number): string => dayShortNames.slice(d * 3, d * 3 + 3);

// printf helpers: %d, %2d, %02d, %04d
const d0 = (n: number): string => String(n);
const pad = (n: number, w: number, c: string): string => {
  const neg = n < 0, s = String(Math.abs(n));
  const body = neg ? '-' + s : s;
  return body.length >= w ? body : (c === '0' && neg ? '-' + s.padStart(w - 1, '0') : body.padStart(w, c));
};
const z2 = (n: number): string => pad(n, 2, '0');
const s2 = (n: number): string => pad(n, 2, ' ');

// ---- the text (C: char text[WLED_MAX_SEGNAME_LEN+1]) ---------------------------------------------------

const WLED_MAX_SEGNAME_LEN = 64;

/** UTF-8 bytes of a JS string (lone surrogates become U+FFFD, like TextEncoder). */
function utf8Encode(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00); i++; }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}

/** Segment::setName(): at most WLED_MAX_SEGNAME_LEN bytes (a cut may split a UTF-8 sequence, as in WLED). */
let nameSrc: string | null = null;
let nameBytes: number[] = [];
function segName(s: string): number[] {
  if (s !== nameSrc) { nameSrc = s; nameBytes = utf8Encode(s).slice(0, WLED_MAX_SEGNAME_LEN); }
  return nameBytes;
}

const text = new Uint8Array(WLED_MAX_SEGNAME_LEN + 1);
let textCacheNumbers = false;
let cacheKey = '';
const token = new Uint8Array(7);
const toupper = (c: number): number => (c >= 0x61 && c <= 0x7a ? c - 32 : c);
/** strncmp_P(token, pat, pat.length) == 0 */
function tokenIs(pat: string): boolean {
  for (let k = 0; k < pat.length; k++) if (token[k] !== pat.charCodeAt(k)) return false;
  return true;
}

/** Builds `text` from the segment name and the clock, exactly as mode_2Dscrollingtext does. */
function buildText(nameStr: string): void {
  const name = segName(nameStr);
  const len = name.length;
  const usesClock = len === 0 || name.includes(0x23);
  if (usesClock) readClock();
  const key = usesClock ? `${clockSecond}|${nameStr}` : `|${nameStr}`;
  if (key === cacheKey) return;
  cacheKey = key;

  text.fill(0);
  textCacheNumbers = false;
  let result_pos = 0;
  let AmPmHour = tHour;
  let isitAM = true;
  let sec: string;
  if (useAMPM) {
    if (AmPmHour > 11) { AmPmHour -= 12; isitAM = false; }
    if (AmPmHour === 0) AmPmHour = 12;
    sec = ' ' + (isitAM ? 'AM' : 'PM');
  } else {
    sec = ':' + z2(tSecond);
  }

  const put = (s: string): void => { for (let k = 0; k < s.length; k++) text[result_pos++] = s.charCodeAt(k); };

  if (len === 0) {
    // fallback if empty segment name: display date and time "#MON #DD #YYYY #TIME"
    put(`${monthShortStr(tMonth)} ${d0(tDay)}, ${d0(tYear)} ${d0(AmPmHour)}:${z2(tMinute)}${sec}`);
    textCacheNumbers = true;
  } else {
    let i = 0;
    while (i < len) {
      if (name[i] === 0x23) { // '#'
        let zero = false; // a 0 suffix means display leading zeros
        let j = 0;
        while (j < 6 && i + j < len) {
          token[j] = toupper(name[i + j]!);
          if (token[j] === 0x30) zero = true; // note: a '0' in trailing text counts too, as in WLED
          j++;
        }
        token[j] = 0;
        let advance = 5;
        let temp: string;
        if (tokenIs('#DATE')) temp = zero ? `${z2(tDay)}.${z2(tMonth)}.${pad(tYear, 4, '0')}` : `${d0(tDay)}.${d0(tMonth)}.${d0(tYear)}`;
        else if (tokenIs('#DDMM')) temp = zero ? `${z2(tDay)}.${z2(tMonth)}` : `${d0(tDay)}.${d0(tMonth)}`;
        else if (tokenIs('#MMDD')) temp = zero ? `${z2(tMonth)}/${z2(tDay)}` : `${d0(tMonth)}/${d0(tDay)}`;
        else if (tokenIs('#TIME')) temp = zero ? `${z2(AmPmHour)}:${z2(tMinute)}${sec}` : `${s2(AmPmHour)}:${z2(tMinute)}${sec}`;
        else if (tokenIs('#HHMM')) temp = zero ? `${z2(AmPmHour)}:${z2(tMinute)}` : `${d0(AmPmHour)}:${z2(tMinute)}`;
        else if (tokenIs('#YYYY')) temp = pad(tYear, 4, '0');
        else if (tokenIs('#MONL')) temp = monthStr(tMonth);
        else if (tokenIs('#DDDD')) temp = dayStr(tWeekday);
        else if (tokenIs('#YY')) { temp = z2(tYear % 100); advance = 3; }
        else if (tokenIs('#HH')) { temp = zero ? z2(AmPmHour) : d0(AmPmHour); advance = 3; }
        else if (tokenIs('#MM')) { temp = zero ? z2(tMinute) : d0(tMinute); advance = 3; }
        else if (tokenIs('#SS')) { temp = zero ? z2(tSecond) : d0(tSecond); advance = 3; }
        else if (tokenIs('#MON')) { temp = monthShortStr(tMonth); advance = 4; }
        else if (tokenIs('#MO')) { temp = zero ? z2(tMonth) : d0(tMonth); advance = 3; }
        else if (tokenIs('#DAY')) { temp = dayShortStr(tWeekday); advance = 4; }
        else if (tokenIs('#DD')) { temp = zero ? z2(tDay) : d0(tDay); advance = 3; }
        else { temp = '#'; zero = false; advance = 1; } // unknown token, just copy the #

        if (zero) advance++; // skip the '0' suffix
        if (result_pos + temp.length < WLED_MAX_SEGNAME_LEN) put(temp);
        textCacheNumbers = true; // cache all numbers when using clocks to avoid frequent re-caching
        i += advance;
      } else {
        if (result_pos < WLED_MAX_SEGNAME_LEN) text[result_pos++] = name[i++]!; // no token, just copy char
        else break; // buffer full
      }
    }
  }
}

// ---- the effect ---------------------------------------------------------------------------------------

const fontManager = new FontManager(SEGMENT);

/**
 * Not in WLED: when our simulation starts a fresh segment part-way through the show (see PORTING.md §5),
 * put the scroll position (aux0), colour shift (aux1) and next step time where an uninterrupted run since
 * t = 0 would have them, so the text doesn't jump back to the start every simulation window.
 * Steps happen on frames 1, 1+P, 1+2P, ... with P = floor(delay / FRAMETIME) + 1.
 */
function resumeScroll(totalTextWidth: number, cols: number): void {
  const k = Math.trunc(strip.now / FRAMETIME);
  const delay = map(SEGMENT.speed, 0, 255, 250, 50);
  const P = Math.trunc(delay / FRAMETIME) + 1;
  const n = k <= 1 ? 0 : Math.trunc((k - 2) / P) + 1; // steps taken before this frame
  if (n === 0) return;
  const L = totalTextWidth + cols;
  if (totalTextWidth > cols) SEGENV.aux0 = SEGMENT.check3 ? (L - (n % L)) % L : n % L;
  else SEGENV.aux0 = Math.trunc((cols + totalTextWidth) / 2);
  SEGENV.aux1 = n & 0xff;
  SEGENV.step = FRAMETIME * (1 + (n - 1) * P) + delay;
}

function mode_2Dscrollingtext(): void {
  if (!strip.isMatrix || !SEGMENT.is2D()) { SEGMENT.fill(SEGCOLOR(0)); return; } // not a 2D set-up
  fontManager.init(SEGMENT);
  const cols = SEG_W;
  const rows = SEG_H;

  // generate time/date if there are any # tokens or no segment name set
  buildText(SEGMENT.name);
  if (textCacheNumbers) fontManager.cacheNumbers(true);

  // Font selection
  const useCustomFont = SEGMENT.check2; // no filesystem: always falls back to the built-in font
  const fontNum = map(SEGMENT.custom2, 0, 255, 0, 4);

  // letters orientation: -2/+2 = upside down, -1 = 90° clockwise, 0 = normal, 1 = 90° counterclockwise
  const rotate = map(SEGMENT.custom3, 0, 31, -2, 2);
  const isRotated = rotate === 1 || rotate === -1;

  if (!fontManager.loadFont(fontNum, text, useCustomFont)) return;

  const fontHeight = fontManager.getFontHeight();
  const letterSpacing = isRotated ? 1 : fontManager.getFontSpacing();

  // Calculate total text width
  let totalTextWidth = 0;
  let idx = 0;
  const numberOfChars = utf8_strlen(text);
  for (let c = 0; c < numberOfChars; c++) {
    const unicode = utf8_decode(text, idx);
    idx += utf8Len;
    if (isRotated) totalTextWidth += fontHeight + letterSpacing;
    else totalTextWidth += fontManager.getGlyphWidth(unicode) + letterSpacing;
  }
  totalTextWidth -= letterSpacing; // remove spacing after last character

  // y-offset calculation
  let yoffset = map(SEGMENT.intensity, 0, 255, Math.trunc(-rows / 2), Math.trunc(rows / 2));

  if (totalTextWidth <= cols) {
    // if text fits matrix width, scroll vertically
    const speed = map(SEGMENT.speed, 0, 255, 5000, 1000);
    const frac = (strip.now % speed) + 1;
    if (SEGMENT.intensity === 255) yoffset = Math.trunc((2 * frac * rows) / speed) - rows;
    else if (SEGMENT.intensity === 0) yoffset = rows - Math.trunc((2 * frac * rows) / speed);
  }

  if (SEGENV.call === 0) resumeScroll(totalTextWidth, cols);

  // scroll step (AUX0 is current scrolling offset)
  if (SEGENV.step < strip.now) {
    if (totalTextWidth > cols) {
      if (SEGMENT.check3) { // reverse direction
        if (SEGENV.aux0 === 0) SEGENV.aux0 = totalTextWidth + cols - 1;
        else --SEGENV.aux0;
      } else {
        SEGENV.aux0 = ((SEGENV.aux0 + 1) & 0xffff) % (totalTextWidth + cols);
      }
    } else {
      SEGENV.aux0 = Math.trunc((cols + totalTextWidth) / 2); // text fits, position it at the center
    }
    SEGENV.aux1 = (SEGENV.aux1 + 1) & 0xff; // color shift
    SEGENV.step = strip.now + map(SEGMENT.speed, 0, 255, 250, 50);
  }

  SEGMENT.fade_out(255 - (SEGMENT.custom1 >> 4)); // trail
  let col1 = SEGMENT.color_from_palette(SEGENV.aux1, false, PALETTE_SOLID_WRAP, 0);
  let col2 = BLACK;

  // if gradient is selected and palette is default (0) drawCharacter() uses gradient from SEGCOLOR(0) to SEGCOLOR(2)
  // otherwise col2 == BLACK means use currently selected palette for gradient
  // if gradient is not selected set both colors the same
  if (SEGMENT.check1) {
    if (SEGMENT.palette === 0) { col1 = SEGCOLOR(0); col2 = SEGCOLOR(2); }
  } else col2 = col1;

  // Draw characters
  idx = 0;
  let currentXOffset = 0;
  for (let c = 0; c < numberOfChars; c++) {
    const unicode = utf8_decode(text, idx);
    idx += utf8Len;
    const unrotatedWidth = fontManager.getGlyphWidth(unicode);
    const glyphWidth = isRotated ? fontHeight : unrotatedWidth;
    const glyphHeight = isRotated ? unrotatedWidth : fontHeight;
    const drawX = cols - SEGENV.aux0 + currentXOffset; // no offset position is the right border (cols)
    if (drawX >= cols) break; // character is off-screen on the right
    const advance = glyphWidth + letterSpacing;
    if (drawX + advance < 0) { currentXOffset += advance; continue; } // off-screen on the left
    const drawY = ((yoffset + Math.trunc((rows - glyphHeight) / 2)) << 16) >> 16; // center glyph vertically (int16_t)
    fontManager.drawCharacter(unicode, drawX, drawY, col1, col2, rotate);
    currentXOffset += advance;
  }
}

export const TEXT: EffectDef[] = [
  wledEffect({
    meta: 'Scrolling Text@!,Y Offset,Trail,Font size,Rotate,Gradient,Custom Font,Reverse;!,!,Gradient;!;2;ix=128,c1=0,rev=0,mi=0,rY=0,mY=0',
    mode: mode_2Dscrollingtext,
    category: '2D',
    description: 'Scrolls a message across the house front in pixel letters; leave the text empty to show the date and time.',
    text: { default: 'Merry Christmas' },
  }),
];
