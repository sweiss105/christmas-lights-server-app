/**
 * Camera mapping on the server: plays the coded light sequence (taking over the output for a few
 * seconds, like Identify) and keeps what the phone found in each view, so positions can be solved
 * again later without filming again. The decoding and solving happen in the browser.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
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

  /** Draws the current slot over the frame, or nothing once the sequence is over. */
  const overlay = (frame: Uint8Array, t: number): boolean => {
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

  server.post('/api/mapping/stop', async () => { running = null; return status(); });

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
