/** Regression tests for bugs found in the November 2026 audit. */
import { chmod, mkdtemp, readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLayout, type LayoutConfig } from '@xmas/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/api.js';
import { saveState, type ShowState } from '../src/store.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const scenes = () => ({
  Red: { name: 'Red', layers: [{ id: 'l', effect: 'solid', params: { color: '#ff0000' } }] },
  Blue: { name: 'Blue', layers: [{ id: 'l', effect: 'solid', params: { color: '#0000ff' } }] },
});
const layout = (): LayoutConfig => ({
  controllers: [{ id: 'a', name: 'A', host: '127.0.0.1', port: 9, pixelCount: 20 }],
  runs: [{ id: 'r', controller: 'a', start: 0, count: 10, points: [[0, 0, 0], [1, 0, 0]] }],
});
const baseState = (over: Partial<ShowState> = {}): ShowState => ({
  layout: layout(), scenes: scenes(), activeScene: 'Red',
  output: { brightness: 1, gamma: 1, fps: 40, enabled: false, transition: 0 }, ...over,
});

/** An app on a clock the test moves. `restart` starts a second server from the saved file, as after a reboot. */
async function clockApp(startAt: string, over: Partial<ShowState> = {}, apiToken?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'xmas-reg-'));
  const statePath = join(dir, 'state.json');
  let now = Date.parse(startAt);
  const start = async (state: ShowState) => {
    const app = await createApp({ state, statePath, apiToken, now: () => now });
    cleanups.push(async () => { await app.output.stopStreaming(false); await app.server.close(); });
    return { app, state };
  };
  const first = await start(baseState(over));
  return {
    ...first, statePath,
    setNow: (iso: string) => { now = Date.parse(iso); },
    restart: async (edit: (s: ShowState) => void = () => {}) => {
      const state = JSON.parse(await readFile(statePath, 'utf8')) as ShowState;
      edit(state);
      return start(state);
    },
  };
}
const put = (app: App, url: string, payload: unknown) => app.server.inject({ method: 'PUT', url, payload: payload as object });
const post = (app: App, url: string, payload?: unknown) => app.server.inject({ method: 'POST', url, ...(payload !== undefined && { payload: payload as object }) });
const nightly = { enabled: true, timezone: 'UTC', on: { kind: 'time', time: '21:00' }, off: { kind: 'time', time: '23:00' }, run: { kind: 'scene', name: 'Blue' } };

describe('saving the show', () => {
  it('a save that fails does not stop later saves', async () => {
    if (process.getuid?.() === 0) return; // root ignores directory permissions
    const dir = join(await mkdtemp(join(tmpdir(), 'xmas-save-')), 'data');
    const path = join(dir, 'state.json');
    await saveState(path, baseState());
    await chmod(dir, 0o500);
    await expect(saveState(path, baseState())).rejects.toThrow();
    await chmod(dir, 0o700);
    await saveState(path, baseState({ activeScene: 'Blue' }));
    expect(JSON.parse(await readFile(path, 'utf8')).activeScene).toBe('Blue');
  });
});

