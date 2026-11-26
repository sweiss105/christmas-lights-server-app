import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildLayout, checkPaletteStops, Engine, EFFECTS, LayoutError, PALETTE_NAMES, validateScene, type LayerConfig, type LayoutConfig, type SavedPalette, type SceneConfig } from '@xmas/engine';
import { registerMapping } from './mapping.js';
import { OutputLoop } from './output.js';
import { inWindow, isTimeZone, nextWindow, playlistPosition, type PlaylistConfig, type ScheduleConfig } from './show.js';
import { DEFAULT_HOUSE, saveState, type HouseConfig, type HousePart, type PresetConfig, type ShowState } from './store.js';
import { discover, getInfo, getPresets, releaseToPreset } from './wled.js';

export interface AppOptions {
  state: ShowState;
  statePath: string;
  /** If set, every /api route except /api/health and /api/login needs `Authorization: Bearer <token>` or the cookie that /api/login sets. */
  apiToken?: string;
  /** Directory with the built web UI (packages/web/dist), served at `/`. Skipped if unset or missing. */
  webRoot?: string;
  /** Injected for tests. */
  discoverFn?: typeof discover;
  /** Wall clock (ms) for playlists and the schedule; injected for tests, which then drive tick() themselves. */
  now?: () => number;
  logger?: boolean;
}

/**
 * The show's controls, for things other than the HTTP API (Home Assistant). Each one is what the
 * matching route does, so playlists, fades, saving and the schedule behave the same either way.
 */
export interface ShowControls {
  /** The live show state (read it; change it only through these controls). */
  readonly state: ShowState;
  /** Go: put a scene on stage (fading), stopping a playlist. */
  go(name: string): Promise<void>;
  blackout(): Promise<void>;
  playPlaylist(name: string): Promise<void>;
  stopPlaylist(): Promise<void>;
  /** Same as PATCH /api/output: brightness 0..1, enabled (streaming), fps, gamma, transition. */
  setOutput(patch: Partial<ShowState['output']>): Promise<ShowState['output']>;
  /** Called after every saved change to the show (scenes, playlists, stage, output), whoever made it. */
  onChange(listener: () => void): () => void;
  /** Count a change made outside the HTTP API, so open browsers reload (`by` names who made it). */
  touched(by: string): void;
  /** Adds `homeassistant: { enabled, connected }` to /api/status. */
  setHomeAssistantStatus(fn: () => { enabled: boolean; connected: boolean }): void;
}

export interface App {
  server: FastifyInstance; output: OutputLoop; engine: () => Engine;
  /** Advance playlists and the schedule (runs every second in production). */ tick: () => Promise<void>;
  show: ShowControls;
}

export class HttpError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
const bad = (e: unknown) => new HttpError(400, (e as Error).message);
/** Cookie the web UI signs in with (it can't add a header to downloads or to the 3D model loader). */
const TOKEN_COOKIE = 'xmas_token';
const MAX_NAME = 80;

