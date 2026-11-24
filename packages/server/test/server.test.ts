import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/api.js';
import type { ShowState } from '../src/store.js';
import { getInfo, getPresets, releaseToPreset } from '../src/wled.js';
import { fakeDdpReceiver, fakeWledHttp } from './helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function makeApp(over: Partial<ShowState> = {}, apiToken?: string, webRoot?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'xmas-'));
  const state: ShowState = {
    layout: {
      controllers: [{ id: 'a', name: 'A', host: '127.0.0.1', port: 9, pixelCount: 10 }],
      runs: [{ id: 'r', controller: 'a', start: 0, count: 10, points: [[0, 0, 0], [1, 0, 0]] }],
    },
    scenes: { Red: { name: 'Red', layers: [{ id: 'l', effect: 'solid', params: { color: '#ff0000' } }] } },
    activeScene: 'Red',
    output: { brightness: 1, gamma: 1, fps: 40, enabled: false },
    ...over,
  };
  const statePath = join(dir, 'state.json');
  const app: App = await createApp({ state, statePath, apiToken, webRoot });
  cleanups.push(() => app.server.close());
  return { app, statePath, state };
}

describe('DDP streaming end to end', () => {
  it('streams the active scene at ~40 fps and the frames decode to the right colours', async () => {
    const rx = await fakeDdpReceiver(1450);
    cleanups.push(rx.close);
    const { app } = await makeApp({
      layout: {
        controllers: [{ id: 'a', name: 'A', host: '127.0.0.1', port: rx.port, pixelCount: 1450 }],
        runs: [{ id: 'r', controller: 'a', start: 0, count: 1450, points: [[0, 0, 0], [10, 0, 0]] }],
      },
    });
    app.output.startStreaming();
    await new Promise((r) => setTimeout(r, 1000));
    await app.output.stopStreaming(false);
    await new Promise((r) => setTimeout(r, 50)); // let in-flight datagrams land
    expect(rx.frames.length).toBeGreaterThanOrEqual(36);
    expect(rx.frames.length).toBeLessThanOrEqual(42);
    const last = rx.frames.at(-1)!.data;
    expect([...last.subarray(0, 3)]).toEqual([255, 0, 0]);
    expect([...last.subarray(1449 * 3)]).toEqual([255, 0, 0]);
    expect(app.output.stats().controllers[0]!.framesSent).toBe(rx.frames.length);
  });

  it('sends each controller only its own slice', async () => {
    const [rx1, rx2] = await Promise.all([fakeDdpReceiver(4), fakeDdpReceiver(3)]);
    cleanups.push(rx1.close, rx2.close);
    const { app } = await makeApp({
      layout: {
        controllers: [
          { id: 'a', name: 'A', host: '127.0.0.1', port: rx1.port, pixelCount: 4 },
          { id: 'b', name: 'B', host: '127.0.0.1', port: rx2.port, pixelCount: 3 },
        ],
        runs: [
          { id: 'ra', controller: 'a', start: 0, count: 4, points: [[0, 0, 0], [1, 0, 0]] },
          { id: 'rb', controller: 'b', start: 0, count: 3, points: [[2, 0, 0], [3, 0, 0]] },
        ],
      },
      scenes: { S: { name: 'S', layers: [{ id: 'l', effect: 'solid', params: { color: '#0000ff' } }, { id: 'g', effect: 'solid', group: 'run:rb', params: { color: '#00ff00' } }] } },
      activeScene: 'S',
    });
    app.output.startStreaming();
    await new Promise((r) => setTimeout(r, 150));
    await app.output.stopStreaming(false);
    expect([...rx1.frames.at(-1)!.data]).toEqual([0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255]);
    expect([...rx2.frames.at(-1)!.data]).toEqual([0, 255, 0, 0, 255, 0, 0, 255, 0]);
  });
});

