import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDemoServer } from '../src/demoServer.js';
import { fixtureShow, realExtras } from './demo-fixture.js';

let dir: string;
let server: FastifyInstance;
const writeShow = async (body: string, mtime: number) => {
  await writeFile(join(dir, 'show.json'), body);
  await utimes(join(dir, 'show.json'), mtime, mtime); // a new mtime, as a real save gives
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xmas-demo-'));
  await writeShow(JSON.stringify(fixtureShow()), 1000);
  await writeFile(join(dir, 'house-part2.glb'), Buffer.alloc(16, 7));
  server = await createDemoServer({ dataDir: dir, extras: realExtras() });
});
afterEach(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });

describe('demo server', () => {
  it('serves the snapshot', async () => {
    const res = await server.inject({ method: 'GET', url: '/demo/show.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json().layout.controllers[0].host).toBe('demo.invalid');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses every method that could change something', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      for (const url of ['/demo/show.json', '/api/scenes/x', '/']) {
        const res = await server.inject({ method, url, payload: {} });
        expect(res.statusCode, `${method} ${url}`).toBe(405);
      }
    }
  });

  it('serves a house part by id and nothing else', async () => {
    const ok = await server.inject({ method: 'GET', url: '/api/house/parts/part2/model?v=1' });
    expect(ok.statusCode).toBe(200);
    expect(ok.rawPayload.length).toBe(16);
    expect(ok.headers['content-type']).toBe('model/gltf-binary');
    expect((await server.inject({ method: 'GET', url: '/api/house/parts/nope/model' })).statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: '/api/house/parts/..%2F..%2Fetc%2Fpasswd/model' })).statusCode).toBe(404);
  });

  it('has none of the real API', async () => {
    for (const url of ['/api/status', '/api/layout', '/api/frame', '/api/backups']) expect((await server.inject({ method: 'GET', url })).statusCode, url).toBe(404);
  });

  it('keeps serving the last good snapshot while the show file is unreadable', async () => {
    await server.inject({ method: 'GET', url: '/demo/show.json' });
    await writeShow('{', 2000);
    const res = await server.inject({ method: 'GET', url: '/demo/show.json' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().scenes)).toEqual(['Red', 'Green']);
  });

  it('follows the show file when it changes', async () => {
    await server.inject({ method: 'GET', url: '/demo/show.json' });
    const show = fixtureShow();
    show.scenes.Zed = { name: 'Zed', layers: [] };
    await writeShow(JSON.stringify(show), 3000);
    const res = await server.inject({ method: 'GET', url: '/demo/show.json' });
    expect(Object.keys(res.json().scenes)).toContain('Zed');
  });

  it('says the demo is unavailable when there has never been a good snapshot', async () => {
    await writeShow('{', 4000);
    const fresh = await createDemoServer({ dataDir: dir, extras: realExtras() });
    const res = await fresh.inject({ method: 'GET', url: '/demo/show.json' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('The demo is unavailable right now.');
    await fresh.close();
  });
});
