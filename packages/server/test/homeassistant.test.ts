import { mkdtemp } from 'node:fs/promises';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Aedes } from 'aedes';
import { connect, type MqttClient } from 'mqtt';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/api.js';
import { homeAssistantOptionsFromEnv, NO_PLAYLIST, safeUrl, startHomeAssistant, WLED_SHOWING, type HomeAssistantBridge } from '../src/homeassistant.js';
import type { ShowState } from '../src/store.js';
import { fakeWledHttp } from './helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const waitFor = async (check: () => boolean | Promise<boolean>, what: string, ms = 3000) => {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** An MQTT broker in this process, on a free port. `users` turns on user name/password checks. */
async function broker(users?: Record<string, string>) {
  const aedes = await Aedes.createBroker({
    ...(users && {
      authenticate: (_client, username, password, done) => {
        const ok = !!username && users[username] === password?.toString();
        done(ok ? null : Object.assign(new Error('bad user name or password'), { returnCode: 4 }), ok);
      },
    }),
  });
  const server: Server = createServer(aedes.handle);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => new Promise<void>((r) => { server.close(() => r()); aedes.close(); }));
  return { url, aedes, server };
}

/** A stand-in for Home Assistant: records everything published, and can send commands. */
async function homeAssistant(url: string, username?: string, password?: string) {
  const client: MqttClient = connect(url, { username, password, reconnectPeriod: 0 });
  const messages: { topic: string; payload: string; retain: boolean }[] = [];
  client.on('message', (topic, buf, packet) => messages.push({ topic, payload: buf.toString(), retain: packet.retain }));
  await new Promise<void>((resolve, reject) => { client.once('connect', () => resolve()); client.once('error', reject); });
  await client.subscribeAsync('#');
  cleanups.push(() => client.endAsync());
  const last = (topic: string) => messages.filter((m) => m.topic === topic).at(-1)?.payload;
  return {
    client, messages, last,
    json: (topic: string) => { const p = last(topic); return p === undefined ? undefined : JSON.parse(p); },
    send: (topic: string, payload: string) => client.publishAsync(topic, payload),
    /** Wait until `topic`'s latest message passes `ok`. */
    until: (topic: string, ok: (payload: string) => boolean) => waitFor(() => { const p = last(topic); return p !== undefined && ok(p); }, `${topic}`),
  };
}

/** What a client that connects now is given: the retained messages, by topic. */
async function retained(url: string) {
  const client = connect(url, { reconnectPeriod: 0 });
  const got = new Map<string, string>();
  client.on('message', (topic, buf, packet) => { if (packet.retain) got.set(topic, buf.toString()); });
  await new Promise<void>((r) => client.once('connect', () => r()));
  await client.subscribeAsync('#');
  await new Promise((r) => setTimeout(r, 200));
  await client.endAsync();
  return got;
}

async function makeApp(over: Partial<ShowState> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'xmas-ha-'));
  // The controller is a fake WLED on this machine, so streaming and hand-back reach nothing real.
  const wled = await fakeWledHttp(10);
  cleanups.push(wled.close);
  const state: ShowState = {
    layout: {
      controllers: [{ id: 'a', name: 'A', host: wled.host, port: 9, pixelCount: 10 }],
      runs: [{ id: 'r', controller: 'a', start: 0, count: 10, points: [[0, 0, 0], [1, 0, 0]] }],
    },
    scenes: {
      Red: { name: 'Red', layers: [{ id: 'l', effect: 'solid', params: { color: '#ff0000' } }] },
      Blue: { name: 'Blue', layers: [{ id: 'l', effect: 'solid', params: { color: '#0000ff' } }] },
    },
    activeScene: 'Red',
    playlists: { Evening: { name: 'Evening', entries: [{ scene: 'Blue', seconds: 60 }, { scene: 'Red', seconds: 60 }], loop: true } },
    output: { brightness: 1, gamma: 1, fps: 40, enabled: false, transition: 0 },
    ...over,
  };
  const app: App = await createApp({ state, statePath: join(dir, 'state.json'), now: () => 1_000_000 });
  cleanups.push(() => app.server.close());
  return { app, state, wled };
}

