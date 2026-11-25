import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setWallClock } from '@xmas/engine';
import { createApp } from './api.js';
import { homeAssistantOptionsFromEnv, startHomeAssistant, type HomeAssistantBridge } from './homeassistant.js';
import { loadStateOrBackup } from './store.js';

const root = resolve(fileURLToPath(import.meta.url), '../../../..');
const statePath = resolve(process.env.XMAS_CONFIG ?? `${root}/config/local.json`);
const startupWarnings: string[] = [];
const state = await loadStateOrBackup(statePath, `${root}/config/example.json`, (m) => startupWarnings.push(m));

const webRoot = resolve(process.env.XMAS_WEB_ROOT ?? `${root}/packages/web/dist`);
// Real time for #TIME/#DATE in Scrolling Text, in the process time zone (TZ; set XMAS_TZ in .env for Docker).
setWallClock(() => new Date());

const app = await createApp({ state, statePath, webRoot, apiToken: process.env.XMAS_API_TOKEN || undefined, logger: true });
for (const m of startupWarnings) app.server.log.error(m);
if (!existsSync(webRoot)) app.server.log.warn(`web UI not built (${webRoot} missing): only the API is served. Run npm run build -w @xmas/web.`);
if (!process.env.XMAS_API_TOKEN) app.server.log.warn('XMAS_API_TOKEN is not set: the API is open to anyone who can reach it. Put Cloudflare Access in front or set a token.');

app.output.startHealthChecks();
if (state.output.enabled) app.output.startStreaming();

const port = Number(process.env.PORT ?? 8080);
await app.server.listen({ host: process.env.HOST ?? '0.0.0.0', port });

// Home Assistant over MQTT, if XMAS_MQTT_URL is set. Never blocks startup: it connects (and retries) in the background.
let homeAssistant: HomeAssistantBridge | null = null;
const haOptions = homeAssistantOptionsFromEnv();
if (haOptions) {
  const log = app.server.log;
  homeAssistant = startHomeAssistant(app, haOptions, { info: (m) => log.info(m), warn: (m) => log.warn(m), error: (m) => log.error(m) });
  app.show.setHomeAssistantStatus(homeAssistant.status);
}

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    app.server.log.info('shutting down: handing controllers back to their WLED presets');
    await homeAssistant?.close().catch(() => {}); // first: it's quick, and a slow controller mustn't hold it up
    await app.output.stopStreaming(true);
    await app.server.close();
    process.exit(0);
  });
}
