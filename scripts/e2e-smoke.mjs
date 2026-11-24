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
  await page.keyboard.press('Escape'); // close the layer picker
  // Select mode: there must be ways back to the editor (Done, Esc, or picking a scene).
  const editorBack = () => shows(page.getByRole('heading', { name: 'Candy cane' }));
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  check(await shows(page.getByRole('complementary', { name: 'Select lights' })), 'the Select panel opens');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('listbox', { name: 'Scenes' }).getByRole('option', { name: 'Candy cane' }).click();
  check(await editorBack() && !(await page.getByRole('complementary', { name: 'Select lights' }).isVisible()), 'picking a scene leaves Select for the editor');
  // Paint mode: brush strokes become painted layers of the scene, one undo step each; Erase wipes them.
  const shot = (name) => (process.env.E2E_SHOTS ? page.screenshot({ path: join(process.env.E2E_SHOTS, `${name}.png`) }) : null);
  const paintedLayers = async () => (await (await fetch(`${base}/api/scenes/${encodeURIComponent('Candy cane')}`)).json()).layers.filter((l) => typeof l.paint === 'string');
  const scribble = async () => {
    await page.mouse.move(330, 240);
    await page.mouse.down();
    for (let y = 240; y <= 680; y += 40) { await page.mouse.move(900, y, { steps: 6 }); await page.mouse.move(330, y + 20, { steps: 6 }); }
    await page.mouse.up();
    await page.waitForTimeout(600); // the save
  };
  await page.getByRole('button', { name: 'Paint', exact: true }).click();
  check(await shows(page.getByRole('complementary', { name: 'Paint on the lights' })), 'the Paint panel opens');
  for (let i = 0; i < 4; i++) await page.keyboard.press(']');
  await scribble();
  await shot('paint-colour');
  let painted = await paintedLayers();
  check(painted.length === 1 && painted[0].effect === 'solid' && painted[0].paint.length > 0, 'a brush stroke adds a painted layer to the scene');
  await page.getByRole('radio', { name: 'Effect', exact: true }).click();
  await page.getByRole('dialog', { name: 'Add a layer' }).getByRole('option', { name: /^Rainbow/ }).first().click();
  await scribble();
  await shot('paint-effect');
  painted = await paintedLayers();
  check(painted.at(-1).effect !== 'solid' && painted.at(-1).paint.length > 0, 'painting an effect puts it on top of the colour');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForTimeout(600);
  painted = await paintedLayers();
  check(painted.length === 1 && painted[0].effect === 'solid', 'Undo takes back one whole stroke');
  await page.getByRole('radio', { name: 'Erase', exact: true }).click();
  await scribble();
  check((await paintedLayers()).length === 0, 'Erase wipes the paint off');
  await page.keyboard.press('Escape');
  check(await editorBack() && !(await page.getByRole('complementary', { name: 'Paint on the lights' }).isVisible()), 'Esc leaves Paint for the editor');
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await page.locator('.preview-canvas').click({ position: { x: 640, y: 700 } });
  await page.keyboard.press('Escape');
  check(!(await page.getByRole('complementary', { name: 'Layout editor' }).isVisible()), 'Esc leaves Layout');
  await page.getByRole('tab', { name: /^Playlists/ }).click();
  check(await shows(page.getByRole('button', { name: '+ New playlist' })), 'the Playlists tab opens');
  await page.getByRole('tab', { name: /^Schedule/ }).click();
  check(await shows(page.getByText('Run the show every night')), 'the Schedule tab opens');
  await page.getByRole('button', { name: 'Backups', exact: true }).click();
  check(await shows(page.getByRole('dialog', { name: 'Backups' })), 'the Backups panel opens');
  // Map lights: the filming screen opens (headless Chromium has no camera, so it explains that) and closes again.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  check(await shows(page.getByRole('dialog', { name: 'Map lights' })), 'the Map lights screen opens');
  await page.getByRole('button', { name: 'Close mapping' }).click();
  check(await shows(page.locator('.scene-row')), 'closing Map lights goes back to the app');
  const camErrors = errors.filter((e) => !/camera|getUserMedia|NotFound|NotAllowed|Requested device/i.test(e));
  check(camErrors.length === 0, `no page errors${camErrors.length ? `: ${camErrors.join(' | ')}` : ''}`);

  // Phone
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(base, { waitUntil: 'networkidle' });
  await phone.waitForSelector('.phone-tabs', { timeout: 15000 });
  await phone.getByRole('radio', { name: 'Edit', exact: true }).click();
  check(await phone.locator('.editor').isVisible() && !(await phone.locator('.scenes').isVisible()), 'the phone layout switches between Scenes and Edit');

  // Map lights in demo mode (a simulated camera, nothing sent to the server's lights): one spot end to end.
  const demo = await browser.newPage({ viewport: { width: 430, height: 932 } });
  const demoErrors = [];
  demo.on('pageerror', (e) => demoErrors.push(e.message));
  await demo.goto(`${base}/#map-demo`, { waitUntil: 'networkidle' });
  await demo.locator('.map-start').click();
  const before = (await (await fetch(`${base}/api/mapping/views`)).json()).length;
  check(await demo.getByRole('heading', { name: /^Found \d+ lights$/ }).waitFor({ timeout: 40000 }).then(() => true, () => false), 'a demo spot is filmed and decoded');
  const found = Number((await demo.getByRole('heading', { name: /^Found/ }).textContent()).match(/\d+/)[0]);
  check(found > 20, `the demo spot finds lights (${found})`);
  check((await (await fetch(`${base}/api/mapping/views`)).json()).length === before, 'demo spots stay in the page (nothing saved on the server)');
  await demo.getByRole('button', { name: 'Review', exact: true }).last().click();
  check(await shows(demo.getByRole('complementary', { name: 'Mapping results' })), 'Review shows the mapping results');
  check(demoErrors.length === 0, `no page errors in demo mapping${demoErrors.length ? `: ${demoErrors.join(' | ')}` : ''}`);

  await browser.close();
} catch (e) {
  failures.push(String(e));
  console.error(e);
} finally {
  stop();
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
