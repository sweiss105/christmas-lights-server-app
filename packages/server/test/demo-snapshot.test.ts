import { describe, expect, it } from 'vitest';
import { buildLayout, type Vec3 } from '@xmas/engine';
import { buildDemoSnapshot, bushZigzag, trunkHelix } from '../src/demoSnapshot.js';
import { fixtureShow, realExtras } from './demo-fixture.js';

/** World positions of one group's lights (a run is the group `run:<id>`) in a built layout. */
function groupPixels(snap: ReturnType<typeof buildDemoSnapshot>, group: string): Vec3[] {
  const layout = buildLayout(snap.layout);
  const mask = layout.groups.get(group)!;
  const out: Vec3[] = [];
  for (let i = 0; i < layout.count; i++) if (mask[i]) out.push([layout.positions[i * 3]!, layout.positions[i * 3 + 1]!, layout.positions[i * 3 + 2]!]);
  return out;
}

/** Distance from p to the segment a-b. */
function toSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l2 = d[0]! ** 2 + d[1]! ** 2 + d[2]! ** 2;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0]! + (p[1] - a[1]) * d[1]! + (p[2] - a[2]) * d[2]!) / l2));
  return Math.hypot(p[0] - (a[0] + d[0]! * t), p[1] - (a[1] + d[1]! * t), p[2] - (a[2] + d[2]! * t));
}

