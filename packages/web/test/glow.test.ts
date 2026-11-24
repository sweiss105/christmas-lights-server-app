import { describe, expect, it } from 'vitest';
import { clusterLights, glowColors, GLOW_BLOBS, GLOW_GROUP_SIZE, GLOW_GROUPS, GLOW_RANGE } from '../src/glow';

/** `n` lights along a straight line from x0 to x1 (y = 1, z = 0). */
function line(n: number, x0: number, x1: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(x0 + ((x1 - x0) * i) / Math.max(1, n - 1), 1, 0);
  return out;
}

describe('glow clusters', () => {
  it('uses at most the blob count and puts every light in its nearest blob', () => {
    const pos = new Float32Array([...line(300, 0, 10), ...line(200, 0, 6).map((v, i) => (i % 3 === 2 ? 4 : v))]);
    const c = clusterLights(pos);
    expect(c.used).toBe(GLOW_BLOBS);
    expect(c.centers.length).toBe(GLOW_BLOBS * 3);
    expect(Array.from(c.counts).reduce((a, b) => a + b, 0)).toBe(500);
    for (let i = 0; i < 500; i++) {
      const d = (k: number) => Math.hypot(pos[i * 3]! - c.centers[k * 3]!, pos[i * 3 + 1]! - c.centers[k * 3 + 1]!, pos[i * 3 + 2]! - c.centers[k * 3 + 2]!);
      let best = Infinity;
      for (let k = 0; k < c.used; k++) best = Math.min(best, d(k));
      expect(d(c.assign[i]!)).toBeCloseTo(best, 4);
    }
    // Both strings get blobs, spread along them (no blob far from every light).
    const front = Array.from({ length: c.used }, (_, k) => c.centers[k * 3 + 2]!).filter((z) => z < 2).length;
    expect(front).toBeGreaterThan(15);
    expect(c.used - front).toBeGreaterThan(10);
  });

  it('handles fewer lights than blobs, and none', () => {
    const c = clusterLights(new Float32Array(line(5, 0, 1)));
    expect(c.used).toBe(5);
    // One blob per group, each in its group's first slot; the rest are empty.
    const slots = Array.from(c.assign).sort((a, b) => a - b);
    expect(slots).toEqual([0, 1, 2, 3, 4].map((g) => g * GLOW_GROUP_SIZE));
    expect(Array.from(c.counts).reduce((a, b) => a + b, 0)).toBe(5);
    expect(clusterLights(new Float32Array(0)).used).toBe(0);
  });

  it('is deterministic', () => {
    const pos = new Float32Array(line(120, -3, 3));
    expect(Array.from(clusterLights(pos).assign)).toEqual(Array.from(clusterLights(pos).assign));
  });
});

describe('glow groups', () => {
  it('each group\'s sphere reaches all its blobs plus the glow range; unused slots are out of reach', () => {
    const pos = new Float32Array([...line(300, -8, 8), ...line(120, -3, 3).map((v, i) => (i % 3 === 2 ? 3 : v))]);
    const c = clusterLights(pos);
    for (let s = 0; s < GLOW_BLOBS; s++) {
      const g = Math.floor(s / GLOW_GROUP_SIZE);
      const d = Math.hypot(c.centers[s * 3]! - c.groups[g * 4]!, c.centers[s * 3 + 1]! - c.groups[g * 4 + 1]!, c.centers[s * 3 + 2]! - c.groups[g * 4 + 2]!);
      if (c.counts[s]) expect((d + GLOW_RANGE) ** 2).toBeLessThanOrEqual(c.groups[g * 4 + 3]! + 1e-3);
      else expect(Math.abs(c.centers[s * 3]!)).toBeGreaterThan(1000);
    }
  });

  it('keeps neighbours along the strings together, so groups stay small', () => {
    const c = clusterLights(new Float32Array(line(480, 0, 16))); // 16 m of lights, 2 m per group
    for (let g = 0; g < GLOW_GROUPS; g++) expect(Math.sqrt(c.groups[g * 4 + 3]!)).toBeLessThan(1.4 + GLOW_RANGE);
  });

  it('marks groups without blobs empty when there are only a few lights', () => {
    const c = clusterLights(new Float32Array(line(3, 0, 1)));
    expect(Array.from({ length: GLOW_GROUPS }, (_, g) => c.groups[g * 4 + 3]! < 0).filter(Boolean).length).toBe(GLOW_GROUPS - 3);
  });
});

describe('glow colours', () => {
  it('sums each blob\'s light (linear), scaled so an average blob at full white gives 1', () => {
    const pos = new Float32Array(line(96, 0, 10));
    const c = clusterLights(pos);
    const colors = new Float32Array(96 * 3).fill(1);
    const out = new Float32Array(GLOW_BLOBS * 3);
    glowColors(colors, c, out);
    const avg = Array.from(out).reduce((a, b) => a + b, 0) / out.length;
    expect(avg).toBeCloseTo(1, 5);
  });

  it('follows the lights\' colours and leaves unlit blobs dark', () => {
    const pos = new Float32Array(line(96, 0, 10));
    const c = clusterLights(pos);
    const colors = new Float32Array(96 * 3);
    colors[0] = 1; // first light pure red
    colors[95 * 3 + 2] = 0.5; // last light half blue (a quarter in linear)
    const out = new Float32Array(GLOW_BLOBS * 3).fill(9); // stale values are cleared
    glowColors(colors, c, out);
    const first = c.assign[0]!, last = c.assign[95]!;
    const scale = c.used / 96;
    expect(out[first * 3]).toBeCloseTo(scale, 5);
    expect(out[first * 3 + 1]).toBe(0);
    expect(out[last * 3 + 2]).toBeCloseTo(0.25 * scale, 5);
    const lit = new Set([first, last]);
    for (let k = 0; k < GLOW_BLOBS; k++) if (!lit.has(k)) expect(out[k * 3]! + out[k * 3 + 1]! + out[k * 3 + 2]!).toBe(0);
  });
});
