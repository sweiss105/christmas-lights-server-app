import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './api.js';
import { loadState } from './store.js';

const root = resolve(fileURLToPath(import.meta.url), '../../../..');
const statePath = resolve(process.env.XMAS_CONFIG ?? `${root}/config/local.json`);
const state = await loadState(statePath, `${root}/config/example.json`);

const app = await createApp({ state, statePath, apiToken: process.env.XMAS_API_TOKEN || undefined, logger: true });
if (!process.env.XMAS_API_TOKEN) app.server.log.warn('XMAS_API_TOKEN is not set: the API is open to anyone who can reach it. Put Cloudflare Access in front or set a token.');

app.output.startHealthChecks();
if (state.output.enabled) app.output.startStreaming();

const port = Number(process.env.PORT ?? 8080);
await app.server.listen({ host: process.env.HOST ?? '0.0.0.0', port });

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    app.server.log.info('shutting down: handing controllers back to their WLED presets');
    await app.output.stopStreaming(true);
    await app.server.close();
    process.exit(0);
  });
}
