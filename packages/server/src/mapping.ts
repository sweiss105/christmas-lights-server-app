/**
 * Camera mapping on the server: plays the coded light sequence (taking over the output for a few
 * seconds, like Identify) and keeps what the phone found in each view, so positions can be solved
 * again later without filming again. The decoding and solving happen in the browser.
 */
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Engine } from '@xmas/engine';
import { clampParams, planMapping, slotMasks, type MappingParams, type MappingPlan } from '@xmas/engine/mapping';
import type { OutputLoop } from './output.js';

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** One light the phone found in one view: its pixel and where it was in the picture. */
export interface MappingDetection {
  pixel: number;
  /** Picture position in pixels of the decoded image (0,0 = top left). */
  x: number;
  y: number;
  /** Brightness above the background (sum over the blob) and how clearly its code read (0..1). */
  strength?: number;
  margin?: number;
}

/** Everything one view needs to be solved again: the picture size and what was found. */
export interface MappingView {
  id: string;
  createdAt: string;
  /** Picture size the positions refer to. */
  width: number;
  height: number;
  /** Pixels in the layout when it was filmed, as a check that indices still mean the same lights. */
  layoutPixels: number;
  params: MappingParams;
  detections: MappingDetection[];
  /** Free-form numbers from the decoder (blobs found, rejected, sync quality...). */
  stats?: Record<string, number>;
  label?: string;
}

export const MAX_SEQUENCE_MS = 180_000;
const MAX_VIEWS = 60;
const MAX_DETECTIONS = 20_000;

interface Running { plan: MappingPlan; masks: Uint8Array[]; startsAt: number; endsAt: number }

export interface MappingDeps {
  engine: () => Engine;
  output: OutputLoop;
  dataDir: string;
}

