import { describe, expect, it } from 'vitest';
import { buildLayout, builtinPaletteStops, checkPaletteStops, EFFECTS, PALETTE_NAMES, paletteColors, paletteStopsFor, resolveParams, WLED_PALETTE_NAMES, type PaletteStop } from '../src/index.js';
import { CUSTOM_STOPS_ID, layerPaletteId, loadGradientPalette, loadPalette, resolvePaletteId } from '../src/wled/palettes.js';
import { stopsToGradient } from '../src/wled/stops.js';

const layout = buildLayout({
  controllers: [{ id: 'a', name: 'A', host: 'x', pixelCount: 120 }],
  runs: [{ id: 'roof', controller: 'a', start: 0, count: 120, points: [[0, 3, 0], [12, 3, 0]] }],
});

/** Render the WLED "Palette" effect (it draws the palette across the lights) and sum each channel. */
function render(params: Record<string, unknown>): { r: number; g: number; b: number } {
  const fx = EFFECTS['wled-palette']!;
  const out = new Float32Array(layout.count * 3);
  fx.create(resolveParams(fx, params), layout)(1, out);
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < layout.count; i++) { r += out[i * 3]!; g += out[i * 3 + 1]!; b += out[i * 3 + 2]!; }
  return { r, g, b };
}

const RED: PaletteStop[] = [[0, '#ff0000'], [255, '#ff0000']];

describe('editable palettes', () => {
  it("a built-in palette's stops build back into exactly the same palette", () => {
    const a = new Uint32Array(16), b = new Uint32Array(16);
    for (const name of PALETTE_NAMES) {
      const stops = builtinPaletteStops(name);
      const id = resolvePaletteId(name);
      if (id < 6) { expect(stops, name).toBeNull(); continue; } // Default, Random Cycle, "* Color…"
      expect(() => checkPaletteStops(stops), name).not.toThrow();
      if (id >= 100) continue; // our own palettes are sampled, not stop-for-stop; checked below
      loadPalette(a, id, 6, [0, 0, 0]);
      loadGradientPalette(b, stopsToGradient(stops!));
      expect(Array.from(b), name).toEqual(Array.from(a));
    }
    expect(builtinPaletteStops('Party')).toHaveLength(16);
    expect(builtinPaletteStops('Sunset')).toEqual([[0, '#b50000'], [22, '#da5500'], [51, '#ffaa00'], [85, '#d3554d'], [135, '#a700a9'], [198, '#4900bc'], [255, '#0000cf']]);
    expect(builtinPaletteStops('Candy Cane')!.map((s) => s[1])).toEqual(['#ff0000', '#ff0000', '#ffffff', '#ffffff']);
  });

  it('an edited palette renders the edited colours, and the original is unchanged', () => {
    const before = render({ palette: 'Party' });
    expect(before.b).toBeGreaterThan(before.g); // Party is mostly purple and orange

    const edited = render({ palette: 'Party (edited)', paletteStops: RED });
    expect(edited.r).toBeGreaterThan(50);
    expect(edited.g + edited.b).toBe(0);

    // Changing one colour of Party: entry 15 (blue) → green; the rest stay as they were.
    const stops = builtinPaletteStops('Party')!.map((s, i): PaletteStop => (i === 15 ? [s[0], '#00ff00'] : s));
    const sw = paletteColors('Party (edited)', { paletteStops: stops }, 16);
    const orig = paletteColors('Party', {}, 16);
    expect(sw.slice(0, 14)).toEqual(orig.slice(0, 14)); // samples 0..13 sit between unchanged entries
    expect(parseInt(sw[14]!.slice(3, 5), 16)).toBeGreaterThan(parseInt(orig[14]!.slice(3, 5), 16) + 60); // greener towards entry 15

    // The built-in Party is untouched, and a built-in name ignores stale stops.
    expect(render({ palette: 'Party' })).toEqual(before);
    expect(render({ palette: 'Party', paletteStops: RED })).toEqual(before);
    expect(builtinPaletteStops('Party')![15]![1]).toBe('#0032fc');
  });

  it('a saved palette resolves by name and renders from its stops', () => {
    const saved = { 'Candy Red': { name: 'Candy Red', stops: RED } };
    expect(paletteStopsFor('Candy Red', {}, saved)).toEqual(RED);
    expect(paletteStopsFor('Nope', {}, saved)).toBeNull();
    expect(paletteStopsFor('Fire', {}, saved)).toEqual(builtinPaletteStops('Fire'));
    // The layer's own copy wins over the library (a deleted or changed saved palette leaves the layer as it was).
    const blue: PaletteStop[] = [[0, '#0000ff'], [255, '#0000ff']];
    expect(paletteStopsFor('Candy Red', { paletteStops: blue }, saved)).toEqual(blue);
    const out = render({ palette: 'Candy Red', paletteStops: paletteStopsFor('Candy Red', {}, saved) });
    expect(out.g + out.b).toBe(0);
    expect(out.r).toBeGreaterThan(50);
  });

  it('palette ids: built-in names, own stops, unknown names', () => {
    expect(layerPaletteId('Fire', { paletteStops: RED })).toBe(35);
    expect(layerPaletteId('Mine', { paletteStops: RED })).toBe(CUSTOM_STOPS_ID);
    expect(layerPaletteId('Mine', {})).toBe(0);
    expect(WLED_PALETTE_NAMES.length).toBeLessThan(CUSTOM_STOPS_ID);
  });

  it('checks stops: 2..18, positions 0..255 in order from 0 to 255, hex colours', () => {
    expect(checkPaletteStops([[0, '#FF0000'], [128, '#00ff00'], [255, '#0000ff']])[0]).toEqual([0, '#ff0000']);
    for (const bad of [[], [[0, '#ff0000']], [[0, '#ff0000'], [200, '#00ff00']], [[10, '#ff0000'], [255, '#00ff00']],
      [[0, '#ff0000'], [200, '#00ff00'], [100, '#00ff00'], [255, '#000000']], [[0, 'red'], [255, '#000000']], [[0.5, '#ff0000'], [255, '#000000']],
      Array.from({ length: 19 }, (_, i) => [i === 18 ? 255 : i, '#000000']), 'nope']) {
      expect(() => checkPaletteStops(bad), JSON.stringify(bad)).toThrow();
    }
    const fx = EFFECTS['wled-palette']!;
    expect(() => resolveParams(fx, { paletteStops: [[0, 'red']] })).toThrow(/paletteStops/);
    expect(resolveParams(fx, { paletteStops: null })).not.toHaveProperty('paletteStops');
    expect(resolveParams(fx, {})).not.toHaveProperty('paletteStops');
  });
});
