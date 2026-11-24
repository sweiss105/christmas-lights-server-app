import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildLayout, Engine, EFFECTS, LayoutError, validateScene, type LayerConfig, type LayoutConfig, type SceneConfig } from '@xmas/engine';
import { registerMapping } from './mapping.js';
import { OutputLoop } from './output.js';
import { inWindow, isTimeZone, nextWindow, playlistPosition, type PlaylistConfig, type ScheduleConfig } from './show.js';
import { DEFAULT_HOUSE, saveState, type HouseConfig, type HousePart, type PresetConfig, type ShowState } from './store.js';
import { discover, getInfo, getPresets, releaseToPreset } from './wled.js';

export interface AppOptions {
  state: ShowState;
  statePath: string;
  /** If set, every /api route except /api/health needs `Authorization: Bearer <token>`. */
  apiToken?: string;
  /** Directory with the built web UI (packages/web/dist), served at `/`. Skipped if unset or missing. */
  webRoot?: string;
  /** Injected for tests. */
  discoverFn?: typeof discover;
  /** Wall clock (ms) for playlists and the schedule; injected for tests, which then drive tick() themselves. */
  now?: () => number;
  logger?: boolean;
}

export interface App { server: FastifyInstance; output: OutputLoop; engine: () => Engine; /** Advance playlists and the schedule (runs every second in production). */ tick: () => Promise<void> }