describe('the schedule across a restart', () => {
  it('switches the lights on if the on time passed while the server was down', async () => {
    const a = await clockApp('2026-12-21T20:00:00Z');
    expect((await put(a.app, '/api/schedule', nightly)).statusCode).toBe(200);
    await a.app.tick(); // 20:00, before the window
    a.setNow('2026-12-21T21:30:00Z');
    const b = await a.restart();
    await b.app.tick();
    expect(b.state.output.enabled).toBe(true);
    expect(b.app.output.running).toBe(true);
    expect(b.state.activeScene).toBe('Blue');
  });

  it('switches them off if the off time passed while the server was down', async () => {
    const a = await clockApp('2026-12-21T20:00:00Z');
    await put(a.app, '/api/schedule', nightly);
    await a.app.tick();
    a.setNow('2026-12-21T21:01:00Z');
    await a.app.tick();
    expect(a.state.output.enabled).toBe(true);
    await a.app.output.stopStreaming(false);
    a.setNow('2026-12-22T02:00:00Z');
    const b = await a.restart();
    await b.app.tick();
    expect(b.state.output.enabled).toBe(false);
    expect(b.app.output.running).toBe(false);
  });

  it('leaves a manual choice alone when it restarts inside the same window', async () => {
    const a = await clockApp('2026-12-21T20:00:00Z');
    await put(a.app, '/api/schedule', nightly);
    await a.app.tick();
    a.setNow('2026-12-21T21:01:00Z');
    await a.app.tick();
    // The owner turns streaming off by hand at 21:05.
    await a.app.server.inject({ method: 'PATCH', url: '/api/output', payload: { enabled: false } });
    a.setNow('2026-12-21T21:30:00Z');
    const b = await a.restart();
    await b.app.tick();
    expect(b.state.output.enabled).toBe(false);
  });

  it('still switches on when the scene it names no longer fits the layout', async () => {
    const a = await clockApp('2026-12-21T20:00:00Z');
    await put(a.app, '/api/schedule', nightly);
    await a.app.tick();
    a.state.scenes.Blue = { name: 'Blue', layers: [{ id: 'l', effect: 'solid', group: 'gone' }] };
    a.setNow('2026-12-21T21:01:00Z');
    await a.app.tick();
    expect(a.app.output.running).toBe(true);
    expect(a.state.activeScene).toBe('Red');
  });
});

describe('scenes that playlists and the schedule use', () => {
  it('renaming a scene keeps playlists, the schedule and the stage pointing at it', async () => {
    const { app, state } = await clockApp('2026-12-21T12:00:00Z');
    await put(app, '/api/playlists/Evening', { entries: [{ scene: 'Red', seconds: 10 }, { scene: 'Blue', seconds: 10 }] });
    await put(app, '/api/schedule', { ...nightly, run: { kind: 'scene', name: 'Red' } });
    const r = await post(app, '/api/scenes/Red/rename', { to: 'Crimson' });
    expect(r.statusCode).toBe(200);
    expect(Object.keys(state.scenes)).toEqual(['Crimson', 'Blue']); // keeps its place
    expect(state.scenes.Crimson!.name).toBe('Crimson');
    expect(state.playlists!.Evening!.entries.map((e) => e.scene)).toEqual(['Crimson', 'Blue']);
    expect(state.schedule!.run.name).toBe('Crimson');
    // It was on stage: still is, under its new name, and not flagged as edited.
    expect((await app.server.inject('/api/status')).json().stage).toEqual({ scene: 'Crimson', dirty: false });
    expect((await app.server.inject('/api/stage')).json().name).toBe('Crimson');
  });

  it('rejects a rename onto an existing or unusable name', async () => {
    const { app } = await clockApp('2026-12-21T12:00:00Z');
    expect((await post(app, '/api/scenes/Red/rename', { to: 'Blue' })).statusCode).toBe(409);
    expect((await post(app, '/api/scenes/Red/rename', { to: '  ' })).statusCode).toBe(400);
    expect((await post(app, '/api/scenes/Red/rename', { to: '__proto__' })).statusCode).toBe(400);
    expect((await post(app, '/api/scenes/Nope/rename', { to: 'X' })).statusCode).toBe(404);
    expect((await put(app, '/api/scenes/__proto__', { layers: [] })).statusCode).toBe(400);
  });

  it('refuses to delete a scene a playlist or the schedule uses, and a playlist the schedule plays', async () => {
    const { app } = await clockApp('2026-12-21T12:00:00Z');
    await put(app, '/api/playlists/Evening', { entries: [{ scene: 'Blue', seconds: 10 }] });
    const del = await app.server.inject({ method: 'DELETE', url: '/api/scenes/Blue' });
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toContain('the playlist "Evening"');
    await put(app, '/api/schedule', { ...nightly, run: { kind: 'playlist', name: 'Evening' } });
    expect((await app.server.inject({ method: 'DELETE', url: '/api/playlists/Evening' })).statusCode).toBe(409);
    await put(app, '/api/schedule', { ...nightly, run: { kind: 'scene', name: 'Red' } });
    expect((await app.server.inject({ method: 'DELETE', url: '/api/playlists/Evening' })).statusCode).toBe(200);
    expect((await app.server.inject({ method: 'DELETE', url: '/api/scenes/Blue' })).statusCode).toBe(200);
  });
});

