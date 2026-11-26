import { afterEach, describe, expect, it, vi } from 'vitest';
import { EFFECTS, type DemoSnapshot, type SceneConfig } from '@xmas/engine';
import { api, ApiError, type Status } from '../src/api';
import { createDemoBackend, DEMO_REFUSAL } from '../src/demo/backend';

const red: SceneConfig = { name: 'A', layers: [{ id: 'l', effect: 'solid', params: { color: '#ff0000' } }] };
const blue: SceneConfig = { name: 'B', layers: [{ id: 'l', effect: 'solid', params: { color: '#0000ff' } }] };

function snapshot(): DemoSnapshot {
  return {
    layout: {
      controllers: [{ id: 'c', name: 'C', host: 'demo.invalid', pixelCount: 10 }],
      runs: [{ id: 'r', controller: 'c', start: 0, count: 10, points: [[0, 0, 0], [9, 0, 0]] }],
      groups: { porch: { runs: ['r'] } },
    },
    scenes: { A: red, B: blue, Bad: { name: 'Bad', layers: [{ id: 'l', effect: 'solid', group: 'missing' }] } },
    playlists: {
      P: { name: 'P', entries: [{ scene: 'A', seconds: 10 }, { scene: 'B', seconds: 10 }], loop: true },
      Q: { name: 'Q', entries: [{ scene: 'Gone', seconds: 10 }, { scene: 'A', seconds: 10 }], loop: true },
    },
    presets: { Warm: { name: 'Warm', effect: 'solid', params: { color: '#ffb46b' } } },
    palettes: {},
    activeScene: 'A',
    stage: red,
    output: { brightness: 0.8, gamma: 2.2, transition: 1 },
    house: { position: [0, 0, 0], rotation: 0, scale: 1, opacity: 1, parts: [] },
  };
}

/** A backend on a clock the test moves. */
function demo() {
  let now = 0;
  const b = createDemoBackend(snapshot(), () => now);
  return {
    at: (ms: number) => { now = ms; },
    get: <T>(path: string) => b.handle('GET', path) as Promise<T>,
    send: <T>(method: string, path: string, body?: unknown) => b.handle(method, path, body) as Promise<T>,
    status: () => b.handle('GET', '/api/status') as Promise<Status>,
    stage: () => b.handle('GET', '/api/stage') as Promise<SceneConfig>,
  };
}

const refusal = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ status: 403, message: DEMO_REFUSAL });

/** Arguments for every api function, so each one's request can be sent to the stand-in. */
const ARGS: Record<string, unknown[]> = {
  status: [], login: ['t'], clock: [], layout: [], scenes: [], stage: [], groups: [], effects: [],
  saveScene: [red, false], previewStage: [red], endPreview: [], renameScene: ['A', 'C'], deleteScene: ['A'],
  presets: [], savePreset: ['X', { effect: 'solid' }], deletePreset: ['Warm'],
  palettes: [], savePalette: ['X', [[0, '#000000']]], renamePalette: ['X', 'Y'], deletePalette: ['X'],
  identify: ['r'], saveLayout: [snapshot().layout], house: [], setHouse: [{ opacity: 0.5 }],
  uploadHousePart: [new Blob(['x']), 'x'], setHousePart: ['p', { name: 'x' }], deleteHousePart: ['p'],
  playlists: [], savePlaylist: [{ name: 'P', entries: [], loop: true }], deletePlaylist: ['P'], playPlaylist: ['P'], stopPlaylist: [],
  schedule: [], saveSchedule: [{ enabled: false }], discoverControllers: [], backups: [], restore: [{}], restoreBackup: ['f'],
  go: ['B'], blackout: [], mappingStart: [{}], mappingPreview: [{ seconds: 1 }], mappingStop: [], mappingViews: [],
  saveMappingView: [{}], uploadRecording: [new Blob(['x']), { view: 'v', label: 'l', gz: false }], deleteMappingView: ['v'],
  backupNow: ['why'], setOutput: [{ brightness: 0.5 }],
};

/** The api functions the demo refuses on purpose. Everything else must get a real answer. */
const REFUSED = ['login', 'saveScene', 'renameScene', 'deleteScene', 'savePreset', 'deletePreset', 'savePalette', 'renamePalette', 'deletePalette',
  'saveLayout', 'setHouse', 'uploadHousePart', 'setHousePart', 'deleteHousePart', 'savePlaylist', 'deletePlaylist', 'saveSchedule',
  'discoverControllers', 'backups', 'restore', 'restoreBackup', 'mappingStart', 'mappingPreview', 'mappingStop', 'mappingViews',
  'saveMappingView', 'uploadRecording', 'deleteMappingView', 'backupNow'];

afterEach(() => { vi.unstubAllGlobals(); });

