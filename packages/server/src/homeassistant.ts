/**
 * Home Assistant integration over MQTT discovery: the porch shows up in Home Assistant as one device
 * with a light, scene and playlist pickers, a streaming switch and a couple of sensors, with no YAML.
 *
 * Commands from Home Assistant go through the same show controls as the HTTP API, so playlists,
 * fades, saving and the schedule behave exactly as they do from the app. State is published when the
 * show changes (the app tells us after every save), not on a timer; controller health, which changes
 * on its own, is checked every few seconds and published only when it flips.
 *
 * Starts only when XMAS_MQTT_URL is set. A broker that is down never stops the app: the client keeps
 * retrying in the background and catches up (discovery and state) when it connects.
 */
import { readFileSync } from 'node:fs';
import { connect, type MqttClient } from 'mqtt';
import type { App } from './api.js';

export interface HomeAssistantOptions {
  /** e.g. mqtt://10.10.1.5:1883 */
  url: string;
  username?: string;
  password?: string;
  /** Home Assistant's discovery prefix (default `homeassistant`). */
  discoveryPrefix: string;
  /** Base topic for this app's state and commands (default `xmas`). Also makes the entity ids unique. */
  topic: string;
  /** Milliseconds between reconnect attempts (default 5000). */
  reconnectMs?: number;
  /** How often to look at controller health (default 5000 ms). */
  healthMs?: number;
}

export interface Log { info(msg: string): void; warn(msg: string): void; error(msg: string): void }

export interface HomeAssistantBridge {
  status(): { enabled: boolean; connected: boolean };
  /** Publish `offline` and disconnect. */
  close(): Promise<void>;
}

/** Read the XMAS_MQTT_* variables; null when XMAS_MQTT_URL isn't set (the integration stays off). */
export function homeAssistantOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): HomeAssistantOptions | null {
  const url = env.XMAS_MQTT_URL?.trim();
  if (!url) return null;
  const clean = (v: string | undefined, fallback: string) => (v ?? '').trim().replace(/^\/+|\/+$/g, '') || fallback;
  return {
    url,
    username: env.XMAS_MQTT_USERNAME || undefined,
    password: env.XMAS_MQTT_PASSWORD || undefined,
    discoveryPrefix: clean(env.XMAS_MQTT_DISCOVERY_PREFIX, 'homeassistant'),
    topic: clean(env.XMAS_MQTT_TOPIC, 'xmas'),
  };
}

/** The broker's address for logs: never a user name or password that was written into the URL. */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = ''; u.password = '';
    return u.toString().replace(/\/$/, '');
  } catch { return '(unparseable MQTT URL)'; }
}

const appVersion = (() => {
  try { return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'unknown'; } catch { return 'unknown'; }
})();

/** Playlist select option meaning "nothing playing". Not "None": Home Assistant reads that payload as "unknown". */
export const NO_PLAYLIST = '(none)';
/** "Now showing" while streaming is off and the controller runs its own presets. */
export const WLED_SHOWING = 'WLED playlist';

const ON = 'ON', OFF = 'OFF';

