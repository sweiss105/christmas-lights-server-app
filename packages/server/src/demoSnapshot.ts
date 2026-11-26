/**
 * The public demo's copy of the show. An allow-list, so nothing private (the schedule's coordinates,
 * controller addresses, Home Assistant, backups, mapping) and no field added to the show file later
 * is published by accident. The demo-only strings are added on a controller that doesn't exist.
 */
import { buildLayout, type ControllerConfig, type DemoExtras, type DemoSnapshot, type GroupConfig, type RunConfig, type Vec3 } from '@xmas/engine';
import type { ShowState } from './store.js';

const NOWHERE = 'demo.invalid';
const OUTWARD = 0.03;
/** The lowest part of a bush's dome gets no lights (they'd sit in the mulch). */
const LOWEST = 0.2;
/** How boxy the dome is: 2 is an ellipsoid; the scanned bushes are rounded boxes, closer to 6. */
const BOXY = 6;
/** cos/sin bent towards a rounded square (a superellipse), keeping the sign. */
const bend = (v: number) => Math.sign(v) * Math.abs(v) ** (2 / BOXY);

/**
 * `count` lights over a rounded dome (half a superellipsoid) filling the box, standing on its floor:
 * rings from the top down, alternate rings run the other way (zig-zag, like a net), pushed a little
 * outward. Deterministic.
 */
export function domePositions(min: Vec3, max: Vec3, count: number): Vec3[] {
  if (!(count > 0)) return [];
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
  const rx = (max[0] - min[0]) / 2 + OUTWARD, ry = max[1] - min[1] + OUTWARD, rz = (max[2] - min[2]) / 2 + OUTWARD;
  const thetaMax = Math.acos(LOWEST);
  const rings = Math.max(1, Math.round(Math.sqrt(count / 2)));
  const thetas = Array.from({ length: rings }, (_, k) => (thetaMax * (k + 0.5)) / rings);
  const weights = thetas.map((t) => bend(Math.sin(t)));
  const total = weights.reduce((a, b) => a + b, 0);
  const per = weights.map((w) => Math.floor((count * w) / total));
  // Hand out what rounding left over, widest rings first.
  for (let left = count - per.reduce((a, b) => a + b, 0), k = rings - 1; left > 0; left--, k = (k - 1 + rings) % rings) per[k]!++;
  const out: Vec3[] = [];
  thetas.forEach((theta, k) => {
    const n = per[k]!;
    const phase = k * 2.399963; // golden angle, so rings don't line up
    const ring: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const phi = phase + (2 * Math.PI * i) / n;
      ring.push([cx + rx * bend(Math.sin(theta)) * bend(Math.cos(phi)), min[1] + ry * bend(Math.cos(theta)), cz + rz * bend(Math.sin(theta)) * bend(Math.sin(phi))]);
    }
    out.push(...(k % 2 ? ring.reverse() : ring));
  });
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
  const extraRuns: RunConfig[] = extras.runs.map(({ dome, ...r }) => {
    const run: RunConfig = { ...r, controller: 'demo', start, ...(dome && { positions: domePositions(dome.min, dome.max, r.count) }) };
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