export function registerMapping(server: FastifyInstance, deps: MappingDeps) {
  const { output } = deps;
  let running: Running | null = null;
  /** Brightness test: the first pass's lights held steady, so the phone can judge how they look. */
  let preview: { mask: Uint8Array; level: number; until: number } | null = null;

  /** Draws the current slot over the frame, or nothing once the sequence is over. */
  const overlay = (frame: Uint8Array, t: number): boolean => {
    if (!running && preview) {
      if (t >= preview.until) { preview = null; return false; }
      const { brightness, gamma } = deps.engine().output;
      const v = Math.round(255 * Math.pow(Math.min(1, preview.level * brightness), gamma));
      const n = Math.min(frame.length / 3, preview.mask.length);
      frame.fill(0);
      for (let i = 0; i < n; i++) if (preview.mask[i]) { frame[i * 3] = v; frame[i * 3 + 1] = v; frame[i * 3 + 2] = v; }
      return true;
    }
    if (!running) return false;
    if (t >= running.endsAt) { running = null; return false; }
    const engine = deps.engine();
    // White at the master brightness, through the same output curve as every effect.
    const { brightness, gamma } = engine.output;
    const v = Math.round(255 * Math.pow(Math.min(1, running.plan.params.level * brightness), gamma));
    const slot = t < running.startsAt ? -1 : Math.floor(((t - running.startsAt) * 1000) / running.plan.params.holdMs);
    const mask = slot >= 0 ? running.masks[slot] : undefined;
    const n = Math.min(frame.length / 3, mask?.length ?? Infinity);
    frame.fill(0);
    if (mask) for (let i = 0; i < n; i++) if (mask[i]) { frame[i * 3] = v; frame[i * 3 + 1] = v; frame[i * 3 + 2] = v; }
    return true;
  };

  const status = () => ({
    active: running !== null && output.now() < running.endsAt,
    now: output.now(),
    streaming: output.running,
    ...(running && { startsAt: running.startsAt, endsAt: running.endsAt, params: running.plan.params }),
  });

  server.get('/api/mapping', async () => status());

  /**
   * Start the sequence `leadMs` from now (dark until then). Returns the plan, so the phone decodes
   * exactly what is played, and the start time on the server clock (`/api/clock`).
   */
  server.post<{ Body: Partial<MappingParams> & { leadMs?: number } }>('/api/mapping/start', async (req) => {
    const b = req.body ?? {};
    const lead = b.leadMs ?? 1500;
    if (!Number.isFinite(lead) || lead < 0 || lead > 10_000) throw httpError(400, 'leadMs must be 0..10000');
    const engine = deps.engine();
    const plan = planMapping(engine.layout, clampParams(b));
    if (plan.pixelCount === 0) throw httpError(409, 'the layout has no lights to map');
    if (plan.durationMs > MAX_SEQUENCE_MS) throw httpError(400, `that sequence would take ${Math.round(plan.durationMs / 1000)} s; use fewer passes or a shorter hold`);
    const startsAt = output.now() + lead / 1000;
    running = { plan, masks: slotMasks(engine.layout, plan), startsAt, endsAt: startsAt + plan.durationMs / 1000 };
    return { ...status(), plan };
  });

  server.post('/api/mapping/stop', async () => { running = null; preview = null; return status(); });

  /** Hold every k-th light on at `level` for `seconds` (max 30), to set the brightness by eye. */
  server.post<{ Body: Partial<MappingParams> & { seconds?: number } }>('/api/mapping/preview', async (req) => {
    const b = req.body ?? {};
    const seconds = b.seconds ?? 20;
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30) throw httpError(400, 'seconds must be 0..30');
    if (running) throw httpError(409, 'a mapping sequence is playing');
    const engine = deps.engine();
    const params = clampParams(b);
    const plan = planMapping(engine.layout, { ...params, passes: 1 });
    const mask = new Uint8Array(engine.layout.count);
    for (const i of plan.passes[0]?.pixels ?? []) mask[i] = 1;
    preview = seconds > 0 ? { mask, level: params.level, until: output.now() + seconds } : null;
    return { ...status(), preview: preview ? { lights: plan.passes[0]?.pixels.length ?? 0, level: params.level, until: preview.until } : null };
  });

  // ---- views: what the phone found, kept for solving again ------------------------------------
  const viewsPath = join(deps.dataDir, 'mapping-views.json');
  let views: MappingView[] | null = null;
  const load = async (): Promise<MappingView[]> => {
    if (views) return views;
    try { views = JSON.parse(await readFile(viewsPath, 'utf8')) as MappingView[]; } catch { views = []; }
    return views;
  };
  let writing: Promise<void> = Promise.resolve();
  const save = () => {
    const body = JSON.stringify(views ?? []) + '\n';
    writing = writing.then(async () => { await writeFile(`${viewsPath}.tmp`, body); await rename(`${viewsPath}.tmp`, viewsPath); });
    return writing;
  };

  server.get('/api/mapping/views', async () => load());

  server.post<{ Body: Partial<MappingView> }>('/api/mapping/views', { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const v = parseView(req.body, deps.engine().layout.count);
    const list = await load();
    list.push(v);
    while (list.length > MAX_VIEWS) list.shift();
    await save();
    return v;
  });

  server.delete<{ Params: { id: string } }>('/api/mapping/views/:id', async (req) => {
    const list = await load();
    const i = list.findIndex((v) => v.id === req.params.id);
    if (i < 0) throw httpError(404, 'no such view');
    list.splice(i, 1);
    await save();
    return { deleted: req.params.id };
  });

  server.delete('/api/mapping/views', async () => { views = []; await save(); return { deleted: 'all' }; });

  // ---- recordings: a small greyscale copy of a spot's footage, for checking the decoder -------
  // The phone sends it gzip-compressed (see web/src/mapping/cameraControl.ts for the layout).
  const recDir = join(deps.dataDir, 'mapping-recordings');
  const MAX_RECORDINGS = 6;
  const safeLabel = (v: unknown) => String(v ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40);
  server.post<{ Querystring: { view?: string; label?: string; gz?: string } }>('/api/mapping/recordings', { bodyLimit: 100 * 1024 * 1024 }, async (req) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length < 8) throw httpError(400, 'expected the recording as application/octet-stream');
    const gz = req.query.gz !== '0';
    if (gz && !(body[0] === 0x1f && body[1] === 0x8b)) throw httpError(400, 'expected gzip data');
    await mkdir(recDir, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}_${safeLabel(req.query.label) || 'spot'}_${safeLabel(req.query.view)}.bin${gz ? '.gz' : ''}`;
    await writeFile(join(recDir, `${name}.tmp`), body);
    await rename(join(recDir, `${name}.tmp`), join(recDir, name));
    // Keep the newest few: they're large and only for diagnosis.
    const files = (await readdir(recDir)).filter((f) => f.endsWith('.bin') || f.endsWith('.bin.gz')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - MAX_RECORDINGS))) await unlink(join(recDir, old)).catch(() => {});
    return { saved: name, bytes: body.length };
  });

  server.get('/api/mapping/recordings', async () => {
    const files = await readdir(recDir).catch(() => [] as string[]);
    return Promise.all(files.filter((f) => f.includes('.bin')).sort().map(async (f) => ({ file: f, bytes: (await stat(join(recDir, f))).size })));
  });

  return { overlay, stop: () => { running = null; } };
}

function parseView(b: Partial<MappingView> | undefined, layoutPixels: number): MappingView {
  if (!b || typeof b !== 'object') throw httpError(400, 'expected a view');
  const int = (v: unknown, what: string, max: number) => {
    if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > max) throw httpError(400, `${what} must be a whole number 1..${max}`);
    return v as number;
  };
  const width = int(b.width, 'width', 8192), height = int(b.height, 'height', 8192);
  if (!Array.isArray(b.detections) || b.detections.length > MAX_DETECTIONS) throw httpError(400, `detections must be a list of at most ${MAX_DETECTIONS}`);
  const detections: MappingDetection[] = b.detections.map((d) => {
    if (!d || !Number.isInteger(d.pixel) || d.pixel < 0 || d.pixel >= layoutPixels) throw httpError(400, 'each detection needs a pixel in the layout');
    if (!Number.isFinite(d.x) || !Number.isFinite(d.y) || d.x < -1 || d.y < -1 || d.x > width + 1 || d.y > height + 1) throw httpError(400, 'each detection needs x, y inside the picture');
    const out: MappingDetection = { pixel: d.pixel, x: d.x, y: d.y };
    if (Number.isFinite(d.strength)) out.strength = d.strength;
    if (Number.isFinite(d.margin)) out.margin = d.margin;
    return out;
  });
  const stats: Record<string, number> = {};
  if (b.stats && typeof b.stats === 'object') for (const [k, v] of Object.entries(b.stats).slice(0, 40)) if (Number.isFinite(v) && k.length <= 40) stats[k] = v as number;
  const label = typeof b.label === 'string' ? b.label.slice(0, 60) : undefined;
  return {
    id: `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
    width, height, layoutPixels,
    params: clampParams(b.params ?? {}),
    detections, stats, ...(label && { label }),
  };
}
