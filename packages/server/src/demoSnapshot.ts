/**
 * The public demo's copy of the show. An allow-list, so nothing private (the schedule's coordinates,
 * controller addresses, Home Assistant, backups, mapping) and no field added to the show file later
 * is published by accident. The demo-only strings are added on a controller that doesn't exist.
 */
import { buildLayout, type ControllerConfig, type DemoExtras, type DemoSnapshot, type GroupConfig, type RunConfig, type Vec3 } from '@xmas/engine';
import type { ShowState } from './store.js';

const NOWHERE = 'demo.invalid';
const OUTWARD = 0.03;
/** How boxy a bush is: 2 is an ellipsoid; the scanned bushes are rounded boxes, closer to 6. */
const BOXY = 6;
/** cos/sin bent towards a rounded square (a superellipse), keeping the sign. */
const bend = (v: number) => Math.sign(v) * Math.abs(v) ** (2 / BOXY);
/** Metres between the string's passes up and down, measured round the bush. */
const PASS_SPACING = 0.33;
/** Heights, as a share of the bush's, where the string turns: just above the mulch, and over the top edge. */
const LOW = 0.07, HIGH = 0.96, TOP_TURN = 0.995;
/** Points along each pass (lights are then spaced evenly along the whole path). */
const PASS_STEPS = 8;

/**
 * The path of a string zig-zagging up and down a bush (a rounded box standing on the box's floor):
 * up from near the ground, curving over the top edge, back down, a step along, and up again, all the
 * way round. Lights spaced along it look like strands draped up and down the bush. Deterministic.
 */
export function bushZigzag(min: Vec3, max: Vec3): Vec3[] {
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
  const rx = (max[0] - min[0]) / 2 + OUTWARD, rz = (max[2] - min[2]) / 2 + OUTWARD, ry = max[1] - min[1] + OUTWARD;
  // The outline round the bush, sampled finely, so passes can be spaced evenly along it.
  const N = 720;
  const outline = Array.from({ length: N + 1 }, (_, i) => { const t = (2 * Math.PI * i) / N; return [bend(Math.cos(t)), bend(Math.sin(t))] as const; });
  const along = [0];
  for (let i = 1; i <= N; i++) along.push(along[i - 1]! + Math.hypot((outline[i]![0] - outline[i - 1]![0]) * rx, (outline[i]![1] - outline[i - 1]![1]) * rz));
  const perimeter = along[N]!;
  /** The outline's unit point at distance d round it. */
  const at = (d: number) => {
    let i = 1;
    while (i < N && along[i]! < d) i++;
    const f = (d - along[i - 1]!) / (along[i]! - along[i - 1]! || 1);
    return [outline[i - 1]![0] + (outline[i]![0] - outline[i - 1]![0]) * f, outline[i - 1]![1] + (outline[i]![1] - outline[i - 1]![1]) * f] as const;
  };
  /** A point on the bush's surface: round the outline at distance d, at height share h (narrower near the top). */
  const surface = (d: number, h: number): Vec3 => {
    const [u, v] = at(((d % perimeter) + perimeter) % perimeter);
    const r = (1 - h ** BOXY) ** (1 / BOXY);
    return [cx + rx * r * u, min[1] + ry * h, cz + rz * r * v];
  };
  const passes = Math.max(4, 2 * Math.round(perimeter / PASS_SPACING / 2));
  const step = perimeter / passes;
  const out: Vec3[] = [];
  for (let k = 0; k < passes; k++) {
    const up = k % 2 === 0;
    for (let j = 0; j <= PASS_STEPS; j++) {
      const f = j / PASS_STEPS;
      out.push(surface(k * step, up ? LOW + (HIGH - LOW) * f : HIGH - (HIGH - LOW) * f));
    }
    // Round the turn: over the top edge after a pass up, along the ground after a pass down.
    if (k < passes - 1) out.push(surface((k + 0.5) * step, up ? TOP_TURN : LOW));
  }
  return out;
}

/** Steps per turn when tracing a trunk coil (lights are then spaced evenly along it). */
const TRUNK_STEPS = 24;

