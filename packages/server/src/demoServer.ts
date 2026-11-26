/**
 * The public demo's server: read-only files and nothing else. It serves the demo build of the web UI,
 * the demo snapshot (rebuilt from the real show file when that changes) and the house model. It
 * answers only GET and HEAD, has no API, and imports nothing that can reach the lights or the network.
 */
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DemoExtras, DemoSnapshot } from '@xmas/engine';
import { buildDemoSnapshot } from './demoSnapshot.js';
import type { ShowState } from './store.js';

export interface DemoServerOptions {
  /** Folder with the real show file and the house scans (mounted read-only in the container). */
  dataDir: string;
  showFile?: string;
  extras: DemoExtras;
  /** The demo build of the web UI (packages/web/dist-demo). Skipped if unset or missing. */
  webRoot?: string;
  logger?: boolean;
}

export async function createDemoServer(opts: DemoServerOptions): Promise<FastifyInstance> {
  const showPath = join(opts.dataDir, opts.showFile ?? 'show.json');
  const server = Fastify({ logger: opts.logger ?? false });

  /** The last good snapshot, and the show it came from (for the house files), keyed on the file's mtime and size. */
  let cached: { key: string; show: ShowState; snapshot: DemoSnapshot } | null = null;
  const current = async () => {
    try {
      const s = await stat(showPath);
      const key = `${s.mtimeMs}:${s.size}`;
      if (cached?.key === key) return cached;
      const show = JSON.parse(await readFile(showPath, 'utf8')) as ShowState;
      cached = { key, show, snapshot: buildDemoSnapshot(show, opts.extras) };
    } catch (e) {
      server.log.warn(`demo: could not build a snapshot from ${showPath} (${(e as Error).message}); ${cached ? 'keeping the last good one' : 'none yet'}`);
    }
    return cached;
  };

  server.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply.code(405).header('allow', 'GET, HEAD').send({ error: 'read-only' });
  });

  server.get('/demo/show.json', async (_req, reply) => {
    const c = await current();
    if (!c) return reply.code(503).send({ error: 'The demo is unavailable right now.' });
    return reply.header('cache-control', 'no-cache').send(c.snapshot);
  });

  server.get<{ Params: { id: string }; Querystring: { v?: string } }>('/api/house/parts/:id/model', async (req, reply) => {
    const c = await current();
    // Only files the show names, found by part id: the request never becomes a path.
    const part = c?.show.house?.parts?.find((p) => p.id === req.params.id);
    if (!part) return reply.code(404).send({ error: 'no such part' });
    const path = join(opts.dataDir, part.file);
    let bytes: number;
    try { bytes = (await stat(path)).size; } catch { return reply.code(404).send({ error: 'scan file is missing' }); }
    reply.header('content-type', 'model/gltf-binary').header('content-length', bytes)
      .header('cache-control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    return reply.send(createReadStream(path));
  });

  if (opts.webRoot && existsSync(opts.webRoot)) {
    await server.register(fastifyStatic, {
      root: opts.webRoot,
      cacheControl: false,
      setHeaders: (reply, path) => {
        const r = reply as unknown as { header?: (k: string, v: string) => void; setHeader?: (k: string, v: string) => void };
        const value = /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache';
        if (r.header) r.header('cache-control', value); else r.setHeader?.('cache-control', value);
      },
    });
  }
  server.setNotFoundHandler((req, reply) => { reply.code(404).send({ error: `no route ${req.method} ${req.url.split('?')[0]}` }); });
  return server;
}
