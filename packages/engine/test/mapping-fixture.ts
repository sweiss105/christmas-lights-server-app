/**
 * A porch like the real one, for mapping tests: two 500-pixel strings coiled round railings (the
 * trusted anchors, as placed from the house model), plus strings on a second controller whose
 * positions are only roughly known (a stair handrail and a bush), which mapping should find.
 */
import { buildLayout, type LayoutConfig, type Vec3 } from '../src/index.js';
import { MappingDecoder, planMapping, rng, simulateFrames, slotMasks, trueProjection, type SimView } from '../src/mapping/index.js';

const coil = { radius: 0.03, pitch: 0.27 };

export const porchRuns: LayoutConfig['runs'] = [
  // Left side rail from the house, the front left, then down the left stair rail.
  { id: 'gpio16', controller: 'porch', start: 0, count: 500, coil: { ...coil }, points: [[-3, 0.95, 0.5], [-3, 0.95, 2.5], [-0.6, 0.95, 2.5], [-0.6, -0.1, 4.0]] },
  // Up the right stair rail, the front right, the right side to the house, down the post, back along the bottom.
  { id: 'gpio12', controller: 'porch', start: 500, count: 500, coil: { ...coil, skip: [3] }, points: [[0.6, -0.1, 4.0], [0.6, 0.95, 2.5], [3, 0.95, 2.5], [3, 0.95, 0.5], [3, 0.15, 0.5], [3, 0.15, 2.5], [0.8, 0.15, 2.5]] },
];

/** The real shape of the new strings (what the simulated camera sees). */
const handrailTrue: Vec3[] = [[1.2, -0.3, 4.6], [2.4, -1.0, 6.2], [3.1, -1.6, 7.4], [3.3, -1.7, 8.0]];
const bushTrue: Vec3[] = [[-4.6, -0.2, 3.6], [-4.0, 0.4, 3.9], [-3.5, -0.1, 4.2], [-3.0, 0.5, 4.0], [-2.4, -0.1, 4.4]];

const layoutWith = (handrail: Vec3[], bush: Vec3[]): LayoutConfig => ({
  controllers: [
    { id: 'porch', name: 'Porch', host: '192.0.2.1', pixelCount: 1101 },
    { id: 'yard', name: 'Yard', host: '192.0.2.2', pixelCount: 300 },
  ],
  runs: [
    ...porchRuns,
    { id: 'handrail', controller: 'yard', start: 0, count: 150, points: handrail },
    { id: 'bush', controller: 'yard', start: 150, count: 120, points: bush },
  ],
});

/** The layout as saved before mapping: the new strings drawn roughly by hand (about 30–50 cm off). */
export const roughLayout = layoutWith([[1.0, 0, 4.4], [3.4, -1.5, 8.3]], [[-4.5, 0, 3.4], [-2.2, 0, 4.6]]);

/**
 * Where every light really is: the new strings on their true paths, and the porch where the
 * model says plus up to `porchErr` metres of error (the model and the coil are not perfect).
 */
export function truePositions(porchErr = 0.01, seed = 7): Float32Array {
  const truth = buildLayout(layoutWith(handrailTrue, bushTrue)).positions.slice();
  const r = rng(seed);
  for (let i = 0; i < 1000; i++) for (let a = 0; a < 3; a++) truth[i * 3 + a]! += (r() * 2 - 1) * porchErr;
  return truth;
}

/** Three spots in the yard (it slopes down towards the street), phone at chest height. */
export const spots = [
  { eye: [-4.5, -0.6, 11] as Vec3, target: [-0.3, 0.3, 3] as Vec3 },
  { eye: [0.5, -1.0, 12.5] as Vec3, target: [0, 0.2, 3] as Vec3 },
  { eye: [5.5, -0.8, 10.5] as Vec3, target: [0.4, 0.2, 3] as Vec3 },
];

/** Film one view with the synthetic camera and decode it. */
export function filmAndDecode(view: SimView, opts: { seed?: number; k?: number; passes?: number; holdMs?: number; clockErrorMs?: number; dropRate?: number } = {}) {
  const layout = buildLayout(roughLayout);
  const plan = planMapping(layout, { k: opts.k ?? 10, passes: opts.passes ?? 2, holdMs: opts.holdMs ?? 250 });
  const masks = slotMasks(layout, plan);
  const truth = truePositions();
  const startMs = 10_000 + 123.4; // when slot 0 truly starts on the phone's clock (lead-in, latency...)
  const decoder = new MappingDecoder(plan, { width: view.width, height: view.height, startGuessMs: startMs + (opts.clockErrorMs ?? 180) });
  for (const f of simulateFrames({ positions: truth, masks, holdMs: plan.params.holdMs, view, startMs, fromMs: startMs - 1500, toMs: startMs + plan.durationMs + 300, seed: opts.seed ?? 3, dropRate: opts.dropRate })) decoder.push(f.t, f.lum);
  return { result: decoder.finish(), plan, truth, proj: trueProjection(truth, view) };
}

