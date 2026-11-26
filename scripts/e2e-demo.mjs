#!/usr/bin/env node
/**
 * Browser check of the public demo: starts the demo server on a copy of a show folder (read-only use;
 * nothing is sent anywhere), opens the demo build in headless Chromium and checks what a visitor sees.
 *
 *   npm run build:web:demo && node scripts/e2e-demo.mjs [data folder]
 *
 * The data folder defaults to ./data (show.json and the house .glb files). PLAYWRIGHT_MODULE and
 * E2E_SHOTS work as in e2e-smoke.mjs; screenshots are taken at desktop and phone sizes.
 */
import { spawn } from 'node:child_process';
import { cp, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const PORT = Number(process.env.E2E_PORT ?? 8096);
const base = `http://127.0.0.1:${PORT}`;
const shots = process.env.E2E_SHOTS;

const dir = await mkdtemp(join(tmpdir(), 'xmas-e2e-demo-'));
await cp(resolve(process.argv[2] ?? join(root, 'data')), dir, { recursive: true, filter: (p) => !p.includes('backups') && !p.includes('mapping-recordings') });

const server = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', join(root, 'packages/server/src/demo.ts')], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', XMAS_DEMO_DATA: dir },
  stdio: 'ignore',
});
const stop = () => { try { server.kill('SIGKILL'); } catch { /* already gone */ } };
process.on('exit', stop);

const failures = [];
const check = (ok, what) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) failures.push(what); };
const shows = (locator) => locator.first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false);

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/demo/show.json`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  check((await fetch(`${base}/demo/show.json`, { method: 'POST' })).status === 405, 'the demo server refuses writes');
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

  for (const size of [{ name: 'desktop', viewport: { width: 1440, height: 900 } }, { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]) {
    const page = await browser.newPage({ viewport: size.viewport, deviceScaleFactor: 2, isMobile: size.isMobile, hasTouch: size.hasTouch });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const requests = [];
    page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/') && !r.url().includes('/api/house/parts/')) requests.push(r.url()); });

    await page.goto(`${base}/#/setup/house`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.library-row, .porch-card', { timeout: 20000 });
    check(await shows(page.locator('.demo-ribbon', { hasText: 'nothing here is connected to real lights' })), `${size.name}: the demo ribbon shows`);
    check(await page.locator('.porch-card').count() === 1, `${size.name}: a Setup address opens Control`);
    check(!(await page.locator('.page-switch, .page-menu').getByText('Setup').count()), `${size.name}: there is no Setup page to switch to`);
    check(await page.locator('.preview-canvas canvas').count() === 1, `${size.name}: the 3D preview renders`);
    await page.waitForTimeout(2500); // the house model loads
    check(!(await page.locator('.toast').count()), `${size.name}: no error message on opening`);
    if (shots) await page.screenshot({ path: join(shots, `demo-${size.name}-control.png`) });

    if (size.name === 'desktop') {
      const scene = page.locator('.porch-scene');
      const before = await scene.textContent();
      const go = page.locator('.go-btn:not([disabled])').first();
      const target = (await go.getAttribute('aria-label')).replace(/^Go /, '');
      await go.click();
      await page.waitForTimeout(1500);
      check((await scene.textContent()).startsWith(target) && target !== before, `Go puts "${target}" on stage in this tab`);
      check(!(await page.locator('.toast').count()), 'no error message after Go');
      if (shots) await page.screenshot({ path: join(shots, 'demo-desktop-go.png') });
      check(!(await page.locator('.control-panel [role="tab"]', { hasText: 'Schedule' }).count()), 'Control has no Schedule tab');

      await page.locator('.page-switch').getByRole('link', { name: 'Create', exact: true }).click();
      await page.waitForTimeout(800);
      check(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), 'Save is turned off in Create');
      if (shots) await page.screenshot({ path: join(shots, 'demo-desktop-create.png') });
    }
    check(requests.length === 0, `${size.name}: no request reaches a server API (${requests.slice(0, 3).join(', ')})`);
    check(errors.length === 0, `${size.name}: no page errors ${errors.slice(0, 3).join(' | ')}`);
    await page.close();
  }
  await browser.close();
} catch (e) {
  failures.push(String(e));
  console.error(e);
} finally {
  stop();
}
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nall demo checks passed');
