import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodePaint } from '@xmas/engine';
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
    output: { brightness: 1, gamma: 1, fps: 40, enabled: false, transition: 0 }, // cut, unless a test is about fades
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

  it('a restart brings back exactly what was on stage, with Blind edits still pending', async () => {
    const { app, statePath } = await makeApp();
    await app.server.inject({ method: 'PUT', url: '/api/scenes/Red?apply=false', payload: blue });
    await app.server.close();
    const state = JSON.parse(await readFile(statePath, 'utf8')) as ShowState;
    const again: App = await createApp({ state, statePath });
    cleanups.push(() => again.server.close());
    expect([...(await again.server.inject('/api/frame')).rawPayload.subarray(0, 3)]).toEqual([255, 0, 0]); // still the staged red
    expect((await again.server.inject('/api/status')).json().stage).toEqual({ scene: 'Red', dirty: true });
    // Go after the restart sends the Blind edits as usual
    await again.server.inject({ method: 'POST', url: '/api/scenes/Red/activate' });
    expect([...(await again.server.inject('/api/frame')).rawPayload.subarray(0, 3)]).toEqual([0, 0, 255]);
  });

  it('GET /api/stage returns the scene the porch is running, even when Blind edits are pending', async () => {
    const { app } = await makeApp();
    await app.server.inject({ method: 'PUT', url: '/api/scenes/Red?apply=false', payload: blue });
    const stage = (await app.server.inject('/api/stage')).json();
    expect(stage.name).toBe('Red');
    expect(stage.layers[0].params.color).toBe('#ff0000');
    await app.server.inject({ method: 'POST', url: '/api/blackout' });
    expect((await app.server.inject('/api/stage')).json()).toEqual({ name: 'Blackout', layers: [] });
  });

  it('a scene saved without defaults filled in is not reported as edited once it is on stage', async () => {
    // Scenes from older configs omit opacity, blend, etc.; the running copy has them filled in.
    const { app } = await makeApp({ scenes: { Bare: { name: 'Bare', layers: [{ id: 'l', effect: 'solid' }] } }, activeScene: 'Bare' });
    expect((await app.server.inject('/api/status')).json().stage).toEqual({ scene: 'Bare', dirty: false });
    await app.server.inject({ method: 'POST', url: '/api/scenes/Bare/activate' });
    expect((await app.server.inject('/api/status')).json().stage).toEqual({ scene: 'Bare', dirty: false });
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

  it('lets browsers keep the hashed UI files forever but always re-check the page itself', async () => {
    const webRoot = await mkdtemp(join(tmpdir(), 'xmas-web-'));
    await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Lights</title>');
    await mkdir(join(webRoot, 'assets'));
    await writeFile(join(webRoot, 'assets', 'index-abc123.js'), 'console.log(1)');
    const { app } = await makeApp({}, undefined, webRoot);
    expect((await app.server.inject('/')).headers['cache-control']).toBe('no-cache');
    expect((await app.server.inject('/assets/index-abc123.js')).headers['cache-control']).toBe('public, max-age=31536000, immutable');
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

describe('playlists and the nightly schedule', () => {
  const scenes = {
    Red: { name: 'Red', layers: [{ id: 'l', effect: 'solid', params: { color: '#ff0000' } }] },
    Blue: { name: 'Blue', layers: [{ id: 'l', effect: 'solid', params: { color: '#0000ff' } }] },
  };
  async function clockApp(over: Partial<ShowState> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'xmas-show-'));
    let now = Date.parse('2026-12-21T20:00:00Z');
    const state: ShowState = {
      layout: { controllers: [{ id: 'a', name: 'A', host: '127.0.0.1', port: 9, pixelCount: 10 }], runs: [{ id: 'r', controller: 'a', start: 0, count: 10, points: [[0, 0, 0], [1, 0, 0]] }] },
      scenes, activeScene: 'Red', output: { brightness: 1, gamma: 1, fps: 40, enabled: false, transition: 0 }, ...over,
    };
    const app = await createApp({ state, statePath: join(dir, 'state.json'), now: () => now });
    cleanups.push(() => app.server.close());
    return { app, state, advance: async (ms: number) => { now += ms; await app.tick(); } };
  }
  const pixel = async (app: App) => [...(await app.server.inject('/api/frame')).rawPayload.subarray(0, 3)];

  it('keeps a playlist’s shuffle setting (and leaves it off unless asked)', async () => {
    const { app } = await clockApp();
    const on = await app.server.inject({ method: 'PUT', url: '/api/playlists/Mix', payload: { entries: [{ scene: 'Blue', seconds: 60 }, { scene: 'Red', seconds: 30 }], shuffle: true } });
    expect(on.json()).toMatchObject({ shuffle: true, loop: true });
    const off = await app.server.inject({ method: 'PUT', url: '/api/playlists/Plain', payload: { entries: [{ scene: 'Blue', seconds: 60 }] } });
    expect(off.json()).not.toHaveProperty('shuffle');
  });

  it('plays a playlist, moving through scenes on time and looping; Go stops it', async () => {
    const { app, advance } = await clockApp();
    const put = await app.server.inject({ method: 'PUT', url: '/api/playlists/Evening', payload: { entries: [{ scene: 'Blue', seconds: 60 }, { scene: 'Red', seconds: 30 }], loop: true } });
    expect(put.statusCode).toBe(200);
    expect((await app.server.inject({ method: 'POST', url: '/api/playlists/Evening/play' })).statusCode).toBe(200);
    await advance(0);
    expect(await pixel(app)).toEqual([0, 0, 255]);
    await advance(61_000);
    expect(await pixel(app)).toEqual([255, 0, 0]);
    expect((await app.server.inject('/api/status')).json().playlist).toMatchObject({ name: 'Evening', index: 1, scene: 'Red' });
    await advance(30_000);
    expect(await pixel(app)).toEqual([0, 0, 255]); // looped
    await app.server.inject({ method: 'POST', url: '/api/scenes/Red/activate' }); // manual Go
    await advance(120_000);
    expect(await pixel(app)).toEqual([255, 0, 0]);
    expect((await app.server.inject('/api/status')).json().playlist).toBe(null);
  });

  it('validates playlists', async () => {
    const { app } = await clockApp();
    const bad = (payload: unknown) => app.server.inject({ method: 'PUT', url: '/api/playlists/X', payload });
    expect((await bad({ entries: [] })).statusCode).toBe(400);
    expect((await bad({ entries: [{ scene: 'Nope', seconds: 10 }] })).statusCode).toBe(400);
    expect((await bad({ entries: [{ scene: 'Red', seconds: 0 }] })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'POST', url: '/api/playlists/Nope/play' })).statusCode).toBe(404);
  });

  it('turns the lights on at the on time and hands the porch back at the off time, every night', async () => {
    const { app, state, advance } = await clockApp();
    // 21:00 to 23:00 UTC, running the Blue scene. It's 20:00 now, so nothing happens yet.
    const r = await app.server.inject({ method: 'PUT', url: '/api/schedule', payload: { enabled: true, timezone: 'UTC', on: { kind: 'time', time: '21:00' }, off: { kind: 'time', time: '23:00' }, run: { kind: 'scene', name: 'Blue' } } });
    expect(r.statusCode).toBe(200);
    await advance(30 * 60_000);
    expect(state.output.enabled).toBe(false);
    expect((await app.server.inject('/api/status')).json().schedule).toMatchObject({ enabled: true, active: false });
    await advance(31 * 60_000); // 21:01
    expect(state.output.enabled).toBe(true);
    expect(app.output.running).toBe(true);
    expect(await pixel(app)).toEqual([0, 0, 255]);
    // A manual change during the evening isn't undone by the schedule.
    await app.server.inject({ method: 'POST', url: '/api/scenes/Red/activate' });
    await advance(60 * 60_000); // 22:01
    expect(await pixel(app)).toEqual([255, 0, 0]);
    await advance(60 * 60_000); // 23:01: off
    expect(state.output.enabled).toBe(false);
    expect(app.output.running).toBe(false);
    await advance(22 * 3600_000); // 21:01 next day: on again
    expect(state.output.enabled).toBe(true);
    await app.output.stopStreaming(false);
  });

  it('enabling the schedule during the on window starts the show straight away; validates its settings', async () => {
    const { app, state, advance } = await clockApp();
    await app.server.inject({ method: 'PUT', url: '/api/schedule', payload: { enabled: true, timezone: 'UTC', on: { kind: 'time', time: '19:00' }, off: { kind: 'time', time: '23:00' }, run: { kind: 'scene', name: 'Blue' } } });
    await advance(0);
    expect(state.output.enabled).toBe(true);
    await app.output.stopStreaming(false);
    const bad = (payload: unknown) => app.server.inject({ method: 'PUT', url: '/api/schedule', payload });
    expect((await bad({ enabled: true, timezone: 'Mars/Olympus', on: { kind: 'time', time: '19:00' }, off: { kind: 'time', time: '23:00' }, run: { kind: 'scene', name: 'Blue' } })).statusCode).toBe(400);
    expect((await bad({ enabled: true, timezone: 'UTC', on: { kind: 'sunset' }, off: { kind: 'time', time: '23:00' }, run: { kind: 'scene', name: 'Blue' } })).statusCode).toBe(400); // sunset needs a location
    expect((await bad({ enabled: true, timezone: 'UTC', on: { kind: 'time', time: '25:00' }, off: { kind: 'time', time: '23:00' }, run: { kind: 'scene', name: 'Blue' } })).statusCode).toBe(400);
    expect((await bad({ enabled: true, timezone: 'UTC', on: { kind: 'time', time: '19:00' }, off: { kind: 'time', time: '23:00' }, run: { kind: 'playlist', name: 'Nope' } })).statusCode).toBe(400);
  });
});