describe('output settings', () => {
  it('rejects values that are not numbers, and changes nothing when any value is bad', async () => {
    const { app, state } = await clockApp('2026-12-21T12:00:00Z');
    const patch = (payload: object) => app.server.inject({ method: 'PATCH', url: '/api/output', payload });
    expect((await patch({ brightness: null })).statusCode).toBe(400);
    expect((await patch({ brightness: '0.5' })).statusCode).toBe(400);
    expect((await patch({ gamma: '2' })).statusCode).toBe(400);
    expect((await patch({ brightness: 0.4, fps: 999 })).statusCode).toBe(400);
    expect((await patch({ brightness: 0.4, transition: 'slow' })).statusCode).toBe(400);
    expect((await app.server.inject('/api/output')).json()).toMatchObject({ brightness: 1, fps: 40 });
    expect(state.output.brightness).toBe(1);
  });
});

describe('layout checks', () => {
  it('rejects two runs with the same id', () => {
    const l = layout();
    l.runs.push({ id: 'r', controller: 'a', start: 10, count: 10, points: [[0, 1, 0], [1, 1, 0]] });
    expect(() => buildLayout(l)).toThrow(/duplicate run id/);
  });
  it('rejects a group that would replace "all" or a run group', () => {
    expect(() => buildLayout({ ...layout(), groups: { all: { pixels: [0] } } })).toThrow(/group name/);
    expect(() => buildLayout({ ...layout(), groups: { 'run:r': { pixels: [0] } } })).toThrow(/group name/);
  });
  it('rejects a start or count that is not a whole number', () => {
    const l = layout();
    l.runs[0]!.count = 2.5;
    expect(() => buildLayout(l)).toThrow(/whole numbers/);
  });
});

describe('signing in from the web UI', () => {
  it('accepts the cookie /api/login sets, as well as the bearer header', async () => {
    const { app } = await clockApp('2026-12-21T12:00:00Z', {}, 's3cret token');
    expect((await app.server.inject('/api/status')).statusCode).toBe(401);
    expect((await post(app, '/api/login', { token: 'wrong' })).statusCode).toBe(401);
    const login = await post(app, '/api/login', { token: 's3cret token' });
    expect(login.statusCode).toBe(200);
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const cookie = setCookie.split(';')[0]!;
    expect((await app.server.inject({ url: '/api/status', headers: { cookie: `other=1; ${cookie}` } })).statusCode).toBe(200);
    expect((await app.server.inject({ url: '/api/status', headers: { cookie: 'xmas_token=nope' } })).statusCode).toBe(401);
    expect((await app.server.inject({ url: '/api/status', headers: { authorization: 'Bearer s3cret token' } })).statusCode).toBe(200);
  });
  it('says no token is needed when none is set', async () => {
    const { app } = await clockApp('2026-12-21T12:00:00Z');
    expect((await post(app, '/api/login', {})).json()).toEqual({ ok: true, required: false });
  });
});

describe('telling other tabs and devices about changes', () => {
  it('counts changes and names the browser that made the last one', async () => {
    const { app } = await clockApp('2026-12-21T12:00:00Z');
    const rev = async () => (await app.server.inject('/api/status')).json().rev as { boot: string; n: number; by: string };
    const before = await rev();
    await app.server.inject({ method: 'PUT', url: '/api/scenes/Red?apply=false', payload: { layers: [] }, headers: { 'x-client-id': 'tablet' } });
    await new Promise((r) => setTimeout(r, 20)); // counted once the response has gone out
    const after = await rev();
    expect(after.boot).toBe(before.boot);
    expect(after.n).toBe(before.n + 1);
    expect(after.by).toBe('tablet');
    // Reading, and requests that fail, don't count.
    await app.server.inject({ method: 'PUT', url: '/api/scenes/Red', payload: { layers: [{ id: 'x', effect: 'nope' }] } });
    await new Promise((r) => setTimeout(r, 20));
    expect((await rev()).n).toBe(after.n);
  });
});