describe('demo snapshot', () => {
  const snap = buildDemoSnapshot(fixtureShow(), realExtras());

  it('leaves out every private detail and unknown field', () => {
    const text = JSON.stringify(snap);
    for (const s of ['10.30.1.40', 'latitude', 'longitude', 'futureThing', 'house-part2.glb', 'scheduleInWindow', 'lastScene', 'schedule', 'playing']) expect(text).not.toContain(s);
  });

  it('points every controller nowhere and adds the demo controller for the extra strings', () => {
    expect(snap.layout.controllers.every((c) => c.host === 'demo.invalid')).toBe(true);
    expect(snap.layout.controllers.find((c) => c.id === 'demo')?.pixelCount).toBe(1300);
  });

  it('copies scenes, playlists, presets and palettes as they are', () => {
    const show = fixtureShow();
    expect(snap.scenes).toEqual(show.scenes);
    expect(snap.playlists).toEqual(show.playlists);
    expect(snap.presets).toEqual(show.presets);
    expect(snap.palettes).toEqual(show.palettes);
  });

  it('widens the porch group over the extra strings and keeps the real one as porch-real', () => {
    expect(snap.layout.groups!.porch!.runs).toEqual(expect.arrayContaining(['porch-left', 'porch-right', 'mailbox-post', 'mailbox-box', 'stair-rail', 'bush-a', 'bush-b', 'bush-c', 'bush-d', 'tree-trunk']));
    expect(snap.layout.groups!['porch-real']!.runs).toEqual(['porch-left', 'porch-right']);
    expect(Object.keys(snap.layout.groups!)).toEqual(expect.arrayContaining(['mailbox', 'stair-rail', 'bushes', 'tree', 'demo-extras']));
  });

  it('builds a valid layout with the real lights plus 1300 demo lights', () => {
    expect(buildLayout(snap.layout).count).toBe(1101 + 1300);
  });

  it('opens on the stored stage, or nothing when the porch is blacked out', () => {
    expect(snap.activeScene).toBe('Red');
    expect(snap.stage).toEqual(fixtureShow().stage);
    const dark = buildDemoSnapshot({ ...fixtureShow(), activeScene: null }, realExtras());
    expect(dark.activeScene).toBeNull();
    expect(dark.stage).toBeNull();
  });

  it('publishes only brightness, gamma and transition of the output', () => {
    expect(Object.keys(snap.output).sort()).toEqual(['brightness', 'gamma', 'transition']);
  });

  it('publishes the house without file names', () => {
    expect(snap.house!.parts).toEqual([{ id: 'part2', name: 'House', bytes: 16, uploadedAt: '2026-11-24T21:38:40.783Z', position: [0, 0, 0], rotation: 0, scale: 1, visible: true }]);
  });

  it('puts the mailbox lights round the mailbox post and box', () => {
    const px = groupPixels(snap, 'mailbox');
    expect(px.length).toBe(150);
    for (const p of px) {
      expect(Math.abs(p[0] - 2.485)).toBeLessThan(0.2);
      expect(p[2]).toBeGreaterThan(2.29 - 0.2);
      expect(p[2]).toBeLessThan(2.86 + 0.2);
      expect(p[1]).toBeGreaterThan(-0.3);
      expect(p[1]).toBeLessThan(1.3);
    }
  });

  it('winds the stair-rail lights round the handrail', () => {
    const px = groupPixels(snap, 'run:stair-rail');
    expect(px.length).toBe(250);
    for (const p of px) expect(toSegment(p, [2.26, 0.77, 3.3], [2.26, -0.66, 6.05])).toBeLessThan(0.06);
  });

  it('drapes the bush lights over the bush', () => {
    const px = groupPixels(snap, 'run:bush-d');
    expect(px.length).toBe(200);
    const min = [-0.98 - 0.05, -0.1 - 0.05, -0.02 - 0.05], max = [0.83 + 0.05, 1.44 + 0.05, 1.3 + 0.05];
    for (const p of px) for (let k = 0; k < 3; k++) { expect(p[k]).toBeGreaterThanOrEqual(min[k]!); expect(p[k]).toBeLessThanOrEqual(max[k]!); }
  });

  it('lights the middle of the front of both big bushes by the porch, not just their ends', () => {
    // The scan's front row: big bushes at x -3.62..-1.85 and -0.98..0.83, both with their front at z 1.3, a smaller one between.
    const lights = [...groupPixels(snap, 'bushes')];
    for (const [from, to] of [[-3.0, -2.45], [-0.35, 0.2]] as const) {
      const front = lights.filter((p) => p[0] > from && p[0] < to && p[2] > 1.25 && p[1] > 0.3 && p[1] < 1.3);
      expect(front.length, `front of the bush between x ${from} and ${to}`).toBeGreaterThanOrEqual(8);
    }
  });

  it('runs the bush lights up and down the bush in a zig-zag, many times across its front', () => {
    const px = groupPixels(snap, 'run:bush-d');
    const mid = (-0.1 + 1.44) / 2;
    // Every time the string passes half height it's going up or down; count the passes on the front half.
    let passes = 0, front = 0;
    for (let i = 1; i < px.length; i++) {
      if ((px[i - 1]![1] < mid) !== (px[i]![1] < mid)) { passes++; if (px[i]![2] > (-0.02 + 1.3) / 2 + 0.3) front++; }
    }
    expect(passes).toBeGreaterThanOrEqual(14);
    expect(front).toBeGreaterThanOrEqual(5);
  });

  it('coils the tree-trunk lights round the trunk from the ground up to where the branches start', () => {
    const px = groupPixels(snap, 'run:tree-trunk');
    expect(px.length).toBe(300);
    // The trunk as scanned: centre and radius at a few heights (it flares at the ground and leans a little).
    const rings: [number, number, number, number][] = [[-4.827, 0, 2.52, 0.44], [-4.827, 0.38, 2.52, 0.33], [-4.808, 0.63, 2.56, 0.265], [-4.868, 1.43, 2.54, 0.24], [-4.968, 2.93, 2.48, 0.23], [-4.99, 3.3, 2.47, 0.23]];
    const ringAt = (y: number) => {
      let i = 1;
      while (i < rings.length - 1 && rings[i]![1] < y) i++;
      const a = rings[i - 1]!, b = rings[i]!, f = Math.max(0, Math.min(1, (y - a[1]) / (b[1] - a[1])));
      return a.map((v, k) => v + (b[k]! - v) * f);
    };
    for (const p of px) {
      const [x, , z, r] = ringAt(p[1]);
      expect(Math.abs(Math.hypot(p[0] - x!, p[2] - z!) - r!)).toBeLessThan(0.08);
    }
    const ys = px.map((p) => p[1]);
    expect(Math.min(...ys)).toBeLessThan(0.15);
    expect(Math.max(...ys)).toBeGreaterThan(3.1);
    expect(Math.max(...ys)).toBeLessThan(3.4);
  });

  it('keeps the bush lights near the outside of the bush (its scan is a rounded box), not buried in it', () => {
    const px = groupPixels(snap, 'run:bush-d');
    const min = [-0.98, -0.1, -0.02], max = [0.83, 1.44, 1.3];
    // Distance in from the nearest side or the top (the bottom is the ground).
    const depth = (p: Vec3) => Math.min(p[0] - min[0]!, max[0]! - p[0], p[2] - min[2]!, max[2]! - p[2], max[1]! - p[1]);
    const near = px.filter((p) => depth(p) < 0.15).length;
    expect(near / px.length).toBeGreaterThan(0.8);
  });

  it('publishes only known fields of controllers, runs, groups and house parts, so a private field added later stays out', () => {
    const show = fixtureShow();
    Object.assign(show.layout.controllers[0]!, { password: 'hunter2' });
    Object.assign(show.layout.runs[0]!, { secretNote: 'hunter2' });
    Object.assign(show.layout.groups!.porch!, { owner: 'hunter2' });
    Object.assign(show.house!.parts![0]!, { scannedAt: 'hunter2' });
    const text = JSON.stringify(buildDemoSnapshot(show, realExtras()));
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('fallbackPreset');
    expect(buildDemoSnapshot(show, realExtras()).layout.runs[1]!.coil).toEqual({ radius: 0.045, pitch: 0.27, skip: [3] });
  });

  it('refuses extras that break the layout', () => {
    const extras = realExtras();
    extras.runs[0] = { ...extras.runs[0]!, coil: { radius: 2, pitch: 0.1 } }; // wider than any coil can be
    expect(() => buildDemoSnapshot(fixtureShow(), extras)).toThrow();
  });
});

