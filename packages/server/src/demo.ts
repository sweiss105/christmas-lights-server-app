/** Entry point of the public demo's server (see demoServer.ts). Never touches the lights. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DemoExtras } from '@xmas/engine';
import { createDemoServer } from './demoServer.js';

const root = resolve(fileURLToPath(import.meta.url), '../../../..');
const extras = JSON.parse(await readFile(`${root}/config/demo-extras.json`, 'utf8')) as DemoExtras;
const server = await createDemoServer({
  dataDir: resolve(process.env.XMAS_DEMO_DATA ?? '/data'),
  webRoot: resolve(process.env.XMAS_DEMO_WEB_ROOT ?? `${root}/packages/web/dist-demo`),
  extras,
  logger: true,
});
await server.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 8091) });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void server.close().then(() => process.exit(0)); });