describe('backup and restore', () => {
  it('downloads everything as one file and restores it, saving the current state first', async () => {
    const { app, statePath } = await makeApp();
    await app.server.inject({ method: 'PUT', url: '/api/presets/Look', payload: { effect: 'solid' } });
    const backup = await app.server.inject('/api/backup');
    expect(backup.statusCode).toBe(200);
    expect(backup.headers['content-disposition']).toMatch(/attachment; filename="xmas-lights-backup-\d{4}-\d{2}-\d{2}\.json"/);
    const data = backup.json();
    expect(data.scenes.Red).toBeTruthy();
    expect(data.presets.Look).toBeTruthy();
    // Change things, then restore the backup.
    await app.server.inject({ method: 'PUT', url: '/api/scenes/Green', payload: { layers: [{ id: 'l', effect: 'solid', params: { color: '#00ff00' } }] } });
    await app.server.inject({ method: 'DELETE', url: '/api/presets/Look' });
    const r = await app.server.inject({ method: 'POST', url: '/api/restore', payload: data });
    expect(r.statusCode).toBe(200);
    expect(r.json().savedFirst).toMatch(/^before-restore-/);
    expect((await app.server.inject('/api/scenes')).json().scenes.map((x: { name: string }) => x.name)).toEqual(['Red']);
    expect((await app.server.inject('/api/presets')).json()).toHaveLength(1);
    expect(JSON.parse(await readFile(statePath, 'utf8')).scenes.Green).toBeUndefined();
    // The automatic copy made before restoring still has Green, and can itself be restored.
    const list = (await app.server.inject('/api/backups')).json();
    const before = list.find((b: { file: string }) => b.file.startsWith('before-restore-'));
    expect(before).toBeTruthy();
    await app.server.inject({ method: 'POST', url: `/api/backups/${before.file}/restore` });
    expect((await app.server.inject('/api/scenes')).json().scenes.map((x: { name: string }) => x.name)).toContain('Green');
  });

  it('rejects a restore that is not a valid show, and leaves everything as it was', async () => {
    const { app } = await makeApp();
    expect((await app.server.inject({ method: 'POST', url: '/api/restore', payload: { hello: 'world' } })).statusCode).toBe(400);
    const badLayout = { ...(await app.server.inject('/api/backup')).json(), layout: { controllers: [], runs: [{ id: 'r', controller: 'nope', start: 0, count: 1, points: [[0, 0, 0]] }] } };
    expect((await app.server.inject({ method: 'POST', url: '/api/restore', payload: badLayout })).statusCode).toBe(400);
    expect((await app.server.inject('/api/status')).json().pixels).toBe(10);
    expect((await app.server.inject('/api/backups/../../etc/passwd/restore')).statusCode).toBe(404);
  });

  it('keeps one automatic backup per day, and only the last 14', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xmas-bak-'));
    let now = Date.parse('2026-12-01T12:00:00Z');
    const state: ShowState = {
      layout: { controllers: [{ id: 'a', name: 'A', host: '127.0.0.1', port: 9, pixelCount: 1 }], runs: [] },
      scenes: {}, activeScene: null, output: { brightness: 1, gamma: 1, fps: 40, enabled: false },
    };
    const app = await createApp({ state, statePath: join(dir, 'state.json'), now: () => now });
    cleanups.push(() => app.server.close());
    for (let d = 0; d < 20; d++) { await app.tick(); await app.tick(); now += 86_400_000; }
    const daily = (await app.server.inject('/api/backups')).json().filter((b: { file: string }) => b.file.startsWith('daily-'));
    expect(daily).toHaveLength(14);
    expect(daily[0].file).toBe('daily-2026-12-20.json'); // newest first
  });
});