describe('handing the porch back to WLED', () => {
  it('tries again when the first request fails, and reports it if that fails too', async () => {
    let calls = 0, failFirst = 1;
    const wled = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => { calls++; res.statusCode = calls <= failFirst ? 500 : 200; res.setHeader('content-type', 'application/json'); res.end('{}'); });
    });
    await new Promise<void>((r) => wled.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => wled.close(() => r(undefined))));
    const l = layout();
    l.controllers[0]!.host = `127.0.0.1:${(wled.address() as AddressInfo).port}`;
    l.controllers[0]!.fallbackPreset = 3;
    const { app } = await clockApp('2026-12-21T12:00:00Z', { layout: l });
    const warnings: string[] = [];
    app.output.onWarn = (m) => warnings.push(m);
    await app.output.stopStreaming();
    expect(calls).toBe(2);
    expect(warnings).toEqual([]);
    calls = 0; failFirst = 99;
    await app.output.stopStreaming();
    expect(calls).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('could not hand controller "a"');
  });
});

// ---- second audit (2026-11-25) ------------------------------------------------------------------
describe('shuffled playlists that run for a long time', () => {
  it('work out the order of a far-off round without walking through every round before it', async () => {
    const { playlistPosition, shuffledOrder } = await import('../src/show.js');
    for (const count of [2, 3, 6, 16]) {
      const order = shuffledOrder(count, 1795566363003, 5_000_000);
      expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, i) => i));
    }
    // A month of one-minute rounds.
    const entries = [{ scene: 'a', seconds: 20 }, { scene: 'b', seconds: 20 }, { scene: 'c', seconds: 20 }];
    expect(() => playlistPosition(entries, 0, 30 * 86_400_000, true, true)).not.toThrow();
  });
  it('never start a round with the scene the last round ended on, two scenes included', async () => {
    const { shuffledOrder } = await import('../src/show.js');
    for (const count of [2, 3, 4, 7]) {
      for (let c = 1; c < 300; c++) expect(shuffledOrder(count, 1234, c)[0]).not.toBe(shuffledOrder(count, 1234, c - 1)[count - 1]);
    }
  });
});

describe('mapping data on the server', () => {
  const view = { width: 100, height: 50, detections: [{ pixel: 1, x: 10, y: 10 }] };
  it('a failed save of the spots does not stop later saves', async () => {
    if (process.getuid?.() === 0) return;
    const { app, statePath } = await clockApp('2026-12-21T12:00:00Z');
    const dir = join(statePath, '..');
    expect((await post(app, '/api/mapping/views', view)).statusCode).toBe(200);
    await chmod(dir, 0o500);
    expect((await post(app, '/api/mapping/views', view)).statusCode).toBe(500);
    await chmod(dir, 0o700);
    expect((await post(app, '/api/mapping/views', view)).statusCode).toBe(200);
    expect(JSON.parse(await readFile(join(dir, 'mapping-views.json'), 'utf8'))).toHaveLength(3);
  });
  it('recordings can be listed, downloaded and deleted, by safe names only', async () => {
    const { app } = await clockApp('2026-12-21T12:00:00Z');
    const body = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const up = await app.server.inject({ method: 'POST', url: '/api/mapping/recordings?view=v1&label=Spot%201&gz=0', payload: body, headers: { 'content-type': 'application/octet-stream' } });
    expect(up.statusCode).toBe(200);
    const file = up.json().saved as string;
    const got = await app.server.inject(`/api/mapping/recordings/${file}`);
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(body)).toBe(true);
    expect((await app.server.inject('/api/mapping/recordings/..%2Fstate.json')).statusCode).toBe(404);
    expect((await app.server.inject({ method: 'DELETE', url: `/api/mapping/recordings/${file}` })).statusCode).toBe(200);
    expect((await app.server.inject('/api/mapping/recordings')).json()).toEqual([]);
    await app.server.inject({ method: 'POST', url: '/api/mapping/recordings?gz=0', payload: body, headers: { 'content-type': 'application/octet-stream' } });
    expect((await app.server.inject({ method: 'DELETE', url: '/api/mapping/recordings' })).json()).toEqual({ deleted: 1 });
  });
});

