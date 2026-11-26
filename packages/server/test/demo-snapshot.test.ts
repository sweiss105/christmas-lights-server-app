import { describe, expect, it } from 'vitest';
import { buildLayout, type Vec3 } from '@xmas/engine';
import { buildDemoSnapshot, domePositions } from '../src/demoSnapshot.js';
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
    expect(snap.layout.controllers.find((c) => c.id === 'demo')?.pixelCount).toBe(900);
  });

  it('copies scenes, playlists, presets and palettes as they are', () => {
    const show = fixtureShow();
    expect(snap.scenes).toEqual(show.scenes);
    expect(snap.playlists).toEqual(show.playlists);
    expect(snap.presets).toEqual(show.presets);
    expect(snap.palettes).toEqual(show.palettes);
  });

  it('widens the porch group over the extra strings and keeps the real one as porch-real', () => {
    expect(snap.layout.groups!.porch!.runs).toEqual(expect.arrayContaining(['porch-left', 'porch-right', 'mailbox-post', 'mailbox-box', 'stair-rail', 'bush-a', 'bush-b', 'bush-c', 'bush-d']));
    expect(snap.layout.groups!['porch-real']!.runs).toEqual(['porch-left', 'porch-right']);
    expect(Object.keys(snap.layout.groups!)).toEqual(expect.arrayContaining(['mailbox', 'stair-rail', 'bushes', 'demo-extras']));
  });

  it('builds a valid layout with the real lights plus 900 demo lights', () => {
    expect(buildLayout(snap.layout).count).toBe(1101 + 900);
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
    const px = groupPixels(snap, 'run:bush-c');
    expect(px.length).toBe(200);
    const min = [-2.4 - 0.05, -0.1 - 0.05, -0.02 - 0.05], max = [-0.38 + 0.05, 1.54 + 0.05, 1.32 + 0.05];
    for (const p of px) for (let k = 0; k < 3; k++) { expect(p[k]).toBeGreaterThanOrEqual(min[k]!); expect(p[k]).toBeLessThanOrEqual(max[k]!); }
  });

  it('keeps the bush lights near the outside of the bush (its scan is a rounded box), not buried in it', () => {
    const px = groupPixels(snap, 'run:bush-c');
    const min = [-2.4, -0.1, -0.02], max = [-0.38, 1.54, 1.32];
    // Distance in from the nearest side or the top (the bottom is the ground).
    const depth = (p: Vec3) => Math.min(p[0] - min[0]!, max[0]! - p[0], p[2] - min[2]!, max[2]! - p[2], max[1]! - p[1]);
    const near = px.filter((p) => depth(p) < 0.15).length;
    expect(near / px.length).toBeGreaterThan(0.8);
  });

  it('refuses extras that break the layout', () => {
    const extras = realExtras();
    extras.runs[0] = { ...extras.runs[0]!, coil: { radius: 2, pitch: 0.1 } }; // wider than any coil can be
    expect(() => buildDemoSnapshot(fixtureShow(), extras)).toThrow();
  });
});

describe('domePositions', () => {
  it('gives exactly the asked number of points, the same every time, above the ground', () => {
    const a = domePositions([0, 0, 0], [2, 1, 2], 50);
    expect(a.length).toBe(50);
    expect(domePositions([0, 0, 0], [2, 1, 2], 50)).toEqual(a);
    for (const p of a) expect(p[1]).toBeGreaterThanOrEqual(0);
  });
});