export function startHomeAssistant(app: App, opts: HomeAssistantOptions, log: Log): HomeAssistantBridge {
  const show = app.show;
  const base = opts.topic;
  const t = {
    availability: `${base}/status`,
    lightState: `${base}/light/state`, lightSet: `${base}/light/set`,
    sceneState: `${base}/scene/state`, sceneSet: `${base}/scene/set`,
    playlistState: `${base}/playlist/state`, playlistSet: `${base}/playlist/set`,
    streamingState: `${base}/streaming/state`, streamingSet: `${base}/streaming/set`, streamingAttrs: `${base}/streaming/attributes`,
    nowShowing: `${base}/now_showing/state`,
    controller: `${base}/controller/state`,
    haStatus: `${opts.discoveryPrefix}/status`,
  };
  const id = base.replace(/[^a-zA-Z0-9_-]/g, '_');
  const configTopic = (component: string, object: string) => `${opts.discoveryPrefix}/${component}/${id}/${object}/config`;

  const device = { identifiers: [id], name: 'Porch Lights', manufacturer: 'xmas-lights (open source)', model: 'Christmas lights show server', sw_version: appVersion };
  const common = (object: string) => ({
    unique_id: `${id}_${object}`,
    device,
    availability_topic: t.availability,
    payload_available: 'online',
    payload_not_available: 'offline',
  });

  const sceneNames = () => Object.keys(show.state.scenes);
  const playlistNames = () => Object.keys(show.state.playlists ?? {}).filter((n) => n !== NO_PLAYLIST).sort((a, b) => a.localeCompare(b));

  /** Discovery configs, by topic. Recomputed on every change; only the ones that differ are sent again. */
  const configs = (): Record<string, object> => ({
    [configTopic('light', 'light')]: {
      ...common('light'),
      name: null, // the device's main entity: shows as "Porch Lights"
      icon: 'mdi:string-lights',
      schema: 'json',
      state_topic: t.lightState,
      command_topic: t.lightSet,
      brightness: true,
      brightness_scale: 255,
      supported_color_modes: ['brightness'],
    },
    [configTopic('select', 'scene')]: {
      ...common('scene'),
      name: 'Scene',
      icon: 'mdi:palette',
      state_topic: t.sceneState,
      command_topic: t.sceneSet,
      options: sceneNames(),
    },
    [configTopic('select', 'playlist')]: {
      ...common('playlist'),
      name: 'Playlist',
      icon: 'mdi:playlist-play',
      state_topic: t.playlistState,
      command_topic: t.playlistSet,
      options: [NO_PLAYLIST, ...playlistNames()],
    },
    [configTopic('switch', 'streaming')]: {
      ...common('streaming'),
      name: 'App controls porch',
      icon: 'mdi:access-point-network',
      state_topic: t.streamingState,
      command_topic: t.streamingSet,
      json_attributes_topic: t.streamingAttrs,
    },
    [configTopic('sensor', 'now_showing')]: {
      ...common('now_showing'),
      name: 'Now showing',
      icon: 'mdi:television-play',
      state_topic: t.nowShowing,
    },
    [configTopic('binary_sensor', 'controller')]: {
      ...common('controller'),
      name: 'Controller',
      device_class: 'connectivity',
      entity_category: 'diagnostic',
      state_topic: t.controller,
    },
  });

  const brightness255 = () => Math.round(show.state.output.brightness * 255);
  /** Controllers all answered their last health check: ON; any didn't: OFF; none checked yet: nothing to say. */
  const controllerState = () => {
    const cs = app.output.stats().controllers;
    if (!cs.length || cs.some((c) => c.online === null)) return null;
    return cs.every((c) => c.online) ? ON : OFF;
  };
  /** State messages, by topic. */
  const states = (): Record<string, string> => {
    const s = show.state;
    const on = s.activeScene !== null;
    const out: Record<string, string> = {
      [t.lightState]: JSON.stringify(on ? { state: ON, brightness: brightness255(), color_mode: 'brightness' } : { state: OFF, brightness: brightness255() }),
      // "None" is how Home Assistant is told a select has no current option (here: blacked out).
      [t.sceneState]: s.activeScene ?? 'None',
      [t.playlistState]: s.playing && s.playlists?.[s.playing.playlist] ? s.playing.playlist : NO_PLAYLIST,
      [t.streamingState]: s.output.enabled ? ON : OFF,
      [t.streamingAttrs]: JSON.stringify({ description: "On: this app drives the porch lights. Off: the porch is handed back to the WLED controller's own playlist (Home Assistant's light, scene and playlist controls then change only what the app would show)." }),
      [t.nowShowing]: !s.output.enabled ? WLED_SHOWING : (s.activeScene ?? 'Off'),
    };
    const c = controllerState();
    if (c) out[t.controller] = c;
    return out;
  };

  let client: MqttClient | null = null;
  let connected = false;
  let closing = false;
  /** What the broker has now (retained), so unchanged messages aren't sent again. Forgotten on reconnect. */
  const sent = new Map<string, string>();

  const publish = (topic: string, payload: string) => {
    if (!client || !connected || sent.get(topic) === payload) return;
    sent.set(topic, payload);
    client.publish(topic, payload, { qos: 1, retain: true }, (err) => {
      if (err) { sent.delete(topic); if (!closing) log.warn(`home assistant: could not publish to ${topic}: ${err.message}`); }
    });
  };
  /** Send whatever differs from what the broker has: configs first, so Home Assistant knows the entities before their states. */
  const sync = () => {
    for (const [topic, cfg] of Object.entries(configs())) publish(topic, JSON.stringify(cfg));
    for (const [topic, payload] of Object.entries(states())) publish(topic, payload);
  };

  /** Run a command; whatever happens, publish the real state afterwards (so a refused command snaps back in Home Assistant). */
  const command = async (what: string, run: () => Promise<void>) => {
    try {
      await run();
      show.touched('homeassistant');
    } catch (e) {
      log.warn(`home assistant: ${what} failed: ${(e as Error).message}`);
      // Nothing changed, but Home Assistant may already show the new value optimistically: resend the old one.
      for (const topic of [t.lightState, t.sceneState, t.playlistState, t.streamingState]) sent.delete(topic);
    }
    sync();
  };

  const onLight = async (payload: string) => {
    let cmd: { state?: string; brightness?: number };
    try { cmd = JSON.parse(payload) as typeof cmd; } catch { throw new Error(`light command is not JSON: ${payload.slice(0, 100)}`); }
    if (cmd?.state === OFF) { if (show.state.activeScene !== null) await show.blackout(); return; }
    if (cmd?.state !== ON) throw new Error(`light command needs "state": "ON" or "OFF"`);
    if (cmd.brightness !== undefined) {
      if (typeof cmd.brightness !== 'number' || !Number.isFinite(cmd.brightness)) throw new Error('brightness must be a number 0..255');
      const b = Math.min(1, Math.max(0, cmd.brightness / 255));
      if (b !== show.state.output.brightness) await show.setOutput({ brightness: b });
    }
    if (show.state.activeScene === null) {
      // Back on: the last scene that was on (if it still exists), else the first one.
      const s = show.state;
      const name = s.lastScene && Object.hasOwn(s.scenes, s.lastScene) ? s.lastScene : Object.keys(s.scenes)[0];
      if (!name) throw new Error('there are no scenes to turn on');
      await show.go(name);
    }
  };

  const handlers: Record<string, (payload: string) => Promise<void>> = {
    [t.lightSet]: onLight,
    [t.sceneSet]: (p) => show.go(p),
    [t.playlistSet]: (p) => (p === NO_PLAYLIST ? show.stopPlaylist() : show.playPlaylist(p)),
    [t.streamingSet]: async (p) => {
      if (p !== ON && p !== OFF) throw new Error(`streaming must be ON or OFF, got ${p.slice(0, 20)}`);
      await show.setOutput({ enabled: p === ON });
    },
  };

  // Commands run one at a time, in the order they arrive.
  let queue: Promise<void> = Promise.resolve();

  const where = safeUrl(opts.url);
  try {
    client = connect(opts.url, {
      username: opts.username,
      password: opts.password,
      clientId: `${id}-${Math.random().toString(16).slice(2, 10)}`,
      clean: true,
      reconnectPeriod: opts.reconnectMs ?? 5000,
      connectTimeout: 10_000,
      // Nothing is queued while offline: on reconnect everything is sent fresh anyway.
      queueQoSZero: false,
      will: { topic: t.availability, payload: Buffer.from('offline'), qos: 1, retain: true },
    });
  } catch (e) {
    log.error(`home assistant: cannot use MQTT broker ${where}: ${(e as Error).message}`);
    return { status: () => ({ enabled: true, connected: false }), close: async () => {} };
  }
  log.info(`home assistant: connecting to MQTT broker ${where}`);

  let lastError = '';
  client.on('connect', () => {
    connected = true;
    lastError = '';
    log.info(`home assistant: connected to MQTT broker ${where}`);
    sent.clear();
    client!.subscribe([...Object.keys(handlers), t.haStatus], { qos: 1 }, (err) => {
      if (err) log.warn(`home assistant: could not subscribe: ${err.message}`);
    });
    sync();
    publish(t.availability, 'online');
  });
  client.on('close', () => {
    if (connected && !closing) log.warn(`home assistant: lost the MQTT broker ${where}; retrying`);
    connected = false;
  });
  client.on('error', (e) => {
    // Logged once per distinct error, so a broker that stays down doesn't fill the log.
    if (e.message !== lastError) log.warn(`home assistant: MQTT broker ${where}: ${e.message}`);
    lastError = e.message;
  });
  client.on('message', (topic, buf) => {
    const payload = buf.toString('utf8');
    if (topic === t.haStatus) {
      // Home Assistant restarted: send everything again (retained copies would do, but its docs ask for this).
      if (payload === 'online') { sent.clear(); sync(); publish(t.availability, 'online'); }
      return;
    }
    const h = handlers[topic];
    if (!h) return;
    queue = queue.then(() => command(`${topic.slice(base.length + 1)} ${payload.slice(0, 100)}`, () => h(payload)));
  });

  const stopListening = show.onChange(sync);
  const health = setInterval(() => { const c = controllerState(); if (c) publish(t.controller, c); }, opts.healthMs ?? 5000);
  health.unref();

  return {
    status: () => ({ enabled: true, connected }),
    close: async () => {
      closing = true;
      stopListening();
      clearInterval(health);
      const c = client!;
      // Don't hold up a shutdown for a broker that has stopped answering.
      const within = (p: Promise<void>) => Promise.race([p, new Promise<void>((r) => setTimeout(r, 2000).unref())]);
      if (connected) await within(new Promise<void>((r) => c.publish(t.availability, 'offline', { qos: 1, retain: true }, () => r())));
      await within(new Promise<void>((r) => c.end(false, {}, () => r())));
      if (c.connected || c.reconnecting) c.end(true);
      connected = false;
    },
  };
}