describe('crossfade on Go', () => {
  it('Go fades over output.transition seconds; 0 cuts; the setting is validated and saved', async () => {
    const { app } = await makeApp({
      scenes: { Red: { name: 'Red', layers: [{ id: 'l', effect: 'solid', params: { color: '#ff0000' } }] }, Blue: { name: 'Blue', layers: [{ id: 'l', effect: 'solid', params: { color: '#0000ff' } }] } },
      output: { brightness: 1, gamma: 1, fps: 40, enabled: false }, // no transition saved: the default applies
    });
    const px = async () => [...(await app.server.inject('/api/frame')).rawPayload.subarray(0, 3)];
    expect((await app.server.inject('/api/output')).json().transition).toBe(1); // default
    await px();
    await app.server.inject({ method: 'POST', url: '/api/scenes/Blue/activate' });
    expect(await px()).toEqual([255, 0, 0]); // first frame of the fade is still the old scene
    await new Promise((r) => setTimeout(r, 1100));
    expect(await px()).toEqual([0, 0, 255]);
    expect((await app.server.inject({ method: 'PATCH', url: '/api/output', payload: { transition: 0 } })).json().transition).toBe(0);
    await app.server.inject({ method: 'POST', url: '/api/scenes/Red/activate' });
    expect(await px()).toEqual([255, 0, 0]); // cut
    expect((await app.server.inject({ method: 'PATCH', url: '/api/output', payload: { transition: 60 } })).statusCode).toBe(400);
  });
});