describe('WLED client', () => {
  it('reads info and presets and releases to a preset', async () => {
    const w = await fakeWledHttp();
    cleanups.push(w.close);
    expect((await getInfo(w.host)).ledCount).toBe(1450);
    expect(await getPresets(w.host)).toEqual([{ id: 1, name: 'Warm' }, { id: 3, name: 'Chase' }]);
    await releaseToPreset(w.host, 3);
    expect(w.posts).toEqual([{ live: false, on: true, ps: 3 }]);
  });

  it('stopping the stream hands controllers back to their fallback preset', async () => {
    const w = await fakeWledHttp();
    cleanups.push(w.close);
    const { app } = await makeApp({
      layout: {
        controllers: [{ id: 'a', name: 'A', host: w.host, pixelCount: 2, fallbackPreset: 4 }],
        runs: [{ id: 'r', controller: 'a', start: 0, count: 2, points: [[0, 0, 0]] }],
      },
    });
    await app.output.stopStreaming(true);
    expect(w.posts).toEqual([{ live: false, on: true, ps: 4 }]);
  });
});

describe('Blind / Live editing and the web UI', () => {
  const blue = { layers: [{ id: 'l', effect: 'solid', params: { color: '#0000ff' } }] };
  const firstPixel = async (app: App) => [...(await app.server.inject('/api/frame')).rawPayload.subarray(0, 3)];

  it('a Blind save (apply=false) updates the saved scene but not the stage, and Go puts it on stage', async () => {
    const { app, statePath } = await makeApp();
    const put = await app.server.inject({ method: 'PUT', url: '/api/scenes/Red?apply=false', payload: blue });
    expect(put.statusCode).toBe(200);
    expect(await firstPixel(app)).toEqual([255, 0, 0]); // porch unchanged
    expect(JSON.parse(await readFile(statePath, 'utf8')).scenes.Red.layers[0].params.color).toBe('#0000ff'); // but saved
    expect((await app.server.inject('/api/status')).json().stage).toEqual({ scene: 'Red', dirty: true });

    expect((await app.server.inject({ method: 'POST', url: '/api/scenes/Red/activate' })).statusCode).toBe(200); // Go
    expect(await firstPixel(app)).toEqual([0, 0, 255]);
    expect((await app.server.inject('/api/status')).json().stage).toEqual({ scene: 'Red', dirty: false });
  });

  it('a Live save (the default) updates the stage at once', async () => {
    const { app } = await makeApp();
    await app.server.inject({ method: 'PUT', url: '/api/scenes/Red', payload: blue });
    expect(await firstPixel(app)).toEqual([0, 0, 255]);
    expect((await app.server.inject('/api/status')).json().stage).toEqual({ scene: 'Red', dirty: false });
  });

  it('rejects an apply value other than true or false', async () => {
    const { app } = await makeApp();
    expect((await app.server.inject({ method: 'PUT', url: '/api/scenes/Red?apply=maybe', payload: blue })).statusCode).toBe(400);
  });

  it('exposes the effect clock so the browser preview can stay in step with the porch', async () => {
    const { app } = await makeApp();
    const a = (await app.server.inject('/api/clock')).json().t;
    await new Promise((r) => setTimeout(r, 30));
    const b = (await app.server.inject('/api/clock')).json().t;
    expect(typeof a).toBe('number');
    expect(b - a).toBeGreaterThan(0.02);
    expect(b - a).toBeLessThan(1);
  });

  it('serves the built web UI at / without requiring the API token, and still protects /api', async () => {
    const webRoot = await mkdtemp(join(tmpdir(), 'xmas-web-'));
    await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Lights</title>');
    const { app } = await makeApp({}, 's3cret', webRoot);
    const page = await app.server.inject('/');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain('<title>Lights</title>');
    expect((await app.server.inject('/api/status')).statusCode).toBe(401);
    expect((await app.server.inject('/api/nope')).statusCode).toBe(401);
  });
});