class HttpError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
const bad = (e: unknown) => new HttpError(400, (e as Error).message);

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
  /** Save, recording what's on stage so a restart can bring it back exactly. */
  const persist = () => {
    if (state.activeScene) state.stage = engine.scene; else delete state.stage;
    return saveState(opts.statePath, state);
  };
  /** Crossfade time for Go and Blackout. Live edits never fade. */
  const fadeSeconds = () => state.output.transition ?? 1;

  const server = Fastify({ logger: opts.logger ?? false });

  server.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const code = err.statusCode ?? 500;
    if (code >= 500) server.log.error(err);
    reply.code(code).send({ error: err.message });
  });

  if (opts.apiToken) {
    const expected = Buffer.from(`Bearer ${opts.apiToken}`);
    server.addHook('onRequest', async (req) => {
      if (!req.url.startsWith('/api/') || req.url === '/api/health') return;
      const got = Buffer.from(req.headers.authorization ?? '');
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new HttpError(401, 'unauthorized');
    });
  }

  server.get('/api/health', async () => ({ ok: true }));

  /** True when the saved copy of the stage scene has Blind edits that are not on the porch yet. */
  const stageDirty = () => {
    const saved = state.activeScene ? state.scenes[state.activeScene] : undefined;
    if (!saved) return false;
    // Compare normalised forms: older saved scenes omit defaults that the running copy has filled in.
    try { return JSON.stringify(validateScene(saved, engine.layout)) !== JSON.stringify(engine.scene); } catch { return true; }
  };

  server.get('/api/status', async () => ({
    scene: state.activeScene,
    stage: { scene: state.activeScene, dirty: stageDirty() },
    playlist: playlistStatus(),
    schedule: scheduleStatus(),
    pixels: engine.layout.count,
    output: { ...engine.output, enabled: state.output.enabled, transition: fadeSeconds() },
    stream: output.stats(),
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
    let valid: SceneConfig;
    const probe = new Engine(engine.layout);
    try { valid = probe.setScene({ ...req.body, name: req.params.name }); } catch (e) { throw bad(e); }
    state.scenes[valid.name] = valid;
    if (apply === 'true' && state.activeScene === valid.name) engine.setScene(valid); // Live edit
    await persist();
    return valid;
  });

  server.delete<{ Params: { name: string } }>('/api/scenes/:name', async (req) => {
    if (!state.scenes[req.params.name]) throw new HttpError(404, 'no such scene');
    if (state.activeScene === req.params.name) throw new HttpError(409, 'cannot delete the active scene');
    delete state.scenes[req.params.name];
    await persist();
    return { deleted: req.params.name };
  });

  server.post<{ Params: { name: string } }>('/api/scenes/:name/activate', async (req) => {
    const s = state.scenes[req.params.name];
    if (!s) throw new HttpError(404, 'no such scene');
    try { engine.setScene(s, { fade: fadeSeconds() }); } catch (e) { throw bad(e); }
    state.activeScene = s.name;
    delete state.playing; // a manual Go takes over from a playlist
    await persist();
    return { active: s.name };
  });

  server.post('/api/blackout', async () => {
    engine.setScene({ name: 'Blackout', layers: [] }, { fade: fadeSeconds() });
    state.activeScene = null;
    delete state.playing;
    await persist();
    return { active: null };
  });

  // ---- playlists ---------------------------------------------------------------
  const now = opts.now ?? Date.now;
  const playlistStatus = () => {
    const pl = state.playing && state.playlists?.[state.playing.playlist];
    if (!pl || !state.playing) return null;
    const pos = playlistPosition(pl.entries, state.playing.startedAt, now(), pl.loop);
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
    }
    const pl: PlaylistConfig = { name, entries: entries.map((e) => ({ scene: e.scene, seconds: e.seconds })), loop: req.body?.loop !== false };
    state.playlists = { ...(state.playlists ?? {}), [name]: pl };
    await persist();
    return pl;
  });

  server.delete<{ Params: { name: string } }>('/api/playlists/:name', async (req) => {
    if (!state.playlists?.[req.params.name]) throw new HttpError(404, 'no such playlist');
    delete state.playlists[req.params.name];
    if (state.playing?.playlist === req.params.name) delete state.playing;
    await persist();
    return { deleted: req.params.name };
  });

  const startPlaylist = async (name: string) => {
    if (!state.playlists?.[name]) throw new HttpError(404, 'no such playlist');
    state.playing = { playlist: name, startedAt: now() };
    await advancePlaylist();
    await persist();
  };

  server.post<{ Params: { name: string } }>('/api/playlists/:name/play', async (req) => { await startPlaylist(req.params.name); return { playing: req.params.name }; });
  server.post('/api/playlists/stop', async () => { delete state.playing; await persist(); return { playing: null }; });

  /** Put the playlist's current scene on stage when it's time. */
  const advancePlaylist = async () => {
    const st = playlistStatus();
    if (!st?.scene || st.scene === state.activeScene) return;
    const scene = state.scenes[st.scene];
    if (!scene) return; // deleted since; skip
    try { engine.setScene(scene, { fade: fadeSeconds() }); } catch { return; }
    state.activeScene = scene.name;
    await persist();
  };

  // ---- nightly schedule ----------------------------------------------------------
  let lastInWindow: boolean | undefined; // undefined until the first tick: a restart mid-evening changes nothing
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
    lastInWindow = false;
    await persist();
    return scheduleStatus();
  });

  /** Called every second: advance a playlist, and switch the show on/off when the schedule says so. */
  const tick = async () => {
    await dailyBackup().catch((e) => server.log.error(e));
    await advancePlaylist();
    const s = state.schedule;
    if (!s?.enabled) { lastInWindow = undefined; return; }
    const inside = inWindow(s, now());
    if (lastInWindow === undefined) { lastInWindow = inside; return; }
    if (inside === lastInWindow) return;
    lastInWindow = inside;
    if (inside) {
      if (s.run.kind === 'playlist' && state.playlists?.[s.run.name]) await startPlaylist(s.run.name);
      else if (state.scenes[s.run.name]) {
        engine.setScene(state.scenes[s.run.name]!, { fade: fadeSeconds() });
        state.activeScene = s.run.name;
        delete state.playing;
      }
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
    const old = (await listBackups()).filter((b) => b.file.startsWith(prefix)).slice(keep);
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
    lastInWindow = undefined;
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

  server.get<{ Params: { id: string } }>('/api/house/parts/:id/model', async (req, reply) => {
    const p = part(req.params.id);
    let data: Buffer;
    try { data = await readFile(join(dataDir, p.file)); } catch { throw new HttpError(404, 'scan file is missing'); }
    reply.header('content-type', 'model/gltf-binary').header('cache-control', 'no-cache');
    return data;
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
    const { id: _id, enabled: _enabled, ...look } = layer;
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
    try { preset = validatePreset(name, req.body ?? {}); } catch (e) { throw bad(e); }
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

  // ---- output -------------------------------------------------------------
  server.get('/api/output', async () => ({ ...engine.output, fps: output.fps, enabled: state.output.enabled, transition: fadeSeconds() }));

  server.patch<{ Body: Partial<ShowState['output']> }>('/api/output', async (req) => {
    const b = req.body ?? {};
    try { engine.setOutput({ ...(b.brightness !== undefined && { brightness: b.brightness }), ...(b.gamma !== undefined && { gamma: b.gamma }) }); } catch (e) { throw bad(e); }
    if (b.fps !== undefined) {
      if (!Number.isInteger(b.fps) || b.fps < 1 || b.fps > 60) throw new HttpError(400, 'fps must be an integer 1..60');
      output.fps = b.fps;
    }
    if (b.transition !== undefined) {
      if (!Number.isFinite(b.transition) || b.transition < 0 || b.transition > 10) throw new HttpError(400, 'transition must be 0..10 seconds');
    }
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean');
      if (b.enabled) output.startStreaming(); else await output.stopStreaming();
    }
    state.output = { ...engine.output, fps: output.fps, enabled: b.enabled ?? state.output.enabled, transition: b.transition ?? state.output.transition ?? 1 };
    await persist();
    return state.output;
  });

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

  return { server, output, engine: () => engine, tick };
}
