# Porting a WLED effect

Effects are ported **faithfully** from WLED v16.0.1 (`wled00/FX.cpp`), the version on the controller.
Same integer arithmetic, same overflow, same random calls in the same order. Don't "improve" anything.

## 1. Where things go

- One file per family in `effects/` (`basic.ts`, `twinkle.ts`, `fire.ts`, `waves.ts`, `twod.ts`, …),
  each exporting an array of `EffectDef`s built with `wledEffect()`.
- A new family file needs one import and one spread in `index.ts`. Nothing else to register.
- Every file with ported code starts with:

  ```ts
  // Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/FX.cpp. Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.
  ```

## 2. Registering

```ts
wledEffect({
  meta: 'Ripple@!,Wave #,Blur,,,,Overlay;,!;!;12;c1=0', // the _data_FX_MODE_* string, verbatim
  mode: mode_ripple,                                    // () => void, the ported function
  category: 'Waves & Patterns',
  description: 'Raindrops land at random and send coloured ripples spreading outwards.',
  // stateful: false, history: 1   // only for effects that depend on strip.now alone (see 5)
})
```

- `id` = `wled-<slug of name>`, `name`/`wled` = the WLED name; all derived from `meta`.
- Params come from `meta`: speed / intensity / custom1-2 (0..255), custom3 (0..31), check1-3 (booleans),
  color1-3 (WLED default colours `#ffa000`, black, black), `palette` (default from `pal=`, else
  `Default`), and for 1D effects the `mapping` select ("Lights run"). Defaults come from `sx= ix= c1= c2= c3= o1= o2= o3= pal=`.