/**
 * The path of a string coiled round a tree trunk, from the lowest ring to the highest: one turn per
 * `pitch` metres of height, following the trunk's centre and radius between the measured rings
 * ([x, y, z, radius], by height), a little outside the bark. Deterministic.
 */
export function trunkHelix(rings: [number, number, number, number][], pitch: number): Vec3[] {
  const sorted = [...rings].sort((a, b) => a[1] - b[1]);
  const y0 = sorted[0]![1], y1 = sorted[sorted.length - 1]![1];
  const steps = Math.max(1, Math.round(((y1 - y0) / pitch) * TRUNK_STEPS));
  const out: Vec3[] = [];
  let i = 1;
  for (let k = 0; k <= steps; k++) {
    const y = y0 + ((y1 - y0) * k) / steps;
    while (i < sorted.length - 1 && sorted[i]![1] < y) i++;
    const a = sorted[i - 1]!, b = sorted[i]!;
    const f = b[1] === a[1] ? 0 : (y - a[1]) / (b[1] - a[1]);
    const x = a[0] + (b[0] - a[0]) * f, z = a[2] + (b[2] - a[2]) * f, r = a[3] + (b[3] - a[3]) * f + OUTWARD;
    const ang = (2 * Math.PI * (y - y0)) / pitch;
    out.push([x + r * Math.cos(ang), y, z + r * Math.sin(ang)]);
  }
  return out;
}

/** Only the named fields that are present: nested parts of the show are allow-listed too. */
function pick<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
const controllerOf = (c: ControllerConfig): ControllerConfig => ({ ...pick(c, ['id', 'name', 'pixelCount']), host: NOWHERE });
const runOf = (r: RunConfig): RunConfig => pick(r, ['id', 'name', 'controller', 'start', 'count', 'points', 'positions', 'coil']);
const groupOf = (g: GroupConfig): GroupConfig => pick(g, ['runs', 'pixels', 'feather']);

export function buildDemoSnapshot(show: ShowState, extras: DemoExtras): DemoSnapshot {
  let start = 0;
  const extraRuns: RunConfig[] = extras.runs.map(({ bush, trunk, ...r }) => {
    const path = bush ? bushZigzag(bush.min, bush.max) : trunk ? trunkHelix(trunk.rings, trunk.pitch) : undefined;
    const run: RunConfig = { ...r, controller: 'demo', start, ...(path && { points: path }) };
    start += r.count;
    return run;
  });
  const realGroups = Object.fromEntries(Object.entries(show.layout.groups ?? {}).map(([k, g]) => [k, groupOf(g)]));
  const realPorch = realGroups.porch ?? { runs: [] };
  const layout = {
    controllers: [
      ...show.layout.controllers.map(controllerOf),
      { id: 'demo', name: 'Demo strings (not real)', host: NOWHERE, pixelCount: start },
    ],
    runs: [...show.layout.runs.map(runOf), ...extraRuns],
    groups: {
      ...realGroups,
      'porch-real': realPorch,
      porch: { ...realPorch, runs: [...(realPorch.runs ?? []), ...extraRuns.map((r) => r.id)] },
      ...extras.groups,
    },
  };
  buildLayout(layout); // throws on a layout that can't be played
  const h = show.house;
  const active = show.activeScene && Object.hasOwn(show.scenes, show.activeScene) ? show.activeScene : null;
  return {
    layout,
    scenes: show.scenes,
    playlists: show.playlists ?? {},
    presets: show.presets ?? {},
    palettes: show.palettes ?? {},
    activeScene: active,
    stage: active ? (show.stage?.name === active ? show.stage : show.scenes[active]!) : null,
    output: { brightness: show.output.brightness, gamma: show.output.gamma, transition: show.output.transition ?? 1 },
    house: h ? {
      position: h.position, rotation: h.rotation, scale: h.scale, opacity: h.opacity, ...(h.glow !== undefined && { glow: h.glow }),
      parts: (h.parts ?? []).map(({ id, name, uploadedAt, bytes, position, rotation, scale, visible }) => ({ id, name, uploadedAt, bytes, position, rotation, scale, visible })),
    } : null,
  };
}
