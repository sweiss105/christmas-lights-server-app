import { describe, expect, it } from 'vitest';
import { buildLayout, Engine, EFFECTS, LayoutError, type LayoutConfig } from '../src/index.js';

const cfg = (): LayoutConfig => ({
  controllers: [
    { id: 'a', name: 'A', host: '10.0.0.2', pixelCount: 10 },
    { id: 'b', name: 'B', host: '10.0.0.3', pixelCount: 5 },
  ],
  runs: [
    { id: 'roof', controller: 'a', start: 0, count: 10, points: [[0, 0, 0], [9, 0, 0]] },
    { id: 'door', controller: 'b', start: 1, count: 3, points: [[0, 0, 0], [0, 2, 0]] },
  ],
  groups: { doorOnly: { runs: ['door'] } },
});

describe('layout', () => {
  it('assigns global indices controller by controller and spaces pixels along polylines', () => {
    const l = buildLayout(cfg());
    expect(l.count).toBe(15);
    expect(l.controllerOffset.get('b')).toBe(10);
    expect([...l.positions.slice(9 * 3, 9 * 3 + 3)]).toEqual([9, 0, 0]);
    expect([...l.positions.slice(12 * 3, 12 * 3 + 3)]).toEqual([0, 1, 0]);
    expect(l.mapped[10]).toBe(0);
    expect(l.mapped[11]).toBe(1);
    expect(Number.isNaN(l.positions[10 * 3])).toBe(true);
  });

  it('follows multi-segment polylines by arc length', () => {
    const l = buildLayout({
      controllers: [{ id: 'a', name: 'A', host: 'x', pixelCount: 5 }],
      runs: [{ id: 'r', controller: 'a', start: 0, count: 5, points: [[0, 0, 0], [2, 0, 0], [2, 2, 0]] }],
    });
    expect([...l.positions.slice(6, 9)]).toEqual([2, 0, 0]);
    expect([...l.positions.slice(9, 12)]).toEqual([2, 1, 0]);
  });

  it('builds group, run and "all" masks', () => {
    const l = buildLayout(cfg());
    expect([...l.groups.get('doorOnly')!].reduce((a, b) => a + b)).toBe(3);
    expect(l.groups.get('run:roof')![0]).toBe(1);
    expect(l.groups.get('all')!.length).toBe(15);
  });

  it('rejects overlapping runs and out-of-range runs', () => {
    const c = cfg();
    c.runs.push({ id: 'dup', controller: 'a', start: 5, count: 2, points: [[0, 0, 0]] });
    expect(() => buildLayout(c)).toThrow(LayoutError);
    const d = cfg();
    d.runs[1]!.count = 10;
    expect(() => buildLayout(d)).toThrow(/exceeds/);
  });
});

describe('engine', () => {
  it('renders solid colour with gamma and leaves unmapped pixels dark', () => {
    const e = new Engine(buildLayout(cfg()));
    e.setOutput({ gamma: 1 });
    e.setScene({ name: 's', layers: [{ id: 'l', effect: 'solid', params: { color: '#ff8000' } }] });
    const f = e.render(0);
    expect([...f.slice(0, 3)]).toEqual([255, 128, 0]);
    expect([...f.slice(30, 33)]).toEqual([0, 0, 0]); // pixel 10 is unmapped
  });

  it('applies brightness and gamma', () => {
    const e = new Engine(buildLayout(cfg()));
    e.setOutput({ brightness: 0.5, gamma: 2 });
    e.setScene({ name: 's', layers: [{ id: 'l', effect: 'solid', params: { color: '#ffffff' } }] });
    expect(e.render(0)[0]).toBe(64);
  });

  it('masks layers to groups and blends by opacity', () => {
    const e = new Engine(buildLayout(cfg()));
    e.setOutput({ gamma: 1 });
    e.setScene({
      name: 's',
      layers: [
        { id: 'base', effect: 'solid', params: { color: '#0000ff' } },
        { id: 'door', effect: 'solid', params: { color: '#ff0000' }, group: 'doorOnly', opacity: 0.5 },
      ],
    });
    const f = e.render(0);
    expect([...f.slice(0, 3)]).toEqual([0, 0, 255]);
    expect([...f.slice(11 * 3, 11 * 3 + 3)]).toEqual([128, 0, 128]);
  });

  it('rejects bad scenes without changing the running one', () => {
    const e = new Engine(buildLayout(cfg()));
    e.setScene({ name: 'ok', layers: [{ id: 'l', effect: 'solid' }] });
    expect(() => e.setScene({ name: 'bad', layers: [{ id: 'l', effect: 'nope' }] })).toThrow(/unknown effect/);
    expect(() => e.setScene({ name: 'bad', layers: [{ id: 'l', effect: 'solid', group: 'ghost' }] })).toThrow(/unknown group/);
    expect(() => e.setScene({ name: 'bad', layers: [{ id: 'l', effect: 'solid', params: { color: 'red' } }] })).toThrow(/invalid color/);
    expect(e.scene.name).toBe('ok');
  });

  it('runs every effect with defaults, producing finite values that change over time', () => {
    const e = new Engine(buildLayout(cfg()));
    for (const id of Object.keys(EFFECTS)) {
      e.setScene({ name: id, layers: [{ id: 'l', effect: id }] });
      const a = Buffer.from(e.render(0.0));
      expect(a.length).toBe(45);
      // Sparse effects (e.g. WLED's Ripple on a 15-pixel layout) may stay dark for a while, so look at a few times.
      const later = [1.7, 4.3, 9.1].map((t) => Buffer.from(e.render(t)));
      if (id !== 'solid') expect(later.some((b) => !a.equals(b)), `${id} should animate`).toBe(true);
    }
  });

  it('renders 2900 pixels with 4 layers well inside a 25 ms frame', () => {
    const per = 1450;
    const layout = buildLayout({
      controllers: [{ id: 'a', name: 'A', host: 'x', pixelCount: per }, { id: 'b', name: 'B', host: 'y', pixelCount: per }],
      runs: [
        { id: 'r1', controller: 'a', start: 0, count: per, points: [[0, 0, 0], [15, 0, 0], [15, 6, 0]] },
        { id: 'r2', controller: 'b', start: 0, count: per, points: [[0, 6, 0], [0, 0, 3]] },
      ],
    });
    const e = new Engine(layout);
    e.setScene({ name: 'heavy', layers: ['noise', 'twinkle', 'stripes', 'ripple'].map((effect, i) => ({ id: `l${i}`, effect, blend: 'screen' as const })) });
    for (let i = 0; i < 20; i++) e.render(i / 40);
    const t0 = performance.now();
    const frames = 200;
    for (let i = 0; i < frames; i++) e.render(i / 40);
    const ms = (performance.now() - t0) / frames;
    expect(ms).toBeLessThan(8);
  });
});
