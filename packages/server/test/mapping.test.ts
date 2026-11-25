import { gzipSync } from 'node:zlib';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLayout, type LayoutConfig } from '@xmas/engine';
import { codeWord, planMapping, slotMasks, type MappingPlan } from '@xmas/engine/mapping';
import { createApp, type App } from '../src/api.js';
import type { ShowState } from '../src/store.js';
import { fakeDdpReceiver } from './helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const layout = (port = 9): LayoutConfig => ({
  controllers: [{ id: 'a', name: 'A', host: '127.0.0.1', port, pixelCount: 60 }],
  runs: [
    { id: 'r1', controller: 'a', start: 0, count: 30, points: [[0, 1, 0], [3, 1, 0]] },
    { id: 'r2', controller: 'a', start: 35, count: 25, points: [[0, 0, 0], [3, 0, 0]] },
  ],
});

async function makeApp(over: Partial<ShowState> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'xmas-map-'));
  const state: ShowState = {
    layout: layout(),
    scenes: { Red: { name: 'Red', layers: [{ id: 'l', effect: 'solid', params: { color: '#ff0000' } }] } },
    activeScene: 'Red',
    output: { brightness: 0.5, gamma: 1, fps: 40, enabled: false, transition: 0 },
    ...over,
  };
  const app: App = await createApp({ state, statePath: join(dir, 'state.json') });
  cleanups.push(() => app.server.close());
  return { app, dir };
}

/** Pixels lit in a frame (any channel above 0) and the level they're lit at. */
const lit = (frame: Uint8Array) => {
  const on: number[] = [];
  for (let i = 0; i < frame.length / 3; i++) if (frame[i * 3]! > 0) on.push(i);
  return { on, level: on.length ? frame[on[0]! * 3]! : 0 };
};

describe('mapping sequence plan', () => {
  it('lights every k-th pixel of each run per pass and gives each a unique code', () => {
    const l = buildLayout(layout());
    const plan = planMapping(l, { k: 5, passes: 2 });
    expect(plan.passes.map((p) => p.offset)).toEqual([0, 2]);
    expect(plan.passes[0]!.pixels).toEqual([0, 5, 10, 15, 20, 25, 35, 40, 45, 50, 55]);
    expect(plan.passes[1]!.pixels).toEqual([2, 7, 12, 17, 22, 27, 37, 42, 47, 52, 57]);
    expect(plan.bits).toBe(4); // codes 1..11
    const words = plan.passes[0]!.pixels.map((_, i) => codeWord(i + 1, plan.bits));
    expect(new Set(words).size).toBe(words.length);
    // preamble 7 + per pass (2 refs + 2 × (4 bits + parity)) + end
    expect(plan.slots.length).toBe(7 + 2 * (2 + 10) + 1);
    expect(plan.durationMs).toBe(plan.slots.length * 250);
  });

  it('shows each bit as itself and inverted, so every pass pixel is on in exactly one of each pair', () => {
    const l = buildLayout(layout());
    const plan = planMapping(l, { k: 5, passes: 1 });
    const masks = slotMasks(l, plan);
    plan.slots.forEach((s, i) => {
      if (s.kind !== 'bit') return;
      const inv = plan.slots.findIndex((o) => o.kind === 'bit-inv' && o.pass === s.pass && o.bit === s.bit);
      for (const px of plan.passes[s.pass!]!.pixels) expect(masks[i]![px]! + masks[inv]![px]!).toBe(1);
      for (let px = 0; px < l.count; px++) if (!plan.passes[s.pass!]!.pixels.includes(px)) expect(masks[i]![px]! + masks[inv]![px]!).toBe(0);
    });
    // Preamble lights every placed pixel and none of the gap (30..34) between the runs.
    const first = masks[0]!;
    expect(first[0]).toBe(1); expect(first[32]).toBe(0); expect(first[59]).toBe(1);
  });
});

