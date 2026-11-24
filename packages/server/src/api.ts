import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildLayout, Engine, EFFECTS, LayoutError, validateScene, type LayerConfig, type LayoutConfig, type SceneConfig } from '@xmas/engine';
import { OutputLoop } from './output.js';
import { DEFAULT_HOUSE, saveState, type HouseConfig, type PresetConfig, type ShowState } from './store.js';
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
  logger?: boolean;
}

export interface App { server: FastifyInstance; output: OutputLoop; engine: () => Engine }

class HttpError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
const bad = (e: unknown) => new HttpError(400, (e as Error).message);

export async function createApp(opts: AppOptions): Promise<App> {
  const state = opts.state;
  let engine = new Engine(buildLayout(state.layout));
  engine.setOutput({ brightness: state.output.brightness, gamma: state.output.gamma });
  if (state.activeScene && state.scenes[state.activeScene]) {
    try { engine.setScene(state.scenes[state.activeScene]!); } catch { state.activeScene = null; }
  }
  const output = new OutputLoop(() => engine, state.output.fps);
  const persist = () => saveState(opts.statePath, state);

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
    pixels: engine.layout.count,
    output: { ...engine.output, enabled: state.output.enabled },
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
      try { next.setScene(state.scenes[state.activeScene]!); } catch { state.activeScene = null; }
    }
    engine = next;
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
    try { engine.setScene(s); } catch (e) { throw bad(e); }
    state.activeScene = s.name;
    await persist();
    return { active: s.name };
  });

  server.post('/api/blackout', async () => {
    engine.setScene({ name: 'Blackout', layers: [] });
    state.activeScene = null;
    await persist();
    return { active: null };
  });

  // ---- house model (3D scan) ------------------------------------------------
  const housePath = join(dirname(opts.statePath), 'house.glb');
  const MAX_MODEL_BYTES = 150 * 1024 * 1024;
  const house = () => ({ ...DEFAULT_HOUSE, ...(state.house ?? {}) });

  server.addContentTypeParser(['model/gltf-binary', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: MAX_MODEL_BYTES },
    (_req, body, done) => done(null, body));

  server.get('/api/house', async () => house());

  server.patch<{ Body: Partial<HouseConfig> }>('/api/house', async (req) => {
    const b = req.body ?? {};
    const next = house();
    if (b.position !== undefined) {
      if (!Array.isArray(b.position) || b.position.length !== 3 || !b.position.every((v) => Number.isFinite(v) && Math.abs(v) < 1000)) throw new HttpError(400, 'position must be [x, y, z] in metres');
      next.position = [b.position[0]!, b.position[1]!, b.position[2]!];
    }
    if (b.rotation !== undefined) {
      if (!Number.isFinite(b.rotation)) throw new HttpError(400, 'rotation must be degrees');
      next.rotation = ((b.rotation % 360) + 360) % 360;
    }
    if (b.scale !== undefined) {
      if (!Number.isFinite(b.scale) || b.scale <= 0 || b.scale > 100) throw new HttpError(400, 'scale must be > 0');
      next.scale = b.scale;
    }
    if (b.opacity !== undefined) {
      if (!Number.isFinite(b.opacity) || b.opacity < 0 || b.opacity > 1) throw new HttpError(400, 'opacity must be 0..1');
      next.opacity = b.opacity;
    }
    state.house = next;
    await persist();
    return next;
  });

  server.get('/api/house/model', async (_req, reply) => {
    if (!state.house?.model) throw new HttpError(404, 'no house model uploaded');
    let data: Buffer;
    try { data = await readFile(housePath); } catch { throw new HttpError(404, 'house model file is missing'); }
    reply.header('content-type', 'model/gltf-binary').header('cache-control', 'no-cache');
    return data;
  });

  /** Upload a binary glTF (.glb), e.g. exported from Scaniverse or Polycam. */
  server.put<{ Body: Buffer }>('/api/house/model', async (req) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length < 12 || body.toString('ascii', 0, 4) !== 'glTF' || body.readUInt32LE(4) !== 2) {
      throw new HttpError(400, 'expected a binary glTF 2.0 file (.glb)');
    }
    await mkdir(dirname(housePath), { recursive: true });
    await writeFile(`${housePath}.tmp`, body);
    await rename(`${housePath}.tmp`, housePath);
    state.house = { ...house(), model: { bytes: body.length, uploadedAt: new Date().toISOString() } };
    await persist();
    return { house: state.house };
  });

  server.delete('/api/house/model', async () => {
    if (!state.house?.model) throw new HttpError(404, 'no house model uploaded');
    await rm(housePath, { force: true });
    const { model: _model, ...rest } = house();
    state.house = rest;
    await persist();
    return { deleted: true };
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
  server.get('/api/output', async () => ({ ...engine.output, fps: output.fps, enabled: state.output.enabled }));

  server.patch<{ Body: Partial<ShowState['output']> }>('/api/output', async (req) => {
    const b = req.body ?? {};
    try { engine.setOutput({ ...(b.brightness !== undefined && { brightness: b.brightness }), ...(b.gamma !== undefined && { gamma: b.gamma }) }); } catch (e) { throw bad(e); }
    if (b.fps !== undefined) {
      if (!Number.isInteger(b.fps) || b.fps < 1 || b.fps > 60) throw new HttpError(400, 'fps must be an integer 1..60');
      output.fps = b.fps;
    }
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean');
      if (b.enabled) output.startStreaming(); else await output.stopStreaming();
    }
    state.output = { ...engine.output, fps: output.fps, enabled: b.enabled ?? state.output.enabled };
    await persist();
    return state.output;
  });

  /** Raw RGB frame (global pixel order) for previews and debugging. */
  server.get('/api/frame', async (_req, reply) => {
    reply.header('content-type', 'application/octet-stream');
    return Buffer.from(engine.render(output.now()));
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
    await server.register(fastifyStatic, { root: opts.webRoot });
  }
  // Unknown /api routes are 404 JSON, never the UI. The token hook above runs first for /api.
  server.setNotFoundHandler((req, reply) => { reply.code(404).send({ error: `no route ${req.method} ${req.url.split('?')[0]}` }); });

  server.addHook('onClose', async () => { await output.close(); });

  return { server, output, engine: () => engine };
}