describe('demo stand-in', () => {
  it('answers every request the app can make, refusing only the ones that store something', async () => {
    const sent: { name: string; method: string; path: string; body?: unknown }[] = [];
    let current = '';
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      sent.push({ name: current, method: init?.method ?? 'GET', path: url, body });
      return new Response('{"t":0}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    for (const [name, fn] of Object.entries(api)) {
      const args = ARGS[name];
      expect(args, `add demo args for ${name}`).toBeDefined();
      current = name;
      await (fn as (...a: unknown[]) => Promise<unknown>)(...args!).catch(() => {});
    }
    for (const { name, method, path, body } of sent) {
      const b = demo();
      const answer = b.send(method, path, body);
      if (REFUSED.includes(name)) await refusal(answer);
      else await expect(answer, `${name}: ${method} ${path}`).resolves.toBeDefined();
    }
    expect(new Set(sent.map((s) => s.name))).toEqual(new Set(Object.keys(api)));
  });

  it('puts a stored scene on stage with Go, and says when there is no such scene', async () => {
    const b = demo();
    await b.send('POST', '/api/scenes/B/activate');
    expect((await b.status()).scene).toBe('B');
    expect((await b.stage()).name).toBe('B');
    await expect(b.send('POST', '/api/scenes/nope/activate')).rejects.toMatchObject({ status: 404 });
  });

  it('blacks out', async () => {
    const b = demo();
    await b.send('POST', '/api/blackout');
    expect((await b.status()).scene).toBeNull();
    expect((await b.stage()).layers).toEqual([]);
  });

  it('shows Live edits without storing them, and puts the stage back when they end', async () => {
    const b = demo();
    const edited = { ...red, layers: [{ id: 'l', effect: 'solid', params: { color: '#00ff00' } }] };
    await b.send('POST', '/api/stage/preview', edited);
    expect((await b.status()).stage.preview).toBe('A');
    expect((await b.stage()).layers[0]!.params!.color).toBe('#00ff00');
    expect((await b.get<{ scenes: SceneConfig[] }>('/api/scenes')).scenes.find((s) => s.name === 'A')).toEqual(red);
    await b.send('POST', '/api/stage/preview', red); // the stored version: the preview ends
    expect((await b.status()).stage.preview).toBeUndefined();
    await b.send('POST', '/api/stage/preview', edited);
    await b.send('DELETE', '/api/stage/preview');
    expect((await b.status()).stage.preview).toBeUndefined();
    expect((await b.stage()).layers[0]!.params!.color).toBe('#ff0000');
  });

  it('plays a playlist on its own clock, and a Go stops it', async () => {
    const b = demo();
    await b.send('POST', '/api/scenes/B/activate');
    await b.send('POST', '/api/playlists/P/play');
    expect((await b.status()).scene).toBe('A');
    b.at(15_000);
    const s = await b.status();
    expect(s.playlist?.index).toBe(1);
    expect(s.scene).toBe('B');
    await b.send('POST', '/api/scenes/A/activate');
    expect((await b.status()).playlist).toBeNull();
  });

  it('skips a playlist entry whose scene is gone', async () => {
    const b = demo();
    await b.send('POST', '/api/playlists/Q/play');
    const s = await b.status();
    expect(s.playlist?.scene).toBe('Gone');
    expect(s.scene).toBe('A');
  });

  it('refuses to Go to a scene that does not fit the layout, leaving the stage alone', async () => {
    const b = demo();
    await expect(b.send('POST', '/api/scenes/Bad/activate')).rejects.toMatchObject({ status: 400 });
    expect((await b.status()).scene).toBe('A');
  });

  it('changes brightness in the tab and checks values like the server', async () => {
    const b = demo();
    await b.send('PATCH', '/api/output', { brightness: 0.3 });
    expect((await b.status()).output.brightness).toBe(0.3);
    await expect(b.send('PATCH', '/api/output', { fps: 0 })).rejects.toMatchObject({ status: 400 });
  });

  it('keeps each tab to itself and never tells a tab to reload', async () => {
    const one = demo(), two = demo();
    await one.send('POST', '/api/scenes/B/activate');
    expect((await two.status()).scene).toBe('A');
    expect((await one.status()).rev).toEqual({ boot: 'demo', n: 0, by: '' });
  });

  it('lists the same effects as the server', async () => {
    expect((await demo().get<unknown[]>('/api/effects')).length).toBe(Object.values(EFFECTS).length);
  });

  it('refuses to store a scene and leaves the stored one as it was', async () => {
    const b = demo();
    await refusal(b.send('PUT', '/api/scenes/A?apply=false', { layers: [] }));
    expect(await b.get('/api/scenes/A')).toEqual(red);
  });

  it('answers an unknown read with 404', async () => {
    await expect(demo().get('/api/nothing')).rejects.toBeInstanceOf(ApiError);
  });
});