describe('backups', () => {
  it('a manual backup only clears out old backups of its own kind', async () => {
    const a = await clockApp('2026-12-01T12:00:00Z');
    for (let d = 1; d <= 3; d++) { a.setNow(`2026-12-0${d}T12:00:00Z`); await post(a.app, '/api/backups', { reason: 'before-mapping' }); }
    for (let d = 1; d <= 12; d++) { a.setNow(`2026-12-${String(d + 3).padStart(2, '0')}T12:00:00Z`); await post(a.app, '/api/backups', { reason: 'before' }); }
    const files = ((await a.app.server.inject('/api/backups')).json() as { file: string }[]).map((b) => b.file);
    expect(files.filter((f) => f.startsWith('before-mapping-'))).toHaveLength(3);
    expect(files.filter((f) => /^before-\d/.test(f))).toHaveLength(10);
  });
});

describe('starting with a damaged show file', () => {
  it('uses the newest backup that loads, keeps the bad file aside and leaves streaming off', async () => {
    const { loadStateOrBackup } = await import('../src/store.js');
    const { mkdir, readdir, utimes, writeFile } = await import('node:fs/promises');
    const dir = await mkdtemp(join(tmpdir(), 'xmas-load-'));
    const path = join(dir, 'show.json');
    await mkdir(join(dir, 'backups'));
    await writeFile(join(dir, 'backups', 'daily-2026-12-01.json'), JSON.stringify(baseState({ activeScene: 'Red' })));
    await writeFile(join(dir, 'backups', 'daily-2026-12-02.json'), JSON.stringify(baseState({ activeScene: 'Blue', output: { brightness: 1, gamma: 1, fps: 40, enabled: true } })));
    await writeFile(join(dir, 'backups', 'daily-2026-12-03.json'), '{ "layout": '); // newest, but cut off too
    await utimes(join(dir, 'backups', 'daily-2026-12-01.json'), 1000, 1000);
    await utimes(join(dir, 'backups', 'daily-2026-12-02.json'), 2000, 2000);
    await utimes(join(dir, 'backups', 'daily-2026-12-03.json'), 3000, 3000);
    await writeFile(path, '{ "layout": { "controllers": [');
    const warnings: string[] = [];
    const state = await loadStateOrBackup(path, join(dir, 'none.json'), (m) => warnings.push(m));
    expect(state.activeScene).toBe('Blue');
    expect(state.output.enabled).toBe(false);
    expect(warnings[0]).toContain('daily-2026-12-02.json');
    expect((await readdir(dir)).some((f) => f.startsWith('show.json.unreadable-'))).toBe(true);
  });
  it('also falls back when the file parses but its layout is invalid, and fails clearly with no backup', async () => {
    const { loadStateOrBackup } = await import('../src/store.js');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const dir = await mkdtemp(join(tmpdir(), 'xmas-load-'));
    const path = join(dir, 'show.json');
    const bad = baseState();
    bad.layout.runs[0]!.count = 9999;
    await writeFile(path, JSON.stringify(bad));
    await expect(loadStateOrBackup(path, join(dir, 'none.json'))).rejects.toThrow(/no backup could be loaded/);
    await mkdir(join(dir, 'backups'));
    await writeFile(join(dir, 'backups', 'daily-2026-12-01.json'), JSON.stringify(baseState()));
    expect((await loadStateOrBackup(path, join(dir, 'none.json'))).layout.runs[0]!.count).toBe(10);
  });
  it('starts from the example when there is no show file yet', async () => {
    const { loadStateOrBackup } = await import('../src/store.js');
    const { writeFile } = await import('node:fs/promises');
    const dir = await mkdtemp(join(tmpdir(), 'xmas-load-'));
    await writeFile(join(dir, 'example.json'), JSON.stringify(baseState()));
    expect((await loadStateOrBackup(join(dir, 'show.json'), join(dir, 'example.json'))).activeScene).toBe('Red');
  });
});
