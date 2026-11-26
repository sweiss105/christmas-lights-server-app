import { describe, expect, it } from 'vitest';
import { buildLayout, Engine, EFFECTS, LayoutError, playlistPosition, type LayoutConfig } from '../src/index.js';

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

  /**
   * Effects that, faithfully to WLED, show a still pattern with their default settings. (Effects with
   * no pal= default start on Party here, so they move; WLED's "Default" palette would draw colour 1.)
   */
  const STATIC_BY_DEFAULT = new Set([
    'solid',
    'wled-solid-pattern', 'wled-solid-pattern-tri', 'wled-spots', // fixed patterns by design
    'wled-sunrise', // a 60-minute sunrise by default: dark for the first ~15 s
    'wled-slow-transition', // only moves when its colour changes
    'wled-pacman', // WLED falls back to solid colour on strips of 16 + 2×ghosts pixels or fewer (this layout has 15)
    'wled-squared-swirl', // a few sparse 2D dots that miss this nearly 1D layout; animates on a real 2D grid
  ]);

  it('runs every effect with defaults, producing finite values that change over time', () => {
    const e = new Engine(buildLayout(cfg()));
    for (const id of Object.keys(EFFECTS)) {
      e.setScene({ name: id, layers: [{ id: 'l', effect: id }] });
      const a = Buffer.from(e.render(0.0));
      expect(a.length).toBe(45);
      // Sparse effects (WLED's Ripple, a one-frame sparkle in Sparkle Dark) may change only briefly on a
      // 15-pixel layout, so look at every frame for 20 seconds rather than at a few moments (Traffic Light
      // holds red for 12.85 s at its default speed).
      let changed = false;
      for (let k = 1; k <= 800 && !changed; k++) changed = !a.equals(Buffer.from(e.render(k / 40)));
      if (!STATIC_BY_DEFAULT.has(id)) expect(changed, `${id} should animate`).toBe(true);
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

describe('crossfade between scenes', () => {
  const red = { name: 'Red', layers: [{ id: 'a', effect: 'solid', params: { color: '#ff0000' } }] };
  const blue = { name: 'Blue', layers: [{ id: 'b', effect: 'solid', params: { color: '#0000ff' } }] };
  const one = () => {
    const e = new Engine(buildLayout({ controllers: [{ id: 'c', name: 'C', host: 'x', pixelCount: 1 }], runs: [{ id: 'r', controller: 'c', start: 0, count: 1, points: [[0, 0, 0]] }] }));
    e.setOutput({ brightness: 1, gamma: 1 });
    return e;
  };

  it('fades from the old scene to the new one over the given time, starting at the next frame', () => {
    const e = one();
    e.setScene(red);
    e.render(10);
    e.setScene(blue, { fade: 2 });
    expect([...e.render(20)]).toEqual([255, 0, 0]); // the fade starts at the first frame after the change
    expect([...e.render(21)]).toEqual([128, 0, 128]); // halfway
    expect([...e.render(22)]).toEqual([0, 0, 255]);
    expect([...e.render(30)]).toEqual([0, 0, 255]);
  });

  it('cuts when no fade is given, and a new change mid-fade starts from the scene being faded to', () => {
    const e = one();
    e.setScene(red);
    e.setScene(blue);
    expect([...e.render(1)]).toEqual([0, 0, 255]);
    e.setScene(red, { fade: 1 });
    e.render(2);
    e.setScene(blue, { fade: 1 }); // interrupt: fade from red (the target) to blue
    expect([...e.render(3)]).toEqual([255, 0, 0]);
    expect([...e.render(3.5)]).toEqual([128, 0, 128]);
  });
});

describe('mask blend modes (an effect masking the layers below it)', () => {
  const two = () => {
    const e = new Engine(buildLayout({ controllers: [{ id: 'c', name: 'C', host: 'x', pixelCount: 2 }], runs: [{ id: 'r', controller: 'c', start: 0, count: 2, points: [[0, 0, 0], [1, 0, 0]] }], groups: { first: { pixels: [0] } } }));
    e.setOutput({ brightness: 1, gamma: 1 });
    return e;
  };
  const below = { id: 'below', effect: 'solid', params: { color: '#ff8000' } };

  it('mask shows the layers below where the mask layer is bright, by brightness not colour', () => {
    const e = two();
    // The mask is a solid colour on pixel 0 only (group "first"); pixel 1 sees no mask layer.
    e.setScene({ name: 'm', layers: [below, { id: 'm', effect: 'solid', params: { color: '#0000ff' }, blend: 'mask', group: 'first' }] });
    const f = [...e.render(0)];
    // Pure blue has brightness ~0.07 (Rec. 709 luma), so pixel 0 is mostly hidden, without a blue tint.
    expect(f[0]).toBeLessThan(30); expect(f[2]).toBe(0);
    expect(f.slice(3)).toEqual([255, 128, 0]); // outside the mask layer's group: untouched
    e.setScene({ name: 'w', layers: [below, { id: 'm', effect: 'solid', params: { color: '#ffffff' }, blend: 'mask' }] });
    expect([...e.render(0)].slice(0, 3)).toEqual([255, 128, 0]);
    e.setScene({ name: 'k', layers: [below, { id: 'm', effect: 'solid', params: { color: '#000000' }, blend: 'mask' }] });
    expect([...e.render(0)].slice(0, 3)).toEqual([0, 0, 0]);
  });

  it('inverted mask hides the layers below where the mask layer is bright; opacity weakens either mask', () => {
    const e = two();
    e.setScene({ name: 'i', layers: [below, { id: 'm', effect: 'solid', params: { color: '#ffffff' }, blend: 'mask-invert' }] });
    expect([...e.render(0)].slice(0, 3)).toEqual([0, 0, 0]);
    e.setScene({ name: 'h', layers: [below, { id: 'm', effect: 'solid', params: { color: '#000000' }, blend: 'mask', opacity: 0.5 }] });
    expect([...e.render(0)].slice(0, 3)).toEqual([128, 64, 0]);
  });
});

describe('clipping masks (mask only the layer directly below)', () => {
  const one = () => {
    const e = new Engine(buildLayout({ controllers: [{ id: 'c', name: 'C', host: 'x', pixelCount: 1 }], runs: [{ id: 'r', controller: 'c', start: 0, count: 1, points: [[0, 0, 0]] }] }));
    e.setOutput({ brightness: 1, gamma: 1 });
    return e;
  };
  const base = { id: 'base', effect: 'solid', params: { color: '#ff0000' } };
  const top = { id: 'top', effect: 'solid', params: { color: '#0000ff' } };

  it('a black clipping mask hides only the layer directly below it; the base stays', () => {
    const e = one();
    e.setScene({ name: 'c', layers: [base, top, { id: 'm', effect: 'solid', params: { color: '#000000' }, blend: 'mask', maskScope: 'layer' }] });
    expect([...e.render(0)]).toEqual([255, 0, 0]); // blue hidden, red base untouched
    e.setScene({ name: 'all', layers: [base, top, { id: 'm', effect: 'solid', params: { color: '#000000' }, blend: 'mask' }] });
    expect([...e.render(0)]).toEqual([0, 0, 0]); // default scope: everything below
  });

  it('a white clipping mask shows the layer below fully; inverted and opacity work as for normal masks', () => {
    const e = one();
    e.setScene({ name: 'w', layers: [base, top, { id: 'm', effect: 'solid', params: { color: '#ffffff' }, blend: 'mask', maskScope: 'layer' }] });
    expect([...e.render(0)]).toEqual([0, 0, 255]);
    e.setScene({ name: 'i', layers: [base, top, { id: 'm', effect: 'solid', params: { color: '#ffffff' }, blend: 'mask-invert', maskScope: 'layer' }] });
    expect([...e.render(0)]).toEqual([255, 0, 0]);
    e.setScene({ name: 'h', layers: [base, top, { id: 'm', effect: 'solid', params: { color: '#000000' }, blend: 'mask', maskScope: 'layer', opacity: 0.5 }] });
    expect([...e.render(0)]).toEqual([128, 0, 128]); // the blue layer at half strength over red
  });

  it('rejects an unknown mask scope', () => {
    expect(() => one().setScene({ name: 'x', layers: [base, { id: 'm', effect: 'solid', blend: 'mask', maskScope: 'nope' as 'layer' }] })).toThrow(/mask scope/);
  });
});

describe('feathered groups (soft-edged selections)', () => {
  // 11 pixels 0.1 m apart along x: pixel i is at x = i * 0.1.
  const cfg = (feather?: number): LayoutConfig => ({
    controllers: [{ id: 'c', name: 'C', host: 'x', pixelCount: 11 }],
    runs: [{ id: 'r', controller: 'c', start: 0, count: 11, points: [[0, 0, 0], [1, 0, 0]] }],
    groups: { sel: { pixels: [0, 1, 2], ...(feather !== undefined && { feather }) } },
  });

  it('a group without feather has hard edges, as before', () => {
    const l = buildLayout(cfg());
    expect([...l.groups.get('sel')!]).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(l.groupWeights.get('sel')).toBeUndefined();
  });

  it('feather fades the group out over the given distance in metres', () => {
    const l = buildLayout(cfg(0.4));
    const w = l.groupWeights.get('sel')!;
    expect(w[2]).toBe(1);
    expect(w[4]).toBeCloseTo(0.5, 5); // 0.2 m from the selection, half of 0.4 m
    expect(w[6]).toBe(0); // 0.4 m away: fully outside
    expect(w[3]!).toBeGreaterThan(w[4]!);
    expect([...l.groups.get('sel')!].slice(0, 7)).toEqual([1, 1, 1, 1, 1, 1, 0]); // pixels the fade touches count as members
  });

  it('the engine applies a feathered group as per-pixel opacity', () => {
    const e = new Engine(buildLayout(cfg(0.4)));
    e.setOutput({ brightness: 1, gamma: 1 });
    e.setScene({ name: 's', layers: [{ id: 'w', effect: 'solid', params: { color: '#ffffff' }, group: 'sel' }] });
    const f = e.render(0);
    expect(f[2 * 3]).toBe(255);
    expect(f[4 * 3]).toBe(128);
    expect(f[7 * 3]).toBe(0);
  });

  it('rejects a negative or huge feather', () => {
    expect(() => buildLayout(cfg(-1))).toThrow(/feather/);
    expect(() => buildLayout(cfg(100))).toThrow(/feather/);
  });
});

describe('playlist timing', () => {
  it('is exported by the engine, so the browser demo can play playlists', () => {
    expect(playlistPosition([{ scene: 'a', seconds: 10 }, { scene: 'b', seconds: 10 }], 0, 15_000, true).index).toBe(1);
  });
});