describe('REST API', () => {
  it('requires the bearer token when one is configured, except for health', async () => {
    const { app } = await makeApp({}, 's3cret');
    expect((await app.server.inject('/api/health')).statusCode).toBe(200);
    expect((await app.server.inject('/api/status')).statusCode).toBe(401);
    expect((await app.server.inject({ url: '/api/status', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    expect((await app.server.inject({ url: '/api/status', headers: { authorization: 'Bearer s3cret' } })).statusCode).toBe(200);
  });

  it('lists effects with parameter specs', async () => {
    const { app } = await makeApp();
    const fx = (await app.server.inject('/api/effects')).json();
    expect(fx.map((e: { id: string }) => e.id)).toContain('rainbow');
    expect(fx.find((e: { id: string }) => e.id === 'solid').params[0].type).toBe('color');
  });

  it('saves, live-edits and activates scenes, persisting to disk', async () => {
    const { app, statePath } = await makeApp();
    const put = await app.server.inject({ method: 'PUT', url: '/api/scenes/Blue', payload: { layers: [{ id: 'x', effect: 'solid', params: { color: '#0000ff' } }] } });
    expect(put.statusCode).toBe(200);
    expect(put.json().layers[0].opacity).toBe(1); // defaults filled in
    expect((await app.server.inject({ method: 'POST', url: '/api/scenes/Blue/activate' })).statusCode).toBe(200);
    expect([...(await app.server.inject('/api/frame')).rawPayload.subarray(0, 3)]).toEqual([0, 0, 255]);
    // edit the active scene → takes effect immediately
    await app.server.inject({ method: 'PUT', url: '/api/scenes/Blue', payload: { layers: [{ id: 'x', effect: 'solid', params: { color: '#00ff00' } }] } });
    expect([...(await app.server.inject('/api/frame')).rawPayload.subarray(0, 3)]).toEqual([0, 255, 0]);
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    expect(saved.activeScene).toBe('Blue');
    expect(saved.scenes.Blue.layers[0].params.color).toBe('#00ff00');
    expect((await app.server.inject({ method: 'DELETE', url: '/api/scenes/Blue' })).statusCode).toBe(409);
  });

  it('rejects invalid scenes and layouts with 400 and keeps running', async () => {
    const { app } = await makeApp();
    const r1 = await app.server.inject({ method: 'PUT', url: '/api/scenes/X', payload: { layers: [{ id: 'x', effect: 'fireworks' }] } });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error).toMatch(/unknown effect/);
    const r2 = await app.server.inject({ method: 'PUT', url: '/api/layout', payload: { controllers: [{ id: 'a', name: 'A', host: 'h', pixelCount: 5 }], runs: [{ id: 'r', controller: 'a', start: 0, count: 9, points: [[0, 0, 0]] }] } });
    expect(r2.statusCode).toBe(400);
    expect((await app.server.inject('/api/status')).json().pixels).toBe(10);
  });

  it('replaces the layout and drops a scene that no longer fits', async () => {
    const { app } = await makeApp({
      scenes: { G: { name: 'G', layers: [{ id: 'l', effect: 'solid', group: 'run:r' }] } },
      activeScene: 'G',
    });
    const r = await app.server.inject({ method: 'PUT', url: '/api/layout', payload: { controllers: [{ id: 'a', name: 'A', host: 'h', pixelCount: 20 }], runs: [{ id: 'other', controller: 'a', start: 0, count: 20, points: [[0, 0, 0]] }] } });
    expect(r.statusCode).toBe(200);
    expect(r.json().pixels).toBe(20);
    expect((await app.server.inject('/api/status')).json().scene).toBe(null);
  });

  it('validates output settings', async () => {
    const { app } = await makeApp();
    expect((await app.server.inject({ method: 'PATCH', url: '/api/output', payload: { brightness: 2 } })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'PATCH', url: '/api/output', payload: { fps: 500 } })).statusCode).toBe(400);
    const ok = await app.server.inject({ method: 'PATCH', url: '/api/output', payload: { brightness: 0.5, fps: 30 } });
    expect(ok.json()).toMatchObject({ brightness: 0.5, fps: 30, enabled: false });
  });

  it('runs discovery and validates preset requests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xmas-'));
    const app = await createApp({
      statePath: join(dir, 's.json'),
      state: { layout: { controllers: [{ id: 'a', name: 'A', host: 'h', pixelCount: 1 }], runs: [] }, scenes: {}, activeScene: null, output: { brightness: 1, gamma: 2.2, fps: 40, enabled: false } },
      discoverFn: async () => [{ host: '192.168.1.50', port: 80, mdnsName: 'wled-left' }],
    });
    cleanups.push(() => app.server.close());
    expect((await app.server.inject({ method: 'POST', url: '/api/controllers/discover' })).json()[0].mdnsName).toBe('wled-left');
    expect((await app.server.inject({ method: 'POST', url: '/api/controllers/zzz/preset', payload: { preset: 1 } })).statusCode).toBe(404);
    expect((await app.server.inject({ method: 'POST', url: '/api/controllers/a/preset', payload: { preset: 0 } })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'POST', url: '/api/controllers/probe', payload: { host: 'http://evil/' } })).statusCode).toBe(400);
  });
});