describe('mapping mode on the server', () => {
  it('takes over the output while the sequence plays, then gives the show back', async () => {
    const { app } = await makeApp();
    const res = await app.server.inject({ method: 'POST', url: '/api/mapping/start', payload: { k: 5, passes: 1, holdMs: 200, level: 1, leadMs: 1000 } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { startsAt: number; endsAt: number; plan: MappingPlan; streaming: boolean; active: boolean };
    expect(body.active).toBe(true);
    expect(body.streaming).toBe(false); // the UI warns: nothing reaches the porch until streaming is on
    const l = buildLayout(layout());
    const plan = planMapping(l, { k: 5, passes: 1, holdMs: 200, level: 1 });
    expect(body.plan).toEqual(JSON.parse(JSON.stringify(plan)));

    // During the lead-in the frame is dark (GET /api/frame shows what the porch would be sent).
    expect(lit((await app.server.inject('/api/frame')).rawPayload).on).toEqual([]);

    // Each slot shows its mask, at white × master brightness (0.5 → 128 with gamma 1).
    const masks = slotMasks(l, plan);
    const frame = new Uint8Array(60 * 3);
    for (let s = 0; s < plan.slots.length; s++) {
      frame.fill(9);
      app.output.overlay!(frame, body.startsAt + (s + 0.5) * 0.2);
      const want = [...masks[s]!.keys()].filter((i) => masks[s]![i]);
      const got = lit(frame);
      expect(got.on).toEqual(want);
      if (want.length) expect(got.level).toBe(128);
    }
    // After the end the scene (solid red) shows again.
    frame.fill(0);
    app.output.overlay!(frame, body.endsAt + 0.01);
    expect(frame[0]).toBe(0); // the overlay leaves the frame alone...
    const after = (await app.server.inject('/api/frame')).rawPayload;
    expect([...after.subarray(0, 3)]).toEqual([128, 0, 0]); // ...and the porch is red again
    expect((await app.server.inject('/api/mapping')).json().active).toBe(false);
  });

  it('can be stopped, and rejects bad settings', async () => {
    const { app } = await makeApp();
    await app.server.inject({ method: 'POST', url: '/api/mapping/start', payload: { leadMs: 5000 } });
    expect((await app.server.inject('/api/mapping')).json().active).toBe(true);
    expect((await app.server.inject({ method: 'POST', url: '/api/mapping/stop' })).json().active).toBe(false);
    expect([...(await app.server.inject('/api/frame')).rawPayload.subarray(0, 3)]).toEqual([128, 0, 0]);
    expect((await app.server.inject({ method: 'POST', url: '/api/mapping/start', payload: { leadMs: -1 } })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'POST', url: '/api/mapping/start', payload: { k: 2, passes: 2, holdMs: 1000, leadMs: 0 } })).statusCode).toBe(200);
  });

  it('streams the slots in order over DDP', async () => {
    const rx = await fakeDdpReceiver(60);
    cleanups.push(rx.close);
    const { app } = await makeApp({ layout: layout(rx.port) });
    app.output.startStreaming();
    const res = (await app.server.inject({ method: 'POST', url: '/api/mapping/start', payload: { k: 5, passes: 1, holdMs: 100, leadMs: 100 } })).json() as { plan: MappingPlan; endsAt: number };
    await new Promise((r) => setTimeout(r, 100 + res.plan.durationMs + 200));
    await app.output.stopStreaming(false);
    await new Promise((r) => setTimeout(r, 50));
    // Collapse the received frames into the run of distinct patterns, ignoring the red show before and after.
    const l = buildLayout(layout(rx.port));
    const masks = slotMasks(l, res.plan);
    const key = (m: ArrayLike<number>) => Array.from(m, (v) => (v ? 1 : 0)).join('');
    const seen: string[] = [];
    for (const f of rx.frames) {
      const d = f.data;
      if (d[0]! > 0 && d[1] === 0) continue; // the red show, before and after
      const k = key(Array.from({ length: 60 }, (_, i) => d[i * 3]!));
      if (seen.at(-1) !== k) seen.push(k);
    }
    const expected: string[] = [];
    for (const m of [new Uint8Array(60), ...masks]) { const k = key(m); if (expected.at(-1) !== k) expected.push(k); }
    expect(seen).toEqual(expected);
  });

  it('keeps the views the phone sends, for solving again later', async () => {
    const { app } = await makeApp();
    const view = { width: 1280, height: 720, params: { k: 10 }, detections: [{ pixel: 3, x: 100.5, y: 200.25, margin: 0.8 }], stats: { blobs: 4 } };
    const saved = (await app.server.inject({ method: 'POST', url: '/api/mapping/views', payload: view })).json();
    expect(saved.id).toMatch(/^v/);
    expect(saved.layoutPixels).toBe(60);
    expect(saved.params.k).toBe(10);
    const list = (await app.server.inject('/api/mapping/views')).json();
    expect(list).toHaveLength(1);
    expect(list[0].detections[0]).toEqual({ pixel: 3, x: 100.5, y: 200.25, margin: 0.8 });
    const withCam = (await app.server.inject({ method: 'POST', url: '/api/mapping/views', payload: { ...view, camera: 'Back Ultra Wide Camera@1' } })).json();
    expect(withCam.camera).toBe('Back Ultra Wide Camera@1');
    await app.server.inject({ method: 'DELETE', url: `/api/mapping/views/${withCam.id}` });
    expect((await app.server.inject({ method: 'POST', url: '/api/mapping/views', payload: { ...view, detections: [{ pixel: 999, x: 1, y: 1 }] } })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'DELETE', url: `/api/mapping/views/${saved.id}` })).statusCode).toBe(200);
    expect((await app.server.inject('/api/mapping/views')).json()).toEqual([]);
  });

  it('brightness test: holds every k-th light at the chosen level, then gives the show back', async () => {
    const { app } = await makeApp();
    const res = await app.server.inject({ method: 'POST', url: '/api/mapping/preview', payload: { k: 10, level: 0.5, seconds: 5 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().preview.lights).toBeGreaterThan(0);
    const frame = (await app.server.inject('/api/frame')).rawPayload;
    const lit = [...Array(frame.length / 3).keys()].filter((i) => frame[i * 3]! > 0);
    expect(lit.length).toBe(res.json().preview.lights);
    expect(new Set(lit.map((i) => frame[i * 3])).size).toBe(1); // all at one level
    await app.server.inject({ method: 'POST', url: '/api/mapping/stop' });
    expect((await app.server.inject({ method: 'POST', url: '/api/mapping/preview', payload: { seconds: 99 } })).statusCode).toBe(400);
  });

  it('keeps uploaded footage recordings (gzip), the newest few, with safe file names', async () => {
    const { app, dir } = await makeApp();
    const gz = gzipSync(Buffer.from('frames'));
    const post = (label: string, body: Buffer) => app.server.inject({ method: 'POST', url: `/api/mapping/recordings?label=${encodeURIComponent(label)}&view=v1`, headers: { 'content-type': 'application/octet-stream' }, payload: body });
    const res = await post('Spot 1/../x', gz);
    expect(res.statusCode).toBe(200);
    expect(res.json().saved).toMatch(/^[\w-]+_Spot-1-x_v1\.bin\.gz$/);
    expect(await readdir(join(dir, 'mapping-recordings'))).toContain(res.json().saved);
    expect((await post('x', Buffer.from('not gzip at all'))).statusCode).toBe(400);
    for (let i = 0; i < 7; i++) expect((await post(`s${i}`, gz)).statusCode).toBe(200);
    expect((await app.server.inject('/api/mapping/recordings')).json()).toHaveLength(6);
  });

  it('saves a backup on request (before accepting mapped positions)', async () => {
    const { app, dir } = await makeApp();
    const res = await app.server.inject({ method: 'POST', url: '/api/backups', payload: { reason: 'before-mapping' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().file).toMatch(/^before-mapping-.*\.json$/);
    expect(await readdir(join(dir, 'backups'))).toContain(res.json().file);
    expect((await app.server.inject({ method: 'POST', url: '/api/backups', payload: { reason: '../x' } })).statusCode).toBe(400);
  });
});
