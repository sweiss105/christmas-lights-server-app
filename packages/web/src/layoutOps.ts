import { buildLayout, type LayoutConfig, type RunConfig, type Vec3 } from '@xmas/engine';

/** Pure layout edits for the layout editor. Each returns a new layout. */

const mapRun = (l: LayoutConfig, id: string, fn: (r: RunConfig) => RunConfig): LayoutConfig => ({
  ...l, runs: l.runs.map((r) => (r.id === id ? fn(r) : r)),
});

/** Unused pixel ranges on a controller, in order. */
export function freeRanges(l: LayoutConfig, controller: string): { start: number; count: number }[] {
  const c = l.controllers.find((x) => x.id === controller);
  if (!c) return [];
  const used = l.runs.filter((r) => r.controller === controller).map((r) => [r.start, r.start + r.count] as const).sort((a, b) => a[0] - b[0]);
  const out: { start: number; count: number }[] = [];
  let at = 0;
  for (const [s, e] of used) { if (s > at) out.push({ start: at, count: s - at }); at = Math.max(at, e); }
  if (at < c.pixelCount) out.push({ start: at, count: c.pixelCount - at });
  return out;
}

/** A new run filling the first free range on the controller, drawn as a 2 m line beside the last run. */
export function addRun(l: LayoutConfig, controller: string): LayoutConfig {
  const free = freeRanges(l, controller)[0] ?? { start: 0, count: 1 };
  let n = l.runs.length + 1;
  while (l.runs.some((r) => r.id === `run-${n}`)) n++;
  const last = l.runs.at(-1)?.points?.at(-1) ?? [0, 1, 0];
  const run: RunConfig = {
    id: `run-${n}`, name: `New run ${n}`, controller, start: free.start, count: free.count,
    points: [[last[0] + 0.5, last[1], last[2]], [last[0] + 2.5, last[1], last[2]]],
  };
  return { ...l, runs: [...l.runs, run] };
}

export function updateRun(l: LayoutConfig, id: string, patch: Partial<Omit<RunConfig, 'id'>>): LayoutConfig {
  return mapRun(l, id, (r) => ({ ...r, ...patch }));
}

/** Remove a run and any group references to it. */
export function removeRun(l: LayoutConfig, id: string): LayoutConfig {
  const groups = l.groups && Object.fromEntries(Object.entries(l.groups).map(([k, g]) => [k, { ...g, ...(g.runs && { runs: g.runs.filter((r) => r !== id) }) }]));
  return { ...l, runs: l.runs.filter((r) => r.id !== id), ...(groups && { groups }) };
}

/** Flip which end of the path the first pixel is at (when a string is wired from the other end). */
export function reverseRun(l: LayoutConfig, id: string): LayoutConfig {
  return mapRun(l, id, (r) => ({ ...r, ...(r.points && { points: [...r.points].reverse() }), ...(r.positions && { positions: [...r.positions].reverse() }) }));
}

const pts = (r: RunConfig): Vec3[] => (r.points ?? []).map((p) => [...p] as Vec3);
const round = (v: number) => Math.round(v * 1000) / 1000;
const roundP = (p: Vec3): Vec3 => [round(p[0]), round(p[1]), round(p[2])];

export function setPoint(l: LayoutConfig, id: string, i: number, p: Vec3): LayoutConfig {
  return mapRun(l, id, (r) => { const ps = pts(r); ps[i] = roundP(p); return { ...r, points: ps }; });
}

/** Insert a point after index i: halfway to the next point, or 1 m on from the last. */
export function insertPoint(l: LayoutConfig, id: string, i: number): LayoutConfig {
  return mapRun(l, id, (r) => {
    const ps = pts(r);
    const a = ps[i]!, b = ps[i + 1];
    const p: Vec3 = b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] : [a[0] + 1, a[1], a[2]];
    ps.splice(i + 1, 0, roundP(p));
    return { ...r, points: ps };
  });
}

export function appendPoint(l: LayoutConfig, id: string, p: Vec3): LayoutConfig {
  return mapRun(l, id, (r) => ({ ...r, points: [...pts(r), roundP(p)] }));
}

/** Remove a point; a run always keeps at least one. */
export function removePoint(l: LayoutConfig, id: string, i: number): LayoutConfig {
  return mapRun(l, id, (r) => { const ps = pts(r); if (ps.length > 1) ps.splice(i, 1); return { ...r, points: ps }; });
}

/** Length of a run's path in metres. */
export function runLength(r: RunConfig): number {
  const ps = r.positions ?? r.points ?? [];
  let d = 0;
  for (let i = 1; i < ps.length; i++) d += Math.hypot(ps[i]![0] - ps[i - 1]![0], ps[i]![1] - ps[i - 1]![1], ps[i]![2] - ps[i - 1]![2]);
  return d;
}

/** Why the layout can't be used, or null if it's valid. Same rules as the server. */
export function layoutError(l: LayoutConfig): string | null {
  try { buildLayout(l); return null; } catch (e) { return (e as Error).message; }
}
