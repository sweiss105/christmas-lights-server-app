#!/usr/bin/env node
/**
 * Browser smoke test: starts a throwaway server (controller address 192.0.2.1, which nothing answers,
 * so the real porch is never touched), opens the built UI in headless Chromium and clicks through the
 * main screens at desktop and phone sizes.
 *
 *   npm run build:web && npm run e2e
 *
 * Needs the `playwright` package and its Chromium (npx playwright install chromium-headless-shell).
 * Set PLAYWRIGHT_MODULE to a playwright install elsewhere (e.g. a scratch folder) if it isn't in
 * node_modules.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const PORT = Number(process.env.E2E_PORT ?? 8097);
const base = `http://127.0.0.1:${PORT}`;

// A copy of the example show with a dummy controller address.
const dir = await mkdtemp(join(tmpdir(), 'xmas-e2e-'));
const show = JSON.parse(await readFile(join(root, 'config/example.json'), 'utf8'));
for (const c of show.layout.controllers) c.host = '192.0.2.1';
show.output.enabled = false;
await writeFile(join(dir, 'show.json'), JSON.stringify(show));

// One process (tsx as a loader, not its CLI, which forks a child that would outlive a kill).
const server = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', join(root, 'packages/server/src/main.ts')], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', XMAS_CONFIG: join(dir, 'show.json') },
  stdio: 'ignore',
});
const stop = () => { try { server.kill('SIGKILL'); } catch { /* already gone */ } };
process.on('exit', stop);

const failures = [];
const check = (ok, what) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) failures.push(what); };
/** True once the locator is visible (panels that load data show a moment later). */
const shows = (locator) => locator.first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false);

try {
  // Refuse to test against something already on the port (e.g. a server left over from a crashed run).
  try { await fetch(`${base}/api/health`); throw new Error(`port ${PORT} is already in use; set E2E_PORT`); } catch (e) { if (String(e).includes('already in use')) throw e; }
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

  // Desktop / tablet
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('.scene-row', { timeout: 15000 });
  check(await page.locator('.preview-canvas canvas').count() === 1, 'the 3D preview renders');
  const names = await page.locator('.scene-row .scene-name').allTextContents();
  check(names.includes('Candy cane'), 'scenes are listed');
  await page.getByRole('listbox', { name: 'Scenes' }).getByRole('option', { name: 'Aurora' }).click();
  check(await shows(page.getByRole('heading', { name: 'Aurora' })), 'picking a scene opens it in the editor');
  await page.getByRole('button', { name: 'Go Aurora' }).click();
  await page.waitForTimeout(800);
  const status = await (await fetch(`${base}/api/status`)).json();
  check(status.stage.scene === 'Aurora', 'Go puts the scene on stage');
  await page.getByRole('button', { name: '+ Add layer', exact: true }).click();
  check(await shows(page.getByRole('dialog', { name: 'Add a layer' })), 'the layer picker opens');
  await page.getByRole('tab', { name: /^Playlists/ }).click();
  check(await shows(page.getByRole('button', { name: '+ New playlist' })), 'the Playlists tab opens');
  await page.getByRole('tab', { name: /^Schedule/ }).click();
  check(await shows(page.getByText('Run the show every night')), 'the Schedule tab opens');
  await page.getByRole('button', { name: 'Backups', exact: true }).click();
  check(await shows(page.getByRole('dialog', { name: 'Backups' })), 'the Backups panel opens');
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);

  // Phone
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(base, { waitUntil: 'networkidle' });
  await phone.waitForSelector('.phone-tabs', { timeout: 15000 });
  await phone.getByRole('radio', { name: 'Edit', exact: true }).click();
  check(await phone.locator('.editor').isVisible() && !(await phone.locator('.scenes').isVisible()), 'the phone layout switches between Scenes and Edit');

  await browser.close();
} catch (e) {
  failures.push(String(e));
  console.error(e);
} finally {
  stop();
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
