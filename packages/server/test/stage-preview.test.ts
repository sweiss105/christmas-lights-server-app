import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/api.js';
import type { ShowState } from '../src/store.js';

/**
 * POST /api/stage/preview: Live editing puts the browser's unsaved working copy on the porch
 * without storing it anywhere.
 */
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const solid = (name: string, color: string) => ({ name, layers: [{ id: 'l', effect: 'solid', params: { color } }] });

async function makeApp(over: Partial<ShowState> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'xmas-preview-'));
  let now = Date.parse('2026-12-21T20:00:00Z');
  const state: ShowState = {
    layout: {
      controllers: [{ id: 'a', name: 'A', host: '127.0.0.1', port: 9, pixelCount: 10 }],
      runs: [{ id: 'r', controller: 'a', start: 0, count: 10, points: [[0, 0, 0], [1, 0, 0]] }],
    },
    scenes: { Red: solid('Red', '#ff0000'), Blue: solid('Blue', '#0000ff') },
    activeScene: 'Red',
    output: { brightness: 1, gamma: 1, fps: 40, enabled: false, transition: 0 },
    ...over,
  };
  const statePath = join(dir, 'state.json');
  const app: App = await createApp({ state, statePath, now: () => now });
  cleanups.push(() => app.server.close());
  return { app, state, statePath, advance: async (ms: number) => { now += ms; await app.tick(); } };
}

const pixel = async (app: App) => [...(await app.server.inject('/api/frame')).rawPayload.subarray(0, 3)];
const status = async (app: App) => (await app.server.inject('/api/status')).json();
const preview = (app: App, payload: unknown) => app.server.inject({ method: 'POST', url: '/api/stage/preview', payload: payload as object });