async function linked(over: Partial<ShowState> = {}) {
  const b = await broker();
  const { app, state, wled } = await makeApp(over);
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
  const bridge: HomeAssistantBridge = startHomeAssistant(app, { url: b.url, discoveryPrefix: 'homeassistant', topic: 'xmas', healthMs: 50 }, log);
  cleanups.push(() => bridge.close());
  app.show.setHomeAssistantStatus(bridge.status);
  const ha = await homeAssistant(b.url);
  await waitFor(() => bridge.status().connected, 'the bridge to connect');
  await ha.until('xmas/status', (p) => p === 'online');
  return { b, app, state, wled, bridge, ha, logs };
}

describe('Home Assistant over MQTT', () => {
  it('reads its settings from the environment, and stays off without a URL', () => {
    expect(homeAssistantOptionsFromEnv({})).toBeNull();
    expect(homeAssistantOptionsFromEnv({ XMAS_MQTT_URL: 'mqtt://10.10.1.5:1883', XMAS_MQTT_USERNAME: 'lights', XMAS_MQTT_PASSWORD: 'pw' })).toEqual({
      url: 'mqtt://10.10.1.5:1883', username: 'lights', password: 'pw', discoveryPrefix: 'homeassistant', topic: 'xmas',
    });
    expect(homeAssistantOptionsFromEnv({ XMAS_MQTT_URL: 'mqtt://h', XMAS_MQTT_DISCOVERY_PREFIX: 'ha/', XMAS_MQTT_TOPIC: 'porch' })).toMatchObject({ discoveryPrefix: 'ha', topic: 'porch' });
    expect(safeUrl('mqtt://user:secret@10.10.1.5:1883')).toBe('mqtt://10.10.1.5:1883');
  });

  it('publishes retained discovery configs for one device, with availability', async () => {
    const { b } = await linked();
    const got = await retained(b.url);
    const configs = Object.fromEntries([...got].filter(([t]) => t.startsWith('homeassistant/')).map(([t, p]) => [t, JSON.parse(p)]));
    expect(Object.keys(configs).sort()).toEqual([
      'homeassistant/binary_sensor/xmas/controller/config',
      'homeassistant/light/xmas/light/config',
      'homeassistant/select/xmas/playlist/config',
      'homeassistant/select/xmas/scene/config',
      'homeassistant/sensor/xmas/now_showing/config',
      'homeassistant/switch/xmas/streaming/config',
    ]);
    const ids = new Set<string>();
    for (const c of Object.values(configs)) {
      expect(c.device).toMatchObject({ identifiers: ['xmas'], name: 'Porch Lights', sw_version: '0.1.0' });
      expect(c.availability_topic).toBe('xmas/status');
      ids.add(c.unique_id);
    }
    expect(ids.size).toBe(6);
    const light = configs['homeassistant/light/xmas/light/config'];
    expect(light).toMatchObject({ name: null, schema: 'json', brightness: true, state_topic: 'xmas/light/state', command_topic: 'xmas/light/set', supported_color_modes: ['brightness'] });
    expect(configs['homeassistant/select/xmas/scene/config']).toMatchObject({ name: 'Scene', options: ['Red', 'Blue'], state_topic: 'xmas/scene/state', command_topic: 'xmas/scene/set' });
    expect(configs['homeassistant/select/xmas/playlist/config']).toMatchObject({ name: 'Playlist', options: [NO_PLAYLIST, 'Evening'] });
    expect(configs['homeassistant/switch/xmas/streaming/config']).toMatchObject({ name: 'App controls porch', command_topic: 'xmas/streaming/set', json_attributes_topic: 'xmas/streaming/attributes' });
    // States are retained too, so Home Assistant has them as soon as it subscribes.
    expect(got.get('xmas/status')).toBe('online');
    expect(JSON.parse(got.get('xmas/light/state')!)).toEqual({ state: 'ON', brightness: 255, color_mode: 'brightness' });
    expect(got.get('xmas/scene/state')).toBe('Red');
    expect(got.get('xmas/playlist/state')).toBe(NO_PLAYLIST);
    expect(got.get('xmas/streaming/state')).toBe('OFF');
    expect(got.get('xmas/now_showing/state')).toBe(WLED_SHOWING);
    expect(JSON.parse(got.get('xmas/streaming/attributes')!).description).toMatch(/WLED controller's own playlist/);
  });

  it('light off blacks out, on brings back the last scene at the given brightness', async () => {
    const { app, state, ha } = await linked();
    await ha.send('xmas/light/set', JSON.stringify({ state: 'OFF' }));
    await ha.until('xmas/light/state', (p) => JSON.parse(p).state === 'OFF');
    expect(state.activeScene).toBeNull();
    expect(app.engine().scene.name).toBe('Blackout');
    expect(state.output.enabled).toBe(false); // dark, but streaming is left as it was
    expect(ha.last('xmas/scene/state')).toBe('None');

    await ha.send('xmas/light/set', JSON.stringify({ state: 'ON', brightness: 128 }));
    await ha.until('xmas/light/state', (p) => JSON.parse(p).state === 'ON');
    expect(state.activeScene).toBe('Red');
    expect(app.engine().output.brightness).toBeCloseTo(128 / 255);
    expect(state.output.brightness).toBeCloseTo(128 / 255);
    expect(ha.json('xmas/light/state')).toEqual({ state: 'ON', brightness: 128, color_mode: 'brightness' });
    expect(ha.last('xmas/scene/state')).toBe('Red');

    // Brightness alone, while on, changes only the master brightness.
    await ha.send('xmas/light/set', JSON.stringify({ state: 'ON', brightness: 51 }));
    await ha.until('xmas/light/state', (p) => JSON.parse(p).brightness === 51);
    expect(state.output.brightness).toBeCloseTo(0.2);
    expect(state.activeScene).toBe('Red');
    // Open browsers are told something changed.
    expect((await app.server.inject('/api/status')).json().rev.by).toBe('homeassistant');
  });

  it('light on after a blackout with no scene to go back to picks the first scene', async () => {
    const { state, ha } = await linked({ activeScene: null });
    expect(ha.json('xmas/light/state').state).toBe('OFF');
    await ha.send('xmas/light/set', JSON.stringify({ state: 'ON' }));
    await ha.until('xmas/light/state', (p) => JSON.parse(p).state === 'ON');
    expect(state.activeScene).toBe('Red');
  });

  it('choosing a scene is Go: it goes on stage and stops a playing playlist', async () => {
    const { app, state, ha } = await linked();
    await app.show.playPlaylist('Evening');
    await ha.until('xmas/playlist/state', (p) => p === 'Evening');
    await ha.until('xmas/scene/state', (p) => p === 'Blue'); // the playlist's first scene
    await ha.send('xmas/scene/set', 'Red');
    await ha.until('xmas/scene/state', (p) => p === 'Red');
    expect(state.activeScene).toBe('Red');
    expect(app.engine().scene.name).toBe('Red');
    expect(state.playing).toBeUndefined();
    await ha.until('xmas/playlist/state', (p) => p === NO_PLAYLIST);
  });

  it('an unknown scene changes nothing and the real state is sent back', async () => {
    const { state, ha, logs } = await linked();
    const before = ha.messages.filter((m) => m.topic === 'xmas/scene/state').length;
    await ha.send('xmas/scene/set', 'Nope');
    await waitFor(() => ha.messages.filter((m) => m.topic === 'xmas/scene/state').length > before, 'the scene state to be re-sent');
    expect(ha.last('xmas/scene/state')).toBe('Red');
    expect(state.activeScene).toBe('Red');
    expect(logs.some((l) => /no such scene/.test(l))).toBe(true);
  });

  it('the playlist select plays and stops playlists', async () => {
    const { state, ha } = await linked();
    await ha.send('xmas/playlist/set', 'Evening');
    await ha.until('xmas/playlist/state', (p) => p === 'Evening');
    expect(state.playing?.playlist).toBe('Evening');
    expect(state.activeScene).toBe('Blue');
    await ha.until('xmas/scene/state', (p) => p === 'Blue');
    await ha.send('xmas/playlist/set', NO_PLAYLIST);
    await ha.until('xmas/playlist/state', (p) => p === NO_PLAYLIST);
    expect(state.playing).toBeUndefined();
    expect(state.activeScene).toBe('Blue'); // stopping leaves the scene on
  });

  it('the switch turns streaming on and off (off hands the porch back to WLED)', async () => {
    const { app, state, wled, ha } = await linked();
    await ha.send('xmas/streaming/set', 'ON');
    await ha.until('xmas/streaming/state', (p) => p === 'ON');
    expect(state.output.enabled).toBe(true);
    expect(app.output.running).toBe(true);
    await ha.until('xmas/now_showing/state', (p) => p === 'Red');
    await ha.send('xmas/streaming/set', 'OFF');
    await ha.until('xmas/streaming/state', (p) => p === 'OFF');
    expect(state.output.enabled).toBe(false);
    expect(app.output.running).toBe(false);
    expect(wled.posts.length).toBeGreaterThan(0); // the hand-back to the controller's own presets
    await ha.until('xmas/now_showing/state', (p) => p === WLED_SHOWING);
  });

  it('changes made in the app are published, and select options follow scenes and playlists', async () => {
    const { app, ha } = await linked();
    const options = (topic: string) => ha.json(topic)?.options as string[] | undefined;
    // A new scene appears in the Scene select.
    const put = await app.server.inject({ method: 'PUT', url: '/api/scenes/Green', payload: { layers: [{ id: 'l', effect: 'solid', params: { color: '#00ff00' } }] } });
    expect(put.statusCode).toBe(200);
    await waitFor(() => options('homeassistant/select/xmas/scene/config')?.includes('Green') ?? false, 'Green in the options');
    expect(options('homeassistant/select/xmas/scene/config')).toEqual(['Red', 'Blue', 'Green']);
    // Renamed and deleted.
    await app.server.inject({ method: 'POST', url: '/api/scenes/Green/rename', payload: { to: 'Lime' } });
    await waitFor(() => options('homeassistant/select/xmas/scene/config')?.includes('Lime') ?? false, 'Lime in the options');
    expect(options('homeassistant/select/xmas/scene/config')).toEqual(['Red', 'Blue', 'Lime']);
    await app.server.inject({ method: 'DELETE', url: '/api/scenes/Lime' });
    await waitFor(() => !options('homeassistant/select/xmas/scene/config')?.includes('Lime'), 'Lime gone');
    // Playlists, sorted as the app lists them.
    await app.server.inject({ method: 'PUT', url: '/api/playlists/Calm', payload: { entries: [{ scene: 'Red', seconds: 30 }] } });
    await waitFor(() => options('homeassistant/select/xmas/playlist/config')?.includes('Calm') ?? false, 'Calm in the options');
    expect(options('homeassistant/select/xmas/playlist/config')).toEqual([NO_PLAYLIST, 'Calm', 'Evening']);
    // Go, blackout and brightness from the app.
    await app.server.inject({ method: 'POST', url: '/api/scenes/Blue/activate' });
    await ha.until('xmas/scene/state', (p) => p === 'Blue');
    await app.server.inject({ method: 'PATCH', url: '/api/output', payload: { brightness: 0.5 } });
    await ha.until('xmas/light/state', (p) => JSON.parse(p).brightness === 128);
    await app.server.inject({ method: 'POST', url: '/api/blackout' });
    await ha.until('xmas/light/state', (p) => JSON.parse(p).state === 'OFF');
    // Unchanged configs are not sent again on every change.
    expect(ha.messages.filter((m) => m.topic === 'homeassistant/light/xmas/light/config').length).toBe(1);
  });

  it('reports controller health', async () => {
    const { app, ha } = await linked();
    app.output.startHealthChecks(50);
    await ha.until('xmas/controller/state', (p) => p === 'ON');
  });

  it('shows the link in /api/status, and publishes offline when it stops', async () => {
    const { app, bridge, ha } = await linked();
    expect((await app.server.inject('/api/status')).json().homeassistant).toEqual({ enabled: true, connected: true });
    await bridge.close();
    await ha.until('xmas/status', (p) => p === 'offline');
    expect((await app.server.inject('/api/status')).json().homeassistant).toEqual({ enabled: true, connected: false });
  });

  it('the broker marks the app offline if it vanishes (last will)', async () => {
    const { b, ha } = await linked();
    // Drop the app's connection without a goodbye, as a crash or a pulled cable would.
    for (const c of Object.values((b.aedes as unknown as { clients: Record<string, { id: string; conn: { destroy(): void } }> }).clients)) {
      if (c.id.startsWith('xmas-')) c.conn.destroy();
    }
    await ha.until('xmas/status', (p) => p === 'offline');
  });

  it('without the integration /api/status says so', async () => {
    const { app } = await makeApp();
    expect((await app.server.inject('/api/status')).json().homeassistant).toEqual({ enabled: false, connected: false });
  });

  it('keeps the app working when the broker is unreachable, and connects once it appears', async () => {
    // A port with nothing listening on it.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const { app, state } = await makeApp();
    const logs: string[] = [];
    const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
    const bridge = startHomeAssistant(app, { url: `mqtt://127.0.0.1:${port}`, discoveryPrefix: 'homeassistant', topic: 'xmas', reconnectMs: 100 }, log);
    cleanups.push(() => bridge.close());
    await waitFor(() => logs.some((l) => /ECONNREFUSED/.test(l)), 'a connection error to be logged');
    // The show carries on as normal.
    expect((await app.server.inject({ method: 'POST', url: '/api/scenes/Blue/activate' })).statusCode).toBe(200);
    expect(state.activeScene).toBe('Blue');
    expect(bridge.status()).toEqual({ enabled: true, connected: false });

    // Now the broker comes up on that port: the bridge connects and catches up.
    const aedes = await Aedes.createBroker();
    const server = createServer(aedes.handle);
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => { server.close(() => r()); aedes.close(); }));
    await waitFor(() => bridge.status().connected, 'the bridge to connect', 5000);
    const ha = await homeAssistant(`mqtt://127.0.0.1:${port}`);
    await ha.until('xmas/scene/state', (p) => p === 'Blue');
  });

  it('signs in with a user name and password and never logs the password', async () => {
    const b = await broker({ lights: 's3cret-pw' });
    const { app } = await makeApp();
    const logs: string[] = [];
    const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
    // Wrong password first: refused, and logged without the password.
    const wrong = startHomeAssistant(app, { url: b.url, username: 'lights', password: 'wrong-pw', discoveryPrefix: 'homeassistant', topic: 'xmas', reconnectMs: 100 }, log);
    await waitFor(() => logs.some((l) => /Not authorized|Bad User Name or Password|refused/i.test(l)), 'the refusal to be logged');
    await wrong.close();
    // A password written into the URL is kept out of the log too.
    const right = startHomeAssistant(app, { url: b.url.replace('mqtt://', 'mqtt://lights:s3cret-pw@'), discoveryPrefix: 'homeassistant', topic: 'xmas' }, log);
    cleanups.push(() => right.close());
    await waitFor(() => right.status().connected, 'the bridge to connect');
    const ha = await homeAssistant(b.url, 'lights', 's3cret-pw');
    await ha.until('xmas/status', (p) => p === 'online');
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) { expect(l).not.toContain('s3cret-pw'); expect(l).not.toContain('wrong-pw'); }
  });
});