export async function createApp(opts: AppOptions): Promise<App> {
  const state = opts.state;
  let engine = new Engine(buildLayout(state.layout));
  engine.setOutput({ brightness: state.output.brightness, gamma: state.output.gamma });
  if (state.activeScene && state.scenes[state.activeScene]) {
    // Prefer the staged copy, so Blind edits that weren't sent stay pending across a restart.
    const staged = state.stage?.name === state.activeScene ? state.stage : undefined;
    try { engine.setScene(staged ?? state.scenes[state.activeScene]!); } catch {
      try { engine.setScene(state.scenes[state.activeScene]!); } catch { state.activeScene = null; }
    }
  }
  const output = new OutputLoop(() => engine, state.output.fps);
  output.onWarn = (m) => server.log.warn(m);
  const changeListeners = new Set<() => void>();
  /** Save, recording what's on stage so a restart can bring it back exactly, then tell whoever listens. */
  const persist = async () => {
    if (state.activeScene) { state.stage = engine.scene; state.lastScene = state.activeScene; } else delete state.stage;
    try { await saveState(opts.statePath, state); } finally {
      for (const l of changeListeners) { try { l(); } catch (e) { server.log.error(e); } }
    }
  };
  /** Crossfade time for Go and Blackout. Live edits never fade. */
  const fadeSeconds = () => state.output.transition ?? 1;

  const server = Fastify({ logger: opts.logger ?? false });

  server.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const code = err.statusCode ?? 500;
    if (code >= 500) server.log.error(err);
    reply.code(code).send({ error: err.message });
  });

  const tokenMatches = (got: string) => {
    const a = Buffer.from(got), b = Buffer.from(opts.apiToken ?? '');
    return a.length === b.length && timingSafeEqual(a, b);
  };
  if (opts.apiToken) {
    const cookieToken = (header: string | undefined) => {
      for (const part of (header ?? '').split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0 || part.slice(0, eq).trim() !== TOKEN_COOKIE) continue;
        try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return ''; }
      }
      return '';
    };
    server.addHook('onRequest', async (req) => {
      const path = req.url.split('?')[0]!;
      if (!path.startsWith('/api/') || path === '/api/health' || path === '/api/login') return;
      const auth = req.headers.authorization ?? '';
      if (auth.startsWith('Bearer ') && tokenMatches(auth.slice(7))) return;
      if (tokenMatches(cookieToken(req.headers.cookie))) return;
      throw new HttpError(401, 'unauthorized');
    });
  }

  server.get('/api/health', async () => ({ ok: true }));

  /**
   * Sign the web UI in: checks the token and sets it as a cookie only this site's own pages send
   * (HttpOnly, SameSite=Strict), so every request from the UI carries it, downloads included.
   */
  server.post<{ Body: { token?: string } }>('/api/login', async (req, reply) => {
    if (!opts.apiToken) return { ok: true, required: false };
    const token = req.body?.token;
    if (typeof token !== 'string' || !tokenMatches(token)) throw new HttpError(401, 'wrong token');
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    reply.header('set-cookie', `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`);
    return { ok: true, required: true };
  });

  /**
   * Counts changes made through the API and remembers which browser made the last one (the UI sends
   * an id with each request), so another open tab or device can tell that it needs to reload.
   */
  const rev = { boot: randomUUID(), n: 0, by: '' };
  server.addHook('onResponse', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || !req.url.startsWith('/api/') || reply.statusCode >= 400) return;
    const by = req.headers['x-client-id'];
    rev.n++;
    rev.by = typeof by === 'string' ? by.slice(0, 64) : '';
  });

  /** True when the saved copy of the stage scene has Blind edits that are not on the porch yet. */
  const stageDirty = () => {
    const saved = state.activeScene ? state.scenes[state.activeScene] : undefined;
    if (!saved) return false;
    // Compare normalised forms: older saved scenes omit defaults that the running copy has filled in.
    try { return JSON.stringify(validateScene(saved, engine.layout)) !== JSON.stringify(engine.scene); } catch { return true; }
  };

  let homeAssistantStatus = () => ({ enabled: false, connected: false });
  server.get('/api/status', async () => ({
    scene: state.activeScene,
    stage: { scene: state.activeScene, dirty: stageDirty() },
    playlist: playlistStatus(),
    schedule: scheduleStatus(),
    pixels: engine.layout.count,
    output: { ...engine.output, enabled: state.output.enabled, transition: fadeSeconds() },
    stream: output.stats(),
    rev: { ...rev },
    homeassistant: homeAssistantStatus(),
  }));

  /** The scene the porch is running now (may differ from the saved copy while Blind edits are pending). */
  server.get('/api/stage', async () => engine.scene);

  /** Effect time in seconds, so a browser preview can render the same frame the porch shows. */
  server.get('/api/clock', async () => ({ t: output.now() }));

  server.get('/api/effects', async () => Object.values(EFFECTS).map(({ id, name, description, params }) => ({ id, name, description, params })));

  // ---- layout -------------------------------------------------------------
  server.get('/api/layout', async () => state.layout);

  server.put<{ Body: LayoutConfig }>('/api/layout', async (req) => {
    let next: Engine;
    try { next = new Engine(buildLayout(req.body)); } catch (e) { throw e instanceof LayoutError ? bad(e) : bad(e); }
    next.setOutput(engine.output);
    // Keep the current scene if it still fits the new layout (its groups may have gone).
    if (state.activeScene) {
      // Keep what's on stage (Blind edits stay pending); fall back to the saved copy if it doesn't fit.
      try { next.setScene(engine.scene); } catch {
        try { next.setScene(state.scenes[state.activeScene]!); } catch { state.activeScene = null; }
      }
    }
    engine = next;
    mapping.stop(); // pixel codes follow the layout, so a running sequence would no longer match it
    state.layout = req.body;
    await persist();
    return { pixels: engine.layout.count, groups: [...engine.layout.groups.keys()] };
  });

  server.get('/api/groups', async () => [...engine.layout.groups.entries()].map(([name, m]) => ({ name, pixels: m.reduce((a, b) => a + b, 0) })));

  // ---- scenes -------------------------------------------------------------
  /**
   * A layer that names a saved palette without its colours (e.g. a scene written by hand or a script)
   * gets a copy of them, so it draws the same whatever later happens to the saved palette.
   */
  const withSavedPalettes = (layers: LayerConfig[] | undefined): LayerConfig[] => {
    if (!Array.isArray(layers)) return layers as unknown as LayerConfig[];
    return layers.map((l) => {
      const name = l?.params?.palette;
      if (typeof name !== 'string' || l.params!.paletteStops != null || PALETTE_NAMES.includes(name)) return l;
      const saved = state.palettes && Object.hasOwn(state.palettes, name) ? state.palettes[name] : undefined;
      return saved ? { ...l, params: { ...l.params, paletteStops: structuredClone(saved.stops) } } : l;
    });
  };
  const sceneNameOk = (name: string) => name.length > 0 && name.length <= MAX_NAME && name === name.trim() && name !== '__proto__';
  /** What still refers to a scene, in words for an error message. */
  const sceneUses = (name: string): string[] => {
    const uses = Object.values(state.playlists ?? {}).filter((pl) => pl.entries.some((e) => e.scene === name)).map((pl) => `the playlist "${pl.name}"`);
    if (state.schedule?.run.kind === 'scene' && state.schedule.run.name === name) uses.push('the nightly schedule');
    return uses;
  };

  server.get('/api/scenes', async () => ({ active: state.activeScene, scenes: Object.values(state.scenes) }));

  server.get<{ Params: { name: string } }>('/api/scenes/:name', async (req) => {
    const s = state.scenes[req.params.name];
    if (!s) throw new HttpError(404, 'no such scene');
    return s;
  });

  /**
   * Save a scene. `?apply=false` is a Blind save: the porch keeps showing the staged version until
   * the scene is activated (Go). The default (`apply=true`) is a Live save: an edit to the scene on
   * stage shows on the porch at once.
   */
  server.put<{ Params: { name: string }; Querystring: { apply?: string }; Body: SceneConfig }>('/api/scenes/:name', async (req) => {
    const apply = req.query.apply ?? 'true';
    if (apply !== 'true' && apply !== 'false') throw new HttpError(400, 'apply must be true or false');
    if (!sceneNameOk(req.params.name)) throw new HttpError(400, `a scene name must be 1..${MAX_NAME} characters`);
    let valid: SceneConfig;
    const probe = new Engine(engine.layout);
    try { valid = probe.setScene({ ...req.body, name: req.params.name, layers: withSavedPalettes(req.body?.layers) }); } catch (e) { throw bad(e); }
    state.scenes[valid.name] = valid;
    if (apply === 'true' && state.activeScene === valid.name) engine.setScene(valid); // Live edit
    await persist();
    return valid;
  });

  server.delete<{ Params: { name: string } }>('/api/scenes/:name', async (req) => {
    if (!state.scenes[req.params.name]) throw new HttpError(404, 'no such scene');
    if (state.activeScene === req.params.name) throw new HttpError(409, 'cannot delete the active scene');
    const uses = sceneUses(req.params.name);
    if (uses.length) throw new HttpError(409, `"${req.params.name}" is used by ${uses.join(' and ')}. Take it out of there first.`);
    delete state.scenes[req.params.name];
    await persist();
    return { deleted: req.params.name };
  });

  /**
   * Rename a scene in one step, keeping everything that refers to it: playlists, the schedule and the
   * stage. The porch doesn't change, so a scene can be renamed while it's on stage.
   */
  server.post<{ Params: { name: string }; Body: { to?: string } }>('/api/scenes/:name/rename', async (req) => {
    const from = req.params.name;
    const scene = Object.hasOwn(state.scenes, from) ? state.scenes[from] : undefined;
    if (!scene) throw new HttpError(404, 'no such scene');
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    if (!sceneNameOk(to)) throw new HttpError(400, `a scene name must be 1..${MAX_NAME} characters`);
    if (to === from) return scene;
    if (Object.hasOwn(state.scenes, to)) throw new HttpError(409, `there is already a scene called "${to}"`);
    const renamed = { ...scene, name: to };
    // Rebuild rather than add, so the scene keeps its place in the list.
    state.scenes = Object.fromEntries(Object.entries(state.scenes).map(([k, v]) => (k === from ? [to, renamed] : [k, v])));
    for (const pl of Object.values(state.playlists ?? {})) for (const e of pl.entries) if (e.scene === from) e.scene = to;
    if (state.schedule?.run.kind === 'scene' && state.schedule.run.name === from) state.schedule.run.name = to;
    if (state.activeScene === from) { state.activeScene = to; engine.scene = { ...engine.scene, name: to }; }
    if (state.lastScene === from) state.lastScene = to;
    await persist();
    return renamed;
  });

  const go = async (name: string) => {
    const s = Object.hasOwn(state.scenes, name) ? state.scenes[name] : undefined;
    if (!s) throw new HttpError(404, 'no such scene');
    try { engine.setScene(s, { fade: fadeSeconds() }); } catch (e) { throw bad(e); }
    state.activeScene = s.name;
    delete state.playing; // a manual Go takes over from a playlist
    await persist();
  };
  server.post<{ Params: { name: string } }>('/api/scenes/:name/activate', async (req) => { await go(req.params.name); return { active: req.params.name }; });

  const blackout = async () => {
    engine.setScene({ name: 'Blackout', layers: [] }, { fade: fadeSeconds() });
    state.activeScene = null;
    delete state.playing;
    await persist();
  };
  server.post('/api/blackout', async () => { await blackout(); return { active: null }; });

  // ---- playlists ---------------------------------------------------------------
  const now = opts.now ?? Date.now;
  const playlistStatus = () => {
    const pl = state.playing && state.playlists?.[state.playing.playlist];
    if (!pl || !state.playing) return null;
    const pos = playlistPosition(pl.entries, state.playing.startedAt, now(), pl.loop, pl.shuffle);
    return { name: pl.name, index: pos.index, scene: pl.entries[pos.index]?.scene ?? null, nextAt: pos.nextAt };
  };

  server.get('/api/playlists', async () => Object.values(state.playlists ?? {}).sort((a, b) => a.name.localeCompare(b.name)));

  server.put<{ Params: { name: string }; Body: Partial<PlaylistConfig> }>('/api/playlists/:name', async (req) => {
    const name = req.params.name.trim();
    if (!name || name.length > 60) throw new HttpError(400, 'playlist name must be 1..60 characters');
    const entries = req.body?.entries;
    if (!Array.isArray(entries) || entries.length === 0) throw new HttpError(400, 'a playlist needs at least one scene');
    for (const e of entries) {
      if (!e || typeof e.scene !== 'string' || !state.scenes[e.scene]) throw new HttpError(400, `unknown scene "${e?.scene}"`);
      if (!Number.isFinite(e.seconds) || e.seconds < 1 || e.seconds > 86_400) throw new HttpError(400, 'each scene plays for 1 second to 24 hours');
      if (e.fade !== undefined && e.fade !== null && (typeof e.fade !== 'number' || !Number.isFinite(e.fade) || e.fade < 0 || e.fade > 60)) throw new HttpError(400, 'a scene\'s fade must be 0..60 seconds');
    }
    const pl: PlaylistConfig = { name, entries: entries.map((e) => ({ scene: e.scene, seconds: e.seconds, ...(typeof e.fade === 'number' && { fade: e.fade }) })), loop: req.body?.loop !== false, ...(req.body?.shuffle === true && { shuffle: true }) };
    state.playlists = { ...(state.playlists ?? {}), [name]: pl };
    await persist();
    return pl;
  });

  server.delete<{ Params: { name: string } }>('/api/playlists/:name', async (req) => {
    if (!state.playlists?.[req.params.name]) throw new HttpError(404, 'no such playlist');
    if (state.schedule?.run.kind === 'playlist' && state.schedule.run.name === req.params.name) {
      throw new HttpError(409, `"${req.params.name}" is what the nightly schedule plays. Pick something else there first.`);
    }
    delete state.playlists[req.params.name];
    if (state.playing?.playlist === req.params.name) delete state.playing;
    await persist();
    return { deleted: req.params.name };
  });

  const startPlaylist = async (name: string) => {
    if (!state.playlists || !Object.hasOwn(state.playlists, name)) throw new HttpError(404, 'no such playlist');
    state.playing = { playlist: name, startedAt: now() };
    await advancePlaylist();
    await persist();
  };

  server.post<{ Params: { name: string } }>('/api/playlists/:name/play', async (req) => { await startPlaylist(req.params.name); return { playing: req.params.name }; });
  const stopPlaylist = async () => { delete state.playing; await persist(); };
  server.post('/api/playlists/stop', async () => { await stopPlaylist(); return { playing: null }; });

  /** Put the playlist's current scene on stage when it's time. */
  const advancePlaylist = async () => {
    const st = playlistStatus();
    if (!st?.scene || st.scene === state.activeScene) return;
    const scene = state.scenes[st.scene];
    if (!scene) return; // deleted since; skip
    // Each entry can set its own fade in (like a WLED playlist step's transition); else the app's.
    const fade = state.playlists?.[st.name]?.entries[st.index]?.fade;
    try { engine.setScene(scene, { fade: fade ?? fadeSeconds() }); } catch { return; }
    state.activeScene = scene.name;
    await persist();
  };

  // ---- nightly schedule ----------------------------------------------------------
  // Whether the on window was open at the last tick. It's saved, so after a restart the first tick
  // can tell that the on or off time passed while the server was down, and catch up. With nothing
  // saved (a new schedule, or just after a restore) the first tick only takes note.
  let lastInWindow: boolean | undefined = state.scheduleInWindow;
  const setInWindow = (v: boolean | undefined) => {
    lastInWindow = v;
    if (v === undefined) delete state.scheduleInWindow; else state.scheduleInWindow = v;
  };
  const scheduleStatus = () => {
    const s = state.schedule;
    if (!s) return null;
    const w = nextWindow(s, now());
    return { ...s, active: s.enabled && now() >= w.on && now() < w.off, nextOn: w.on, nextOff: w.off };
  };

  server.get('/api/schedule', async () => scheduleStatus() ?? { enabled: false });

  server.put<{ Body: ScheduleConfig }>('/api/schedule', async (req) => {
    const b = req.body;
    const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!b || typeof b.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
    if (!isTimeZone(b.timezone)) throw new HttpError(400, 'timezone must be an IANA time zone such as America/Chicago');
    const needsSun = b.on?.kind === 'sunset' || b.off?.kind === 'sunrise';
    if (needsSun && !(Number.isFinite(b.latitude) && Math.abs(b.latitude!) <= 90 && Number.isFinite(b.longitude) && Math.abs(b.longitude!) <= 180)) {
      throw new HttpError(400, 'sunset and sunrise need a latitude and longitude');
    }
    const okOffset = (m: unknown) => m === undefined || (Number.isFinite(m) && Math.abs(m as number) <= 240);
    if (!(b.on?.kind === 'sunset' ? okOffset(b.on.offsetMinutes) : b.on?.kind === 'time' && clock.test(b.on.time))) throw new HttpError(400, 'on must be sunset (± minutes) or a time like 16:30');
    if (!(b.off?.kind === 'sunrise' ? okOffset(b.off.offsetMinutes) : b.off?.kind === 'time' && clock.test(b.off.time))) throw new HttpError(400, 'off must be a time like 23:00 or sunrise');
    if (!b.run || !['scene', 'playlist'].includes(b.run.kind) || !(b.run.kind === 'scene' ? state.scenes[b.run.name] : state.playlists?.[b.run.name])) {
      throw new HttpError(400, 'run must name an existing scene or playlist');
    }
    state.schedule = {
      enabled: b.enabled, timezone: b.timezone, on: b.on, off: b.off, run: { kind: b.run.kind, name: b.run.name },
      ...(Number.isFinite(b.latitude) && { latitude: b.latitude }), ...(Number.isFinite(b.longitude) && { longitude: b.longitude }),
    };
    // Saving during the on window starts the show at the next tick; otherwise wait for the on time.
    setInWindow(false);
    await persist();
    return scheduleStatus();
  });

  /** Called every second: advance a playlist, and switch the show on/off when the schedule says so. */
  const tick = async () => {
    await dailyBackup().catch((e) => server.log.error(e));
    await advancePlaylist();
    const s = state.schedule;
    if (!s?.enabled) {
      if (lastInWindow !== undefined) { setInWindow(undefined); await persist(); }
      return;
    }
    const inside = inWindow(s, now());
    if (lastInWindow === undefined) { setInWindow(inside); await persist(); return; }
    if (inside === lastInWindow) return;
    setInWindow(inside);
    if (inside) {
      // The lights come on even if what the schedule names has gone or no longer fits the layout:
      // whatever was on stage last is better than a dark house.
      try {
        if (s.run.kind === 'playlist' && state.playlists?.[s.run.name]) await startPlaylist(s.run.name);
        else if (s.run.kind === 'scene' && state.scenes[s.run.name]) {
          engine.setScene(state.scenes[s.run.name]!, { fade: fadeSeconds() });
          state.activeScene = s.run.name;
          delete state.playing;
        } else server.log.warn(`schedule: ${s.run.kind} "${s.run.name}" no longer exists; keeping what was on stage`);
      } catch (e) { server.log.error(e); }
      output.startStreaming();
      state.output = { ...state.output, enabled: true };
    } else {
      delete state.playing;
      await output.stopStreaming(); // hand the porch back to its WLED playlist
      state.output = { ...state.output, enabled: false };
    }
    await persist();
  };
  const ticker = opts.now ? null : setInterval(() => { tick().catch((e) => server.log.error(e)); }, 1000);
  ticker?.unref();

  // ---- backup and restore --------------------------------------------------------
  const backupDir = join(dirname(opts.statePath), 'backups');
  const BACKUP_NAME = /^[a-z0-9-]+\.json$/;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  const writeBackup = async (file: string) => {
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, file), JSON.stringify(state, null, 2) + '\n');
  };
  const listBackups = async () => {
    let names: string[] = [];
    try { names = (await readdir(backupDir)).filter((f) => BACKUP_NAME.test(f)); } catch { return []; }
    const out = await Promise.all(names.map(async (file) => { const st = await stat(join(backupDir, file)); return { file, bytes: st.size, modified: st.mtimeMs }; }));
    return out.sort((a, b) => b.file.localeCompare(a.file));
  };
  /** Keep only the newest `keep` backups whose names start with `prefix`. */
  const prune = async (prefix: string, keep: number) => {
    // The date follows the prefix directly, so "before-" doesn't also count "before-restore-…" files.
    const old = (await listBackups()).filter((b) => b.file.startsWith(prefix) && /\d/.test(b.file[prefix.length] ?? '')).slice(keep);
    await Promise.all(old.map((b) => rm(join(backupDir, b.file), { force: true })));
  };

  /** Replace the whole show with `data` after checking it. The porch keeps streaming (or not) as it is. */
  const restoreFrom = async (data: unknown): Promise<string> => {
    const d = data as Partial<ShowState> | null;
    if (!d || typeof d !== 'object' || !d.layout || typeof d.scenes !== 'object' || !d.output) throw new HttpError(400, 'not a lights backup (needs layout, scenes and output)');
    let next: Engine;
    try { next = new Engine(buildLayout(d.layout)); } catch (e) { throw bad(e); }
    for (const sc of Object.values(d.scenes ?? {})) {
      try { validateScene(sc, next.layout); } catch (e) { throw new HttpError(400, `scene "${sc?.name}": ${(e as Error).message}`); }
    }
    const savedFirst = `before-restore-${new Date(now()).toISOString().replace(/[:.]/g, '-').toLowerCase()}.json`;
    await writeBackup(savedFirst);
    await prune('before-restore-', 10);
    const enabled = state.output.enabled;
    for (const k of Object.keys(state)) delete (state as unknown as Record<string, unknown>)[k];
    Object.assign(state, structuredClone(d), { output: { ...d.output, enabled } });
    next.setOutput({ brightness: state.output.brightness, gamma: state.output.gamma });
    const staged = state.activeScene && (state.stage?.name === state.activeScene ? state.stage : state.scenes[state.activeScene]);
    if (staged) { try { next.setScene(staged); } catch { state.activeScene = null; } }
    engine = next;
    mapping.stop();
    setInWindow(undefined);
    await persist();
    return savedFirst;
  };

  server.get('/api/backup', async (_req, reply) => {
    reply.header('content-disposition', `attachment; filename="xmas-lights-backup-${day(now())}.json"`);
    return state;
  });
  server.post('/api/restore', { bodyLimit: 20 * 1024 * 1024 }, async (req) => ({ restored: true, savedFirst: await restoreFrom(req.body) }));
  server.get('/api/backups', async () => listBackups());
  /** Save a backup now, e.g. before accepting mapped positions. `reason` starts the file name. */
  server.post<{ Body: { reason?: string } }>('/api/backups', async (req) => {
    const reason = req.body?.reason ?? 'manual';
    if (typeof reason !== 'string' || !/^[a-z][a-z-]{0,29}$/.test(reason) || reason.startsWith('daily')) throw new HttpError(400, 'reason must be 1..30 lowercase letters or dashes');
    const file = `${reason}-${new Date(now()).toISOString().replace(/[:.]/g, '-').toLowerCase()}.json`;
    await writeBackup(file);
    await prune(`${reason}-`, 10);
    return { file };
  });
  server.get<{ Params: { file: string } }>('/api/backups/:file', async (req, reply) => {
    if (!BACKUP_NAME.test(req.params.file)) throw new HttpError(404, 'no such backup');
    try { const body = await readFile(join(backupDir, req.params.file), 'utf8'); reply.header('content-type', 'application/json').header('content-disposition', `attachment; filename="${req.params.file}"`); return body; }
    catch { throw new HttpError(404, 'no such backup'); }
  });
  server.post<{ Params: { file: string } }>('/api/backups/:file/restore', async (req) => {
    if (!BACKUP_NAME.test(req.params.file)) throw new HttpError(404, 'no such backup');
    let data: unknown;
    try { data = JSON.parse(await readFile(join(backupDir, req.params.file), 'utf8')); } catch { throw new HttpError(404, 'no such backup'); }
    return { restored: true, savedFirst: await restoreFrom(data) };
  });

  /** One automatic backup per day, keeping two weeks. */
  let lastDaily = '';
  const dailyBackup = async () => {
    const d = day(now());
    if (d === lastDaily) return;
    lastDaily = d;
    const file = `daily-${d}.json`;
    if ((await listBackups()).some((b) => b.file === file)) return;
    await writeBackup(file);
    await prune('daily-', 14);
  };

  // ---- identify: flash one run on the porch -----------------------------------
  let identify: { run: string; until: number } | null = null;
  const identifyOverlay = (frame: Uint8Array, t: number) => {
    if (!identify) return;
    if (performance.now() > identify.until) { identify = null; return; }
    const mask = engine.layout.groups.get(`run:${identify.run}`);
    if (!mask) { identify = null; return; }
    // The run pulses white twice a second; everything else goes dark so it's unmistakable.
    const v = Math.round(40 + 215 * (0.5 + 0.5 * Math.cos(t * Math.PI * 4)));
    for (let i = 0; i < mask.length; i++) {
      const on = mask[i] ? v : 0;
      frame[i * 3] = on; frame[i * 3 + 1] = on; frame[i * 3 + 2] = on;
    }
  };

  // Camera mapping takes over the whole output while its sequence plays; otherwise Identify may flash a run.
  const mapping = registerMapping(server, { engine: () => engine, output, dataDir: dirname(opts.statePath) });
  output.overlay = (frame, t) => { if (!mapping.overlay(frame, t)) identifyOverlay(frame, t); };

  /** Flash one run on the porch for a few seconds (only visible while streaming). `run: null` cancels. */
  server.post<{ Body: { run?: string | null; seconds?: number } }>('/api/identify', async (req) => {
    const run = req.body?.run ?? null;
    if (run === null) { identify = null; return { run: null }; }
    if (!state.layout.runs.some((r) => r.id === run)) throw new HttpError(404, 'no such run');
    const seconds = req.body?.seconds ?? 5;
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new HttpError(400, 'seconds must be 0..60');
    identify = { run, until: performance.now() + seconds * 1000 };
    return { run, seconds, streaming: output.running };
  });

  // ---- house model: scan parts (.glb) and their alignment --------------------
  const dataDir = dirname(opts.statePath);
  const MAX_MODEL_BYTES = 150 * 1024 * 1024;
  // A single model from before parts existed becomes the first part.
  if (state.house?.model && !state.house.parts) {
    const { model, ...rest } = state.house;
    state.house = { ...rest, parts: [{ id: 'main', name: 'Scan', file: 'house.glb', bytes: model.bytes, uploadedAt: model.uploadedAt, position: [0, 0, 0], rotation: 0, scale: 1, visible: true }] };
  }
  const house = (): HouseConfig => ({ ...DEFAULT_HOUSE, parts: [], ...(state.house ?? {}) });
  const part = (id: string) => {
    const p = house().parts!.find((x) => x.id === id);
    if (!p) throw new HttpError(404, 'no such scan part');
    return p;
  };

  const vec3 = (v: unknown, what: string): [number, number, number] => {
    if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => Number.isFinite(x) && Math.abs(x) < 1000)) throw new HttpError(400, `${what} must be [x, y, z] in metres`);
    return [v[0], v[1], v[2]];
  };
  const degrees = (v: unknown) => { if (!Number.isFinite(v)) throw new HttpError(400, 'rotation must be degrees'); return (((v as number) % 360) + 360) % 360; };
  const scaleOf = (v: unknown) => { if (!Number.isFinite(v) || (v as number) <= 0 || (v as number) > 100) throw new HttpError(400, 'scale must be > 0'); return v as number; };

  server.addContentTypeParser(['model/gltf-binary', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: MAX_MODEL_BYTES },
    (_req, body, done) => done(null, body));

  server.get('/api/house', async () => house());

  /** Align the whole house with the lights. */
  server.patch<{ Body: Partial<HouseConfig> }>('/api/house', async (req) => {
    const b = req.body ?? {};
    const next = house();
    if (b.position !== undefined) next.position = vec3(b.position, 'position');
    if (b.rotation !== undefined) next.rotation = degrees(b.rotation);
    if (b.scale !== undefined) next.scale = scaleOf(b.scale);
    if (b.opacity !== undefined) {
      if (!Number.isFinite(b.opacity) || b.opacity < 0 || b.opacity > 1) throw new HttpError(400, 'opacity must be 0..1');
      next.opacity = b.opacity;
    }
    if (b.glow !== undefined) {
      if (typeof b.glow !== 'number' || !Number.isFinite(b.glow) || b.glow < 0 || b.glow > 3) throw new HttpError(400, 'glow must be 0..3');
      next.glow = b.glow;
    }
    state.house = next;
    await persist();
    return next;
  });

  /** Upload a scan (binary glTF, e.g. from Polycam or Scaniverse) as a new part. */
  server.post<{ Body: Buffer; Querystring: { name?: string } }>('/api/house/parts', async (req) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length < 12 || body.toString('ascii', 0, 4) !== 'glTF' || body.readUInt32LE(4) !== 2) {
      throw new HttpError(400, 'expected a binary glTF 2.0 file (.glb)');
    }
    const h = house();
    let n = h.parts!.length + 1;
    while (h.parts!.some((p) => p.id === `part${n}`)) n++;
    const id = `part${n}`;
    const file = `house-${id}.glb`;
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, `${file}.tmp`), body);
    await rename(join(dataDir, `${file}.tmp`), join(dataDir, file));
    const name = (req.query.name ?? '').trim().slice(0, 60) || `Scan ${n}`;
    const p: HousePart = { id, name, file, bytes: body.length, uploadedAt: new Date().toISOString(), position: [0, 0, 0], rotation: 0, scale: 1, visible: true };
    state.house = { ...h, parts: [...h.parts!, p] };
    await persist();
    return p;
  });

  server.get<{ Params: { id: string }; Querystring: { v?: string } }>('/api/house/parts/:id/model', async (req, reply) => {
    const p = part(req.params.id);
    const path = join(dataDir, p.file);
    let bytes: number;
    try { bytes = (await stat(path)).size; } catch { throw new HttpError(404, 'scan file is missing'); }
    // The UI asks with ?v=<upload time>, and a part's file never changes after upload, so the browser
    // can keep that copy instead of downloading a large scan on every visit.
    reply.header('content-type', 'model/gltf-binary').header('content-length', bytes)
      .header('cache-control', req.query.v ? 'private, max-age=31536000, immutable' : 'no-cache');
    return reply.send(createReadStream(path));
  });

  /** Place one part relative to the others (name, position, turn, scale, visibility). */
  server.patch<{ Params: { id: string }; Body: Partial<HousePart> }>('/api/house/parts/:id', async (req) => {
    const p = { ...part(req.params.id) };
    const b = req.body ?? {};
    if (b.name !== undefined) { if (typeof b.name !== 'string' || !b.name.trim()) throw new HttpError(400, 'name must be text'); p.name = b.name.trim().slice(0, 60); }
    if (b.position !== undefined) p.position = vec3(b.position, 'position');
    if (b.rotation !== undefined) p.rotation = degrees(b.rotation);
    if (b.scale !== undefined) p.scale = scaleOf(b.scale);
    if (b.visible !== undefined) { if (typeof b.visible !== 'boolean') throw new HttpError(400, 'visible must be true or false'); p.visible = b.visible; }
    const h = house();
    state.house = { ...h, parts: h.parts!.map((x) => (x.id === p.id ? p : x)) };
    await persist();
    return p;
  });

  server.delete<{ Params: { id: string } }>('/api/house/parts/:id', async (req) => {
    const p = part(req.params.id);
    await rm(join(dataDir, p.file), { force: true });
    const h = house();
    state.house = { ...h, parts: h.parts!.filter((x) => x.id !== p.id) };
    await persist();
    return { deleted: p.id };
  });

  // ---- layer presets -------------------------------------------------------
  /** Validate a preset as a one-layer scene. Presets don't depend on the layout, so an unknown group means all lights. */
  const validatePreset = (name: string, body: Partial<LayerConfig>): PresetConfig => {
    const group = typeof body.group === 'string' && engine.layout.groups.has(body.group) ? body.group : 'all';
    const layer = validateScene({ name, layers: [{ ...body, id: 'preset', group } as LayerConfig] }, engine.layout).layers[0]!;
    const { id: _id, enabled: _enabled, paint: _paint, ...look } = layer; // a preset is a look, not where it was painted
    return { name, ...look };
  };

  server.get('/api/presets', async () => Object.values(state.presets ?? {}).sort((a, b) => a.name.localeCompare(b.name)));

  server.get<{ Params: { name: string } }>('/api/presets/:name', async (req) => {
    const p = state.presets?.[req.params.name];
    if (!p) throw new HttpError(404, 'no such preset');
    return p;
  });

  server.put<{ Params: { name: string }; Body: Partial<LayerConfig> }>('/api/presets/:name', async (req) => {
    const name = req.params.name.trim();
    if (!name || name.length > 80) throw new HttpError(400, 'preset name must be 1..80 characters');
    let preset: PresetConfig;
    try { preset = validatePreset(name, withSavedPalettes([req.body ?? {}] as LayerConfig[])[0]!); } catch (e) { throw bad(e); }
    state.presets = { ...(state.presets ?? {}), [name]: preset };
    await persist();
    return preset;
  });

  server.delete<{ Params: { name: string } }>('/api/presets/:name', async (req) => {
    if (!state.presets?.[req.params.name]) throw new HttpError(404, 'no such preset');
    delete state.presets[req.params.name];
    await persist();
    return { deleted: req.params.name };
  });

  // ---- saved palettes -------------------------------------------------------
  const savedPalette = (name: string): SavedPalette | undefined => (state.palettes && Object.hasOwn(state.palettes, name) ? state.palettes[name] : undefined);
  /** A built-in name always means the built-in palette, and "* " starts WLED's colour-based ones. */
  const paletteNameError = (name: string): string | null => {
    if (!name || name.length > 60 || name !== name.trim() || name === '__proto__') return 'a palette name must be 1..60 characters';
    if (PALETTE_NAMES.includes(name) || name.startsWith('* ')) return `"${name}" is a built-in palette's name`;
    return null;
  };

  server.get('/api/palettes', async () => Object.values(state.palettes ?? {}).sort((a, b) => a.name.localeCompare(b.name)));

  server.get<{ Params: { name: string } }>('/api/palettes/:name', async (req) => {
    const p = savedPalette(req.params.name);
    if (!p) throw new HttpError(404, 'no such palette');
    return p;
  });

  /** Save (or replace) a palette: `{ stops: [[0, "#ff0000"], ..., [255, "#0000ff"]] }`. */
  server.put<{ Params: { name: string }; Body: { stops?: unknown } }>('/api/palettes/:name', async (req) => {
    const name = req.params.name;
    const err = paletteNameError(name);
    if (err) throw new HttpError(400, err);
    let stops;
    try { stops = checkPaletteStops(req.body?.stops); } catch (e) { throw bad(e); }
    const p: SavedPalette = { name, stops };
    state.palettes = { ...(state.palettes ?? {}), [name]: p };
    await persist();
    return p;
  });

  /** Rename a palette. Layers keep their own copy of its colours (under the name they had), so scenes don't change. */
  server.post<{ Params: { name: string }; Body: { to?: string } }>('/api/palettes/:name/rename', async (req) => {
    const from = req.params.name;
    const p = savedPalette(from);
    if (!p) throw new HttpError(404, 'no such palette');
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    const err = paletteNameError(to);
    if (err) throw new HttpError(400, err);
    if (to === from) return p;
    if (savedPalette(to)) throw new HttpError(409, `there is already a palette called "${to}"`);
    const renamed = { ...p, name: to };
    state.palettes = Object.fromEntries(Object.entries(state.palettes!).map(([k, v]) => (k === from ? [to, renamed] : [k, v])));
    await persist();
    return renamed;
  });

  /** Delete a palette. Layers using it keep their own copy of its colours. */
  server.delete<{ Params: { name: string } }>('/api/palettes/:name', async (req) => {
    if (!savedPalette(req.params.name)) throw new HttpError(404, 'no such palette');
    delete state.palettes![req.params.name];
    await persist();
    return { deleted: req.params.name };
  });

  // ---- output -------------------------------------------------------------
  server.get('/api/output', async () => ({ ...engine.output, fps: output.fps, enabled: state.output.enabled, transition: fadeSeconds() }));

  const setOutput = async (b: Partial<ShowState['output']>) => {
    // Check everything first, so a request with one bad value changes nothing.
    if (b.fps !== undefined && (!Number.isInteger(b.fps) || b.fps < 1 || b.fps > 60)) throw new HttpError(400, 'fps must be an integer 1..60');
    if (b.transition !== undefined && (typeof b.transition !== 'number' || !Number.isFinite(b.transition) || b.transition < 0 || b.transition > 10)) throw new HttpError(400, 'transition must be 0..10 seconds');
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean');
    try { engine.setOutput({ ...(b.brightness !== undefined && { brightness: b.brightness }), ...(b.gamma !== undefined && { gamma: b.gamma }) }); } catch (e) { throw bad(e); }
    if (b.fps !== undefined) output.fps = b.fps;
    if (b.enabled !== undefined) {
      if (b.enabled) output.startStreaming(); else await output.stopStreaming();
    }
    state.output = { ...engine.output, fps: output.fps, enabled: b.enabled ?? state.output.enabled, transition: b.transition ?? state.output.transition ?? 1 };
    await persist();
    return state.output;
  };
  server.patch<{ Body: Partial<ShowState['output']> }>('/api/output', async (req) => setOutput(req.body ?? {}));

  /** Raw RGB frame (global pixel order) for previews and debugging. */
  server.get('/api/frame', async (_req, reply) => {
    reply.header('content-type', 'application/octet-stream');
    const t = output.now();
    const frame = engine.render(t);
    output.overlay?.(frame, t); // what the porch is sent: Identify and mapping included
    return Buffer.from(frame);
  });

  // ---- controllers --------------------------------------------------------
  server.get('/api/controllers', async () => output.stats().controllers);

  server.post<{ Querystring: { timeout?: string } }>('/api/controllers/discover', async (req) => {
    const ms = Math.min(10000, Math.max(500, Number(req.query.timeout ?? 3000) || 3000));
    return (opts.discoverFn ?? discover)(ms);
  });

  server.post<{ Body: { host?: string } }>('/api/controllers/probe', async (req) => {
    const host = req.body?.host;
    if (typeof host !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(host)) throw new HttpError(400, 'host must be an IP or hostname');
    try { return { host, info: await getInfo(host) }; } catch (e) { throw new HttpError(502, (e as Error).message); }
  });

  const controller = (id: string) => {
    const c = state.layout.controllers.find((x) => x.id === id);
    if (!c) throw new HttpError(404, 'no such controller');
    return c;
  };

  server.get<{ Params: { id: string } }>('/api/controllers/:id/presets', async (req) => {
    const c = controller(req.params.id);
    try { return await getPresets(c.host); } catch (e) { throw new HttpError(502, (e as Error).message); }
  });

  /** Load a WLED preset on one controller. Only visible while our stream is stopped. */
  server.post<{ Params: { id: string }; Body: { preset?: number } }>('/api/controllers/:id/preset', async (req) => {
    const c = controller(req.params.id);
    const p = req.body?.preset;
    if (!Number.isInteger(p) || p! < 1 || p! > 250) throw new HttpError(400, 'preset must be 1..250');
    try { await releaseToPreset(c.host, p); } catch (e) { throw new HttpError(502, (e as Error).message); }
    return { controller: c.id, preset: p, note: output.running ? 'streaming is on and will override this preset' : undefined };
  });

  // ---- web UI -------------------------------------------------------------
  if (opts.webRoot && existsSync(opts.webRoot)) {
    // Files are looked up per request, so a rebuilt UI is served without restarting.
    await server.register(fastifyStatic, {
      root: opts.webRoot,
      cacheControl: false,
      // Built files carry a content hash in their names, so browsers can keep them; the page itself is re-checked.
      setHeaders: (reply, path) => {
        // @fastify/static v10 passes the Fastify reply (header()), older versions the raw response (setHeader()).
        const r = reply as unknown as { header?: (k: string, v: string) => void; setHeader?: (k: string, v: string) => void };
        const value = /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache';
        if (r.header) r.header('cache-control', value); else r.setHeader?.('cache-control', value);
      },
    });
  }
  // Unknown /api routes are 404 JSON, never the UI. The token hook above runs first for /api.
  server.setNotFoundHandler((req, reply) => { reply.code(404).send({ error: `no route ${req.method} ${req.url.split('?')[0]}` }); });

  server.addHook('onClose', async () => { if (ticker) clearInterval(ticker); await output.close(); });

  const show: ShowControls = {
    get state() { return state; },
    go, blackout, playPlaylist: startPlaylist, stopPlaylist, setOutput,
    onChange: (l) => { changeListeners.add(l); return () => { changeListeners.delete(l); }; },
    touched: (by) => { rev.n++; rev.by = by; },
    setHomeAssistantStatus: (fn) => { homeAssistantStatus = fn; },
  };

  return { server, output, engine: () => engine, tick, show };
}