describe('bushZigzag', () => {
  const min: Vec3 = [0, 0, 0], max: Vec3 = [2, 1.5, 1.2];

  it('gives the same path every time, inside the bush with the lights just outside its surface', () => {
    const path = bushZigzag(min, max);
    expect(bushZigzag(min, max)).toEqual(path);
    for (const p of path) {
      for (let k = 0; k < 3; k++) { expect(p[k]).toBeGreaterThanOrEqual(min[k]! - 0.05); expect(p[k]).toBeLessThanOrEqual(max[k]! + 0.05); }
    }
  });

  it('goes up and down, from near the ground to the top, again and again', () => {
    const path = bushZigzag(min, max);
    const lows = path.filter((p) => p[1] < 0.2).length, highs = path.filter((p) => p[1] > 1.35).length;
    expect(lows).toBeGreaterThan(10);
    expect(highs).toBeGreaterThan(10);
  });
});

describe('trunkHelix', () => {
  it('winds round the trunk once per pitch of height, the same every time', () => {
    const rings: [number, number, number, number][] = [[0, 0, 0, 0.3], [0, 2, 0, 0.2]];
    const path = trunkHelix(rings, 0.2);
    expect(trunkHelix(rings, 0.2)).toEqual(path);
    let turns = 0;
    for (let i = 1; i < path.length; i++) {
      let d = Math.atan2(path[i]![2], path[i]![0]) - Math.atan2(path[i - 1]![2], path[i - 1]![0]);
      if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
      turns += d / (2 * Math.PI);
    }
    expect(Math.abs(turns)).toBeCloseTo(10, 0);
    expect(path[0]![1]).toBeCloseTo(0);
    expect(path[path.length - 1]![1]).toBeCloseTo(2);
  });
});
