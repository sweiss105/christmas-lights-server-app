import { describe, expect, it } from 'vitest';
import { decodePaint, encodePaint, type SceneConfig } from '@xmas/engine';
import { applyStroke, clearPaint, colorLook, dab, dabLine, paintedCount, paintLayerFor, retunePaint, sameLook, type Brush } from '../src/paint.js';
import { applyLook, lookOf } from '../src/editor.js';

// Five lights in a row on screen, 20 px apart; the last isn't placed.
const screen = new Float32Array([0, 0, 20, 0, 40, 0, 60, 0, NaN, NaN]);
const hard: Brush = { size: 10, softness: 0, strength: 1 };
const stroke = (...w: number[]) => Float32Array.from(w);
const weights = (scene: SceneConfig, id: string) => [...decodePaint(scene.layers.find((l) => l.id === id)!.paint!, 5)];
const base: SceneConfig = { name: 's', layers: [{ id: 'bg', effect: 'solid', params: { color: '#000010' } }] };
const red = { kind: 'look', look: colorLook('#ff0000') } as const;
const green = { kind: 'look', look: colorLook('#00ff00') } as const;

describe('the brush', () => {
  it('touches the lights inside its circle, skipping unplaced ones', () => {
    const s = new Float32Array(5);
    dab(screen, 20, 0, hard, s);
    expect([...s]).toEqual([0, 1, 0, 0, 0]);
  });

  it('fades towards a soft edge and is scaled by strength', () => {
    const s = new Float32Array(5);
    dab(screen, 20, 0, { size: 40, softness: 1, strength: 0.5 }, s);
    expect(s[1]).toBeCloseTo(0.5);  // centre
    expect(s[0]).toBeCloseTo(0.25); // halfway out
    expect(s[3]).toBe(0);           // at the rim
  });

  it('going over the same light twice in one stroke does not build up', () => {
    const s = new Float32Array(5);
    const soft = { size: 40, softness: 1, strength: 1 };
    dab(screen, 20, 0, soft, s); dab(screen, 20, 0, soft, s); dab(screen, 60, 0, soft, s);
    expect(s[1]).toBeCloseTo(1);
    expect(s[0]).toBeCloseTo(0.5);
  });

  it('a fast drag covers the lights between two pointer positions', () => {
    const s = new Float32Array(5);
    dabLine(screen, [-5, 0], [65, 0], hard, s);
    expect([...s]).toEqual([1, 1, 1, 1, 0]);
  });
});

describe('painting a scene', () => {
  it('the first stroke adds a painted layer on top; more strokes of the same paint add to it', () => {
    const a = applyStroke(base, red, stroke(1, 0.5, 0, 0, 0));
    expect(a.layers.map((l) => l.id)).toEqual(['bg', 'paint']);
    expect(a.layers[1]).toMatchObject({ effect: 'solid', params: { color: '#ff0000' } });
    expect(weights(a, 'paint')).toEqual([255, 128, 0, 0, 0]);
    const b = applyStroke(a, red, stroke(0, 0.5, 1, 0, 0));
    expect(b.layers).toHaveLength(2);
    expect(weights(b, 'paint')).toEqual([255, 192, 255, 0, 0]);
    expect(base.layers).toHaveLength(1); // inputs are never changed
    expect(weights(a, 'paint')).toEqual([255, 128, 0, 0, 0]);
  });

  it('a stroke that touches no light changes nothing', () => {
    expect(applyStroke(base, red, stroke(0, 0, 0, 0, 0))).toBe(base);
  });

  it('the newest stroke wins: painting an older paint again wipes newer paint off those lights', () => {
    let s = applyStroke(base, red, stroke(1, 1, 1, 0, 0));
    s = applyStroke(s, green, stroke(0, 1, 1, 1, 0));
    expect(s.layers.map((l) => l.id)).toEqual(['bg', 'paint', 'paint-2']);
    s = applyStroke(s, red, stroke(0, 0, 1, 0.5, 0));
    expect(weights(s, 'paint')).toEqual([255, 255, 255, 128, 0]);
    expect(weights(s, 'paint-2')).toEqual([0, 255, 0, 128, 0]);
    // Green over red leaves the red underneath alone (green covers it).
    s = applyStroke(s, green, stroke(1, 0, 0, 0, 0));
    expect(weights(s, 'paint')[0]).toBe(255);
  });

  it('erasing wipes every paint, removes paints left empty, and never touches ordinary layers', () => {
    let s = applyStroke(base, red, stroke(1, 1, 0, 0, 0));
    s = applyStroke(s, green, stroke(0, 0, 1, 0, 0));
    s = applyStroke(s, { kind: 'erase' }, stroke(0.5, 0, 1, 0, 0));
    expect(s.layers.map((l) => l.id)).toEqual(['bg', 'paint']);
    expect(weights(s, 'paint')).toEqual([128, 255, 0, 0, 0]);
    expect(s.layers[0]).toBe(base.layers[0]);
    expect(clearPaint(s).layers).toEqual(base.layers);
  });

  it('wiping leaves no traces too faint to see', () => {
    let s = applyStroke(base, red, stroke(1, 0, 0, 0, 0));
    s = applyStroke(s, green, stroke(1, 1, 0, 0, 0));
    s = applyStroke(s, red, stroke(0.99, 0.5, 0, 0, 0)); // red again, over the green
    expect(weights(s, 'paint-2')).toEqual([0, 128, 0, 0, 0]);
    s = applyStroke(s, red, stroke(0, 0.99, 0, 0, 0));
    expect(s.layers.map((l) => l.id)).toEqual(['bg', 'paint']);
  });

  it('never paints onto an ordinary layer that happens to look the same', () => {
    const plain: SceneConfig = { name: 's', layers: [{ id: 'solid', effect: 'solid', params: { color: '#ff0000' } }] };
    const s = applyStroke(plain, red, stroke(1, 0, 0, 0, 0));
    expect(s.layers.map((l) => l.id)).toEqual(['solid', 'paint']);
    expect(s.layers[0]!.paint).toBeUndefined();
  });

  it('matches paints by how they look, with defaults filled in', () => {
    expect(sameLook({ effect: 'solid' }, { effect: 'solid', params: { color: '#ff2a00' }, group: 'all', opacity: 1, blend: 'normal' })).toBe(true);
    expect(sameLook(colorLook('#ff0000'), colorLook('#ff0001'))).toBe(false);
    const s = applyStroke(base, red, stroke(1, 0, 0, 0, 0));
    expect(paintLayerFor(s, colorLook('#ff0000'))?.id).toBe('paint');
    expect(paintLayerFor(s, colorLook('#00ff00'))).toBeNull();
    expect(paintedCount(s.layers[1]!)).toBe(1);
  });

  it('retuning a brush changes the settings of what it painted', () => {
    const s = applyStroke(base, red, stroke(1, 0, 0, 0, 0));
    const t = retunePaint(s, colorLook('#ff0000'), colorLook('#ff00ff'));
    expect(t.layers[1]).toMatchObject({ params: { color: '#ff00ff' }, paint: s.layers[1]!.paint });
    expect(t.layers[0]).toBe(s.layers[0]);
  });

  it('presets leave the painting out, and applying one keeps it', () => {
    const s = applyStroke(base, red, stroke(1, 0, 0, 0, 0));
    expect('paint' in lookOf(s.layers[1]!)).toBe(false);
    const t = applyLook(s, 'paint', { name: 'P', effect: 'solid', params: { color: '#0000ff' } });
    expect(t.layers[1]).toMatchObject({ id: 'paint', params: { color: '#0000ff' }, paint: encodePaint(Uint8Array.from([255])) });
  });
});