describe('identify a run on the porch', () => {
  const twoRuns = (port: number) => ({
    layout: {
      controllers: [{ id: 'a', name: 'A', host: '127.0.0.1', port, pixelCount: 20 }],
      runs: [
        { id: 'left', controller: 'a', start: 0, count: 10, points: [[0, 0, 0], [1, 0, 0]] as [number, number, number][] },
        { id: 'right', controller: 'a', start: 10, count: 10, points: [[2, 0, 0], [3, 0, 0]] as [number, number, number][] },
      ],
    },
  });

  it('flashes only the chosen run while streaming, then returns to the scene', async () => {
    const rx = await fakeDdpReceiver(20);
    cleanups.push(rx.close);
    const { app } = await makeApp(twoRuns(rx.port));
    app.output.startStreaming();
    const r = await app.server.inject({ method: 'POST', url: '/api/identify', payload: { run: 'right', seconds: 0.4 } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ run: 'right', streaming: true });
    await new Promise((res) => setTimeout(res, 300));
    const during = rx.frames.at(-1)!.data;
    expect([...during.subarray(0, 3)]).toEqual([0, 0, 0]); // left run dark
    expect(Math.max(...during.subarray(30, 60))).toBeGreaterThan(0); // right run lit (white pulse)
    expect(during[30]).toBe(during[31]); // white: r == g == b
    await new Promise((res) => setTimeout(res, 400));
    await app.output.stopStreaming(false);
    await new Promise((res) => setTimeout(res, 50));
    const after = rx.frames.at(-1)!.data;
    expect([...after.subarray(0, 3)]).toEqual([255, 0, 0]); // back to the red scene
  });

  it('can be cancelled, rejects unknown runs, and says when streaming is off', async () => {
    const { app } = await makeApp(twoRuns(9));
    expect((await app.server.inject({ method: 'POST', url: '/api/identify', payload: { run: 'nope' } })).statusCode).toBe(404);
    const off = await app.server.inject({ method: 'POST', url: '/api/identify', payload: { run: 'left' } });
    expect(off.json()).toMatchObject({ run: 'left', streaming: false });
    expect((await app.server.inject({ method: 'POST', url: '/api/identify', payload: { run: null } })).json()).toMatchObject({ run: null });
    expect((await app.server.inject({ method: 'POST', url: '/api/identify', payload: { run: 'left', seconds: 999 } })).statusCode).toBe(400);
  });
});