describe('Live preview of an unsaved scene (POST /api/stage/preview)', () => {
  it('validates the scene like a save does', async () => {
    const { app } = await makeApp();
    expect((await preview(app, { layers: [] })).statusCode).toBe(400); // no name
    expect((await preview(app, { name: ' padded ', layers: [] })).statusCode).toBe(400);
    expect((await preview(app, { name: 'X', layers: [{ id: 'l', effect: 'no-such-effect' }] })).statusCode).toBe(400);
    expect((await preview(app, { name: 'X', layers: [{ id: 'l', effect: 'solid', group: 'nope' }] })).statusCode).toBe(400);
    expect(await pixel(app)).toEqual([255, 0, 0]); // nothing changed
  });

  it('puts the working copy on the porch without touching the stored scenes', async () => {
    const { app, state, statePath } = await makeApp();
    await app.server.inject({ method: 'POST', url: '/api/scenes/Red/activate' }); // writes the state file
    const before = await readFile(statePath, 'utf8');
    const res = await preview(app, solid('Red', '#00ff00'));
    expect(res.statusCode).toBe(200);
    expect(res.json().preview).toBe('Red');
    expect(await pixel(app)).toEqual([0, 255, 0]);
    expect((await app.server.inject('/api/stage')).json().layers[0].params.color).toBe('#00ff00');
    expect(state.scenes.Red!.layers[0]!.params!.color).toBe('#ff0000');
    expect((await app.server.inject('/api/scenes/Red')).json().layers[0].params.color).toBe('#ff0000');
    expect(await status(app)).toMatchObject({ stage: { scene: 'Red', preview: 'Red' } });
    expect(await readFile(statePath, 'utf8')).toBe(before); // not written
  });

  it('previews a scene that has never been stored, and DELETE puts back what was on stage', async () => {
    const { app, state } = await makeApp();
    await preview(app, solid('Painting', '#ffffff'));
    expect(await pixel(app)).toEqual([255, 255, 255]);
    expect(Object.keys(state.scenes)).toEqual(['Red', 'Blue']);
    expect((await status(app)).stage).toEqual({ scene: 'Red', dirty: false, preview: 'Painting' });
    expect((await app.server.inject({ method: 'DELETE', url: '/api/stage/preview' })).statusCode).toBe(200);
    expect(await pixel(app)).toEqual([255, 0, 0]);
    expect((await status(app)).stage).toEqual({ scene: 'Red', dirty: false });
  });

  it('is not persisted: the state file keeps the stored stage, and a restart brings it back', async () => {
    const { app, statePath } = await makeApp();
    await preview(app, solid('Red', '#00ff00'));
    // Any other save while previewing (here a preset) must not write the draft as the stage.
    await app.server.inject({ method: 'PUT', url: '/api/presets/Warm', payload: { effect: 'solid', params: { color: '#ffaa00' } } });
    const saved = JSON.parse(await readFile(statePath, 'utf8')) as ShowState;
    expect(saved.stage?.layers[0]!.params!.color).toBe('#ff0000');
    expect(saved.scenes.Red!.layers[0]!.params!.color).toBe('#ff0000');
    await app.server.close();
    const again = await createApp({ state: saved, statePath });
    cleanups.push(() => again.server.close());
    expect([...(await again.server.inject('/api/frame')).rawPayload.subarray(0, 3)]).toEqual([255, 0, 0]);
    expect((await again.server.inject('/api/status')).json().stage).toEqual({ scene: 'Red', dirty: false });
  });

  it('a Live save of the previewed scene stores it, and the stored scene is then on stage', async () => {
    const { app, state } = await makeApp();
    await preview(app, solid('Red', '#00ff00'));
    await app.server.inject({ method: 'PUT', url: '/api/scenes/Red?apply=true', payload: solid('Red', '#00ff00') });
    expect(state.scenes.Red!.layers[0]!.params!.color).toBe('#00ff00');
    expect((await status(app)).stage).toEqual({ scene: 'Red', dirty: false });
    expect(await pixel(app)).toEqual([0, 255, 0]);
  });

  it('a saved painting previewed under its new name becomes the stored stage scene', async () => {
    const { app, state } = await makeApp();
    await preview(app, solid('Painting', '#ffffff'));
    await app.server.inject({ method: 'PUT', url: '/api/scenes/Snow?apply=true', payload: solid('Snow', '#ffffff') });
    expect(state.scenes.Snow).toBeDefined();
    // The UI follows a Save as new with the stored copy, which ends the preview.
    expect((await preview(app, solid('Snow', '#ffffff'))).json().preview).toBe(null);
    expect((await status(app)).stage).toEqual({ scene: 'Snow', dirty: false });
    expect(await pixel(app)).toEqual([255, 255, 255]);
  });

  it('sending the stored version (Revert) puts the stored scene back on stage', async () => {
    const { app } = await makeApp();
    await preview(app, solid('Red', '#00ff00'));
    const res = await preview(app, solid('Red', '#ff0000'));
    expect(res.json().preview).toBe(null);
    expect(await pixel(app)).toEqual([255, 0, 0]);
    expect((await status(app)).stage).toEqual({ scene: 'Red', dirty: false });
  });

  it('Go, Blackout and playlists use stored scenes and end the preview', async () => {
    const { app, advance } = await makeApp();
    await preview(app, solid('Red', '#00ff00'));
    await app.server.inject({ method: 'POST', url: '/api/scenes/Red/activate' });
    expect(await pixel(app)).toEqual([255, 0, 0]); // the stored Red, not the draft
    expect((await status(app)).stage).toEqual({ scene: 'Red', dirty: false });

    await preview(app, solid('Blue', '#00ff00'));
    await app.server.inject({ method: 'PUT', url: '/api/playlists/Eve', payload: { entries: [{ scene: 'Blue', seconds: 60 }] } });
    await app.server.inject({ method: 'POST', url: '/api/playlists/Eve/play' });
    await advance(0);
    expect(await pixel(app)).toEqual([0, 0, 255]); // stored Blue
    expect((await status(app)).stage.preview).toBeUndefined();

    await preview(app, solid('Blue', '#00ff00'));
    await app.server.inject({ method: 'POST', url: '/api/blackout' });
    expect(await pixel(app)).toEqual([0, 0, 0]);
    expect((await status(app)).stage.preview).toBeUndefined();
  });

  it('Home Assistant controls (show.go) use the stored scene', async () => {
    const { app } = await makeApp();
    await preview(app, solid('Blue', '#00ff00'));
    await app.show.go('Blue');
    expect(await pixel(app)).toEqual([0, 0, 255]);
    expect(app.show.state.activeScene).toBe('Blue');
  });

  it('a scene whose unsaved edits are on the porch cannot be deleted', async () => {
    const { app } = await makeApp();
    await preview(app, solid('Blue', '#00ff00'));
    expect((await app.server.inject({ method: 'DELETE', url: '/api/scenes/Blue' })).statusCode).toBe(409);
  });

  it('only the first preview of another scene fades; edits after it cut', async () => {
    const { app } = await makeApp({ output: { brightness: 1, gamma: 1, fps: 40, enabled: false, transition: 5 } });
    await preview(app, solid('Blue', '#00ff00'));
    const mid = await pixel(app);
    expect(mid[0]).toBeGreaterThan(0); // still fading out of red
    await preview(app, solid('Blue', '#ffffff'));
    // A cut from the current frame: the fade from the first preview is gone, the new colour is there at once.
    expect(await pixel(app)).toEqual([255, 255, 255]);
  });

  it('does not count as a change other tabs must reload for', async () => {
    const { app } = await makeApp();
    const n = (await status(app)).rev.n;
    await preview(app, solid('Red', '#00ff00'));
    expect((await status(app)).rev.n).toBe(n);
  });
});
