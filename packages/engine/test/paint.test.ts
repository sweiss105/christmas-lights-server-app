import { describe, expect, it } from 'vitest';
import { buildLayout, decodePaint, EFFECTS, encodePaint, Engine, validateScene, type LayoutConfig } from '../src/index.js';

const cfg = (): LayoutConfig => ({
  controllers: [{ id: 'a', name: 'A', host: 'x', pixelCount: 8 }],
  runs: [{ id: 'r', controller: 'a', start: 0, count: 8, points: [[0, 0, 0], [7, 0, 0]] }],
  groups: { firstHalf: { pixels: [0, 1, 2, 3] } },
});
const paint = (...w: number[]) => encodePaint(Uint8Array.from(w));

describe('paint text', () => {
  it('round-trips every length and matches standard base64', () => {
    for (let n = 0; n < 40; n++) {
      const w = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 1) % 256 || 1);
      const text = encodePaint(w);
      expect(text).toBe(Buffer.from(w).toString('base64'));
      expect([...decodePaint(text)]).toEqual([...w]);
    }
  });

  it('drops trailing unpainted lights and fits any light count', () => {
    expect(paint(0, 9, 0, 0, 0)).toBe(paint(0, 9));
    expect(paint(0, 0, 0)).toBe('');
    expect([...decodePaint(paint(0, 9), 5)]).toEqual([0, 9, 0, 0, 0]);
    expect([...decodePaint(paint(1, 2, 3, 4), 2)]).toEqual([1, 2]);
  });

  it('rejects text that is not base64', () => {
    for (const bad of ['abc', 'a=bc', '!!!!', 'ab==cdef', 'é===']) expect(() => decodePaint(bad)).toThrow(/base64/);
  });
});

describe('painted layers', () => {
  const red = { id: 'red', effect: 'solid', params: { color: '#ff0000' } };

  it('shows only where painted, as strongly as painted', () => {
    const e = new Engine(buildLayout(cfg()));
    e.setOutput({ gamma: 1, brightness: 1 });
    e.setScene({ name: 's', layers: [{ ...red, paint: paint(255, 0, 128) }] });
    const f = e.render(0);
    expect([f[0], f[3], f[6], f[9]]).toEqual([255, 0, 128, 0]);
  });

  it('lets what is below show through unpainted and half-painted lights', () => {
    const e = new Engine(buildLayout(cfg()));
    e.setOutput({ gamma: 1, brightness: 1 });
    e.setScene({ name: 's', layers: [{ id: 'blue', effect: 'solid', params: { color: '#0000ff' } }, { ...red, paint: paint(255, 0, 128) }] });
    const f = e.render(0);
    expect([f[0], f[2]]).toEqual([255, 0]);   // fully painted: red
    expect([f[3], f[5]]).toEqual([0, 255]);   // unpainted: blue
    expect([f[6], f[8]]).toEqual([128, 127]); // half painted: a mix
  });

  it('stays inside the layer\'s group, and an empty painting shows nothing', () => {
    const e = new Engine(buildLayout(cfg()));
    e.setOutput({ gamma: 1, brightness: 1 });
    e.setScene({ name: 's', layers: [{ ...red, group: 'firstHalf', paint: paint(255, 255, 255, 255, 255, 255) }] });
    let f = e.render(0);
    expect([f[9], f[12]]).toEqual([255, 0]);
    e.setScene({ name: 's', layers: [{ ...red, paint: '' }] });
    f = e.render(0);
    expect(Math.max(...f)).toBe(0);
  });

  it('validation keeps paint, leaves unpainted layers alone and rejects bad paint', () => {
    const layout = buildLayout(cfg());
    const v = validateScene({ name: 's', layers: [{ ...red, paint: paint(1, 2) }, { ...red, id: 'b' }] }, layout);
    expect(v.layers[0]!.paint).toBe(paint(1, 2));
    expect('paint' in v.layers[1]!).toBe(false);
    expect(() => validateScene({ name: 's', layers: [{ ...red, paint: 'nope!' }] }, layout)).toThrow(/layer "red".*base64/);
    expect(() => validateScene({ name: 's', layers: [{ ...red, paint: 5 as unknown as string }] }, layout)).toThrow(/base64/);
  });

  it('painting more does not restart the effect, but changing its settings does', () => {
    const made: unknown[] = [];
    EFFECTS['test-count'] = { id: 'test-count', name: 'T', description: '', category: 'Basic', params: [{ key: 'v', label: 'v', type: 'number', min: 0, max: 9, default: 0 }],
      create: (p) => { made.push(p['v']); return (_t, out) => out.fill(1); } };
    try {
      const e = new Engine(buildLayout(cfg()));
      const layer = { id: 'x', effect: 'test-count', params: { v: 1 } };
      e.setScene({ name: 's', layers: [{ ...layer, paint: paint(255) }] });
      e.setScene({ name: 's', layers: [{ ...layer, paint: paint(255, 255) }] });
      e.setScene({ name: 's', layers: [{ ...layer, paint: paint(255, 255), opacity: 0.5 }] });
      expect(made).toEqual([1]);
      expect(e.render(0)[3]).toBeGreaterThan(0); // the new paint is in use
      e.setScene({ name: 's', layers: [{ ...layer, params: { v: 2 } }] });
      expect(made).toEqual([1, 2]);
      e.setScene({ name: 's', layers: [{ ...layer, params: { v: 2 } }] }, { fade: 1 }); // a crossfade gets its own
      expect(made).toEqual([1, 2, 2]);
    } finally { delete EFFECTS['test-count']; }
  });
});