describe('house model (3D scan parts)', () => {
  // The 12-byte glTF binary header: magic "glTF", version 2, total length.
  const glb = (extra = 0) => { const b = Buffer.alloc(12 + extra); b.write('glTF', 0); b.writeUInt32LE(2, 4); b.writeUInt32LE(12 + extra, 8); return b; };
  const upload = (app: App, name: string, body: Buffer) =>
    app.server.inject({ method: 'POST', url: `/api/house/parts?name=${encodeURIComponent(name)}`, payload: body, headers: { 'content-type': 'model/gltf-binary' } });

  it('uploads several scan parts, serves each, and deletes them, with files next to the state file', async () => {
    const { app, statePath } = await makeApp();
    expect((await app.server.inject('/api/house')).json().parts).toEqual([]);
    const a = await upload(app, 'Left half', glb(100));
    const b = await upload(app, 'Right half', glb(50));
    expect(a.statusCode).toBe(200);
    const parts = (await app.server.inject('/api/house')).json().parts;
    expect(parts.map((p: { name: string; bytes: number }) => [p.name, p.bytes])).toEqual([['Left half', 112], ['Right half', 62]]);
    const id = a.json().id as string;
    const got = await app.server.inject(`/api/house/parts/${id}/model`);
    expect(got.headers['content-type']).toBe('model/gltf-binary');
    expect(got.rawPayload.length).toBe(112);
    expect(await readFile(join(dirname(statePath), `house-${id}.glb`))).toHaveLength(112);
    expect((await app.server.inject({ method: 'DELETE', url: `/api/house/parts/${id}` })).statusCode).toBe(200);
    expect((await app.server.inject(`/api/house/parts/${id}/model`)).statusCode).toBe(404);
    expect((await app.server.inject('/api/house')).json().parts).toHaveLength(1);
    expect(b.json().id).not.toBe(id);
  });

  it('rejects files that are not binary glTF', async () => {
    const { app } = await makeApp();
    expect((await upload(app, 'x', Buffer.from('not a model at all'))).statusCode).toBe(400);
  });

  it('aligns the whole house and each part separately, validated and saved', async () => {
    const { app, statePath } = await makeApp();
    const id = (await upload(app, 'Scan', glb())).json().id;
    const h = await app.server.inject({ method: 'PATCH', url: '/api/house', payload: { position: [1, 0, -2], rotation: 90, scale: 1.02, opacity: 0.6 } });
    expect(h.json()).toMatchObject({ position: [1, 0, -2], rotation: 90, scale: 1.02, opacity: 0.6 });
    const p = await app.server.inject({ method: 'PATCH', url: `/api/house/parts/${id}`, payload: { name: 'Front', position: [0.5, 0, 0], rotation: -3, scale: 0.99, visible: false } });
    expect(p.json()).toMatchObject({ name: 'Front', position: [0.5, 0, 0], rotation: 357, scale: 0.99, visible: false });
    const saved = JSON.parse(await readFile(statePath, 'utf8')).house;
    expect(saved.rotation).toBe(90);
    expect(saved.parts[0].name).toBe('Front');
    expect((await app.server.inject({ method: 'PATCH', url: '/api/house', payload: { scale: 0 } })).statusCode).toBe(400);
    expect((await app.server.inject('/api/house')).json().glow).toBe(1); // on by default
    const off = await app.server.inject({ method: 'PATCH', url: '/api/house', payload: { glow: 0 } });
    expect(off.json()).toMatchObject({ glow: 0, opacity: 0.6 });
    expect(JSON.parse(await readFile(statePath, 'utf8')).house.glow).toBe(0);
    expect((await app.server.inject({ method: 'PATCH', url: '/api/house', payload: { glow: 4 } })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'PATCH', url: '/api/house', payload: { glow: 'bright' } })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'PATCH', url: `/api/house/parts/${id}`, payload: { position: [1, 2] } })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'PATCH', url: '/api/house/parts/nope', payload: { scale: 1 } })).statusCode).toBe(404);
  });

  it('turns a single model from before parts existed into the first part', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xmas-house-'));
    await writeFile(join(dir, 'house.glb'), glb(8));
    const statePath = join(dir, 'state.json');
    const state = { layout: { controllers: [{ id: 'a', name: 'A', host: '127.0.0.1', port: 9, pixelCount: 1 }], runs: [] }, scenes: {}, activeScene: null,
      output: { brightness: 1, gamma: 1, fps: 40, enabled: false }, house: { position: [0, 0, 0], rotation: 5, scale: 1, opacity: 0.8, model: { bytes: 20, uploadedAt: 'x' } } } as unknown as ShowState;
    const app = await createApp({ state, statePath });
    cleanups.push(() => app.server.close());
    const house = (await app.server.inject('/api/house')).json();
    expect(house.rotation).toBe(5);
    expect(house.glow).toBe(1); // saved before the glow setting existed: on by default
    expect(house.parts).toHaveLength(1);
    expect((await app.server.inject(`/api/house/parts/${house.parts[0].id}/model`)).rawPayload.length).toBe(20);
  });
});