- Flags containing `2` but not `1` make a 2D effect (64-wide grid, height from the house's aspect, 8..64).
  Everything else (`1`, `01`, `12`, empty) is 1D on a virtual strip of `map1D(...).length` pixels.
- Categories: `Basic`, `Chase & Running`, `Twinkle & Sparkle`, `Fire & Fireworks`, `Noise & Flow`,
  `Waves & Patterns`, `2D` (all 2D effects), `Particles` (FXparticleSystem effects).
- Descriptions: one plain-English line saying what you see, no jargon.
- Skip audio-reactive effects (flags with `v`/`f`, `getAudioData()`) unless told otherwise.

## 3. C → TypeScript

| C | TS |
|---|---|
| `SEGMENT.x`, `SEGENV.x` | unchanged: `import { SEGMENT, SEGENV } from '../segment.js'` (live bindings, same object) |
| `SEGLEN`, `SEG_W`, `SEG_H`, `SEGPALETTE` | unchanged identifiers, imported from `segment.js` |
| `SEGCOLOR(i)` | `SEGCOLOR(i)` |
| `strip.now`, `strip.isMatrix`, `strip.getBrightness()` | `strip.now` etc. from `segment.js` (brightness is always 255) |
| `millis()` | `millis()` from `math.js` (same clock as `strip.now`) |
| `FRAMETIME`, `FRAMETIME_FIXED` | `FRAMETIME` (25), `FRAMETIME_FIXED` (23) |
| `PALETTE_SOLID_WRAP` / `PALETTE_MOVING_WRAP` | `PALETTE_SOLID_WRAP` (false) / `PALETTE_MOVING_WRAP()` |
| `FX_FALLBACK_STATIC` | `{ SEGMENT.fill(SEGCOLOR(0)); return; }` |
| `uint32_t` colour, `CRGB`, `CRGBW` | `number` (0xWWRRGGBB). `R()/G()/B()/W()`, `RGBW32(r,g,b,w)`, `CRGB(r,g,b)` |
| `c.r` / `c.r = x` | `R(c)` / rebuild with `RGBW32(...)` |
| `CRGB leds[n]` | `new Uint32Array(n)` — allocate once (in SEGENV data or a module-level cache), not per frame |
| `CHSV(h,s,v)` → CRGB | `CHSV(h,s,v)`; `CHSV32(h16,s,v)`; `hsv2rgb_spectrum`, `rgb2hsv` |
| `crgb += x`, `nscale8`, `fadeToBlackBy` on CRGB | `crgbAdd`, `nscale8`, `nscale8_video`, `crgbFadeToBlackBy` |
| `ColorFromPalette(SEGPALETTE, i, bri, LINEARBLEND)` | same, from `palettes.js` |
| `setPixelColor(i, r, g, b)` | `setPixelColor(i, RGBW32(r, g, b))` (only the `(i, colour)` forms exist; same for add/blend/XY) |
| `random8/16`, `hw_random*`, `random(...)` | same names from `math.js`; same argument forms (`(), (max), (min, max)`) |
| `prng.random8()` | `new PRNG()` from `math.js` (keep a module-level instance like FX.cpp's `static PRNG prng`) |
| `beatsin8_t`, `sin8_t`, `perlin8`, `map`, `constrain`, `scale8`, `qadd8`… | same names in `math.js` |
| `sin_t`, `cos_t`, `atan2_t`, `sqrt32_bw` | same names (`sin_t` is WLED's `sin_approx`, float results via `Math.fround`) |

### SEGENV.data

`SEGENV.allocateData(n)` then:

- bytes: `SEGENV.data` (Uint8Array; zero-length until allocated — C `nullptr`).
- arrays of one type: `SEGENV.view(Uint16Array)` / `view(Float32Array)` … (cached, little-endian like
  the ESP32; length = floor(bytes / size)). `float` arrays in Float32Array round like C floats.
- structs: lay out the bytes exactly as GCC does (natural alignment, padding) and read fields through the
  views (`u8[i*4]`, `u16[i*2+1]`) or `SEGENV.dataView` with `littleEndian = true`. Write the struct layout
  in a comment. Bitfields: pack/unpack the bits by hand, in declaration order from bit 0.

### Integer semantics — reproduce them explicitly

JS numbers are doubles; C silently truncates. Every assignment to a narrower C type needs the mask:

- `uint8_t x = …` → `& 0xff`; `uint16_t` → `& 0xffff`; `int8_t` → `(v << 24) >> 24`; `int16_t` → `(v << 16) >> 16`.
- `uint32_t` → `>>> 0`; `int32_t` → `| 0`. A `uint32_t` product that can pass 2^32 must wrap: `Math.imul(a, b) >>> 0`
  (exact low 32 bits). A product that fits in 2^53 can be multiplied normally and then `>>> 0`.
- Integer division truncates toward zero: `Math.trunc(a / b)` (or `idiv`), never plain `/`. `>> n` on
  non-negative values is fine; on unsigned values above 2^31 use `>>> n`.
- `%` on negative ints matches C. `unsigned` subtraction that goes negative wraps: `(a - b) >>> 0`
  (e.g. `strip.now - SEGENV.step`).
- float → int conversion truncates: `Math.trunc`. `float` maths: wrap with `Math.fround` where rounding matters.
- Segment fields already carry their C widths: `step`/`call` uint32, `aux0`/`aux1` uint16, `custom3` 5-bit.
  `SEGENV.aux0++` wraps correctly. Struct fields in `data` wrap via the typed arrays.
- Pixel indices given as float in C are converted to int at the call (no AA pixels in default builds):
  setPixelColor truncates for you, but do the truncation yourself in arithmetic that uses the index.
- Colour equality (`col == cur`) compares all 32 bits; values from typed arrays and the colour helpers are
  always unsigned, so `===` works. Don't build colours with plain `|` (signed) — use `RGBW32` or `>>> 0`.

### TypeScript strictness

`noUncheckedIndexedAccess` is on: array reads need `!` (`heat[i]!`). That's expected; it costs nothing.

## 4. Rendering model

- 1D effects draw a virtual strip of `SEGLEN` pixels; each real light samples it at `round(pos*(SEGLEN-1))`
  according to the "Lights run" mapping. `is2D()` is false.
- 2D effects draw a `SEG_W × SEG_H` grid; row 0 is the TOP (as in WLED); each light samples the cell under it.
  `strip.isMatrix` and `is2D()` are true. 1D-on-2D mapping is always "Pixels".
- Palette ids in `SEGMENT.palette`: 0 Default, 1..71 WLED, ≥100 our own. `Default` resolves to the effect's
  `pal=` (or Party), and `color_from_palette(..., mcol<3)` returns `SEGCOLOR(mcol)` for it, exactly as WLED.
- `call` increments after every frame; frames are 25 ms apart (40 fps).

## 5. Determinism (hard rule)

The server and every browser preview render independently from a shared clock and must produce
identical frames. So:

- **Never** use `Math.random`, `Date.now`, `performance.now` or any other clock/RNG. Randomness only from
  `math.js` (`hw_random*`, `random*`, `PRNG`), time only from `strip.now` / `millis()`.
- No state outside SEGMENT/SEGENV that survives between frames (module-level caches of *constants* are fine;
  a module-level `PRNG` must be re-seeded from SEGENV state the way the C code does, or be part of SEGENV data).
- Default (`stateful` omitted): the effect is simulated frame by frame in 30 s windows, each starting 5 s
  early from a fresh segment and a seed derived from the window, so any frame can be recomputed from t.
  Tune with `stateful: { window, warmup }` (longer warm-up for effects that take long to fill in, e.g. Game
  of Life; keep `window + warmup` modest — a cold start simulates up to that many seconds).
- `stateful: false` for effects that depend only on time (they fully redraw every frame from `strip.now`):
  each frame starts from a reset segment and renders `history` frames first (default 1, so "previous
  iteration" checks against `SEGENV.step` still work). Use `history: 0` for pure functions of time.
- The catalogue test (`test/fx.test.ts`) checks range, determinism when started late, and < 4 ms/frame
  for 1100 px. Avoid per-frame allocations (`new`, array literals, closures in loops).

## 6. Known gaps / deviations

- No grouping, spacing, mirror, reverse, transpose, offset, transitions, segment blending or multiple
  segments; `nrOfVStrips()` is 1 (effects that draw "bars" via `m12=1` run as plain 1D strips).
- `strip.getBrightness()` is 255 (our master brightness is applied after the effect). Output gamma is
  applied by our engine (2.2, as WLED's default), so `/255` values map straight through.
- No audio: audio-reactive effects need a deterministic `simulateSound` port first (not done).
- No AA float `setPixelColor` (not compiled in default WLED builds).
- "* Random Cycle" is a function of time: new harmonic palette every 6 s, linear 750 ms blend (WLED
  blends with `nblendPaletteTowardPalette` and chains from the previous random palette).
- Particle-system effects (FXparticleSystem.*) need their own port of that library before porting.
- Palette names follow the controller's list by id; note WLED's list calls id 22 "Beach" and id 26
  "Beech" while palettes.cpp's comments say the opposite — we follow the ids, like the controller.