describe('layer presets', () => {
  const look = { effect: 'twinkle', params: { color: '#ffd080', density: 0.4 }, blend: 'screen', opacity: 0.8, group: 'all' };

  it('saves, lists, reads and deletes presets, persisting them', async () => {
    const { app, statePath } = await makeApp();
    const put = await app.server.inject({ method: 'PUT', url: '/api/presets/Warm%20sparkle', payload: look });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ name: 'Warm sparkle', effect: 'twinkle', blend: 'screen', opacity: 0.8 });
    expect(put.json().params.speed).toBe(0.6); // defaults filled in
    expect((await app.server.inject('/api/presets')).json().map((p: { name: string }) => p.name)).toEqual(['Warm sparkle']);
    expect((await app.server.inject('/api/presets/Warm%20sparkle')).json().params.color).toBe('#ffd080');
    expect(JSON.parse(await readFile(statePath, 'utf8')).presets['Warm sparkle'].effect).toBe('twinkle');
    expect((await app.server.inject({ method: 'DELETE', url: '/api/presets/Warm%20sparkle' })).statusCode).toBe(200);
    expect((await app.server.inject('/api/presets')).json()).toEqual([]);
    expect((await app.server.inject({ method: 'DELETE', url: '/api/presets/nope' })).statusCode).toBe(404);
  });

  it('rejects presets with an unknown effect, bad params or a bad name', async () => {
    const { app } = await makeApp();
    expect((await app.server.inject({ method: 'PUT', url: '/api/presets/X', payload: { effect: 'nope' } })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'PUT', url: '/api/presets/X', payload: { effect: 'solid', params: { color: 'blue' } } })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'PUT', url: '/api/presets/X', payload: { ...look, opacity: 3 } })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'PUT', url: `/api/presets/${'x'.repeat(81)}`, payload: look })).statusCode).toBe(400);
  });

  it('a preset does not depend on the layout: an unknown group falls back to all lights', async () => {
    const { app } = await makeApp();
    const put = await app.server.inject({ method: 'PUT', url: '/api/presets/Y', payload: { ...look, group: 'run:gone' } });
    expect(put.statusCode).toBe(200);
    expect(put.json().group).toBe('all');
  });

  it('works with a state file from before presets existed', async () => {
    const { app } = await makeApp({ presets: undefined });
    expect((await app.server.inject('/api/presets')).json()).toEqual([]);
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

describe('painted layers', () => {
  const painted = (paint: string) => ({ layers: [{ id: 'paint', effect: 'solid', params: { color: '#00ff00' }, paint }] });

  it('are saved with the scene, show on stage after a Live save, and stay out of presets', async () => {
    const { app } = await makeApp();
    const onlyFirst = encodePaint(Uint8Array.from([255]));
    const saved = await app.server.inject({ method: 'PUT', url: '/api/scenes/Red', payload: painted(onlyFirst) });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().layers[0].paint).toBe(onlyFirst);
    await app.server.inject({ method: 'POST', url: '/api/scenes/Red/activate' });
    await app.server.inject({ method: 'PUT', url: '/api/scenes/Red', payload: painted(encodePaint(Uint8Array.from([0, 255]))) }); // a Live stroke
    const frame = (await app.server.inject('/api/frame')).rawPayload;
    expect(frame[1]).toBe(0);
    expect(frame[4]).toBeGreaterThan(0);
    expect(frame[7]).toBe(0);
    expect((await app.server.inject({ method: 'PUT', url: '/api/scenes/Red', payload: painted('not paint') })).statusCode).toBe(400);
    const preset = await app.server.inject({ method: 'PUT', url: '/api/presets/Green', payload: { effect: 'solid', paint: onlyFirst } });
    expect('paint' in preset.json()).toBe(false);
  });
});
