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
  const camera = page.getByRole('radiogroup', { name: 'Camera' });
  const houseView = camera.getByRole('radio', { name: 'House', exact: true });
  check(await houseView.isVisible(), 'the camera has a House view');
  await houseView.click();
  await page.waitForTimeout(500);
  const box = await page.locator('.preview-canvas canvas').boundingBox();
  check(await houseView.getAttribute('aria-checked') === 'true' && !!box && box.width > 300 && box.height > 300 && errors.length === 0, 'the House view is picked and the preview still renders');
  await camera.getByRole('radio', { name: 'Angle', exact: true }).click();
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

  // Edits change a working copy in the browser; the stored scene changes only on Save.
  const storedLayers = async (name) => {
    const res = await fetch(`${base}/api/scenes/${encodeURIComponent(name)}`);
    return res.ok ? (await res.json()).layers : null;
  };
  const sceneList = page.getByRole('listbox', { name: 'Scenes' });
  const addLayer = async () => {
    await page.getByRole('button', { name: '+ Add layer', exact: true }).click();
    await page.getByRole('dialog', { name: 'Add a layer' }).getByRole('option', { name: /^Rainbow/ }).first().click();
  };
  const answer = async (label) => {
    const dialog = page.locator('.dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await dialog.getByRole('button', { name: label, exact: true }).click();
  };
  const unsavedNote = page.getByText('· Unsaved changes');
  const auroraBefore = (await storedLayers('Aurora')).length;
  await addLayer();
  await page.waitForTimeout(600);
  check((await storedLayers('Aurora')).length === auroraBefore, 'an edit in Blind leaves the stored scene alone');
  check(await shows(unsavedNote) && await sceneList.getByRole('option', { name: 'Aurora' }).locator('.unsaved-dot').isVisible(), 'unsaved changes show in the editor and the scene list');
  await page.getByRole('button', { name: 'Revert', exact: true }).click();
  await answer('Revert');
  await page.waitForTimeout(300);
  check(!(await unsavedNote.isVisible()) && await page.locator('.layer-list .layer-row').count() === auroraBefore, 'Revert throws the edits away');
  await addLayer();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(600);
  check((await storedLayers('Aurora')).length === auroraBefore + 1 && !(await unsavedNote.isVisible()), 'Save stores the edits');
  await addLayer();
  await page.getByRole('button', { name: 'Save as new…', exact: true }).click();
  await page.locator('.dialog input').fill('Aurora plus');
  await answer('Save');
  await page.waitForTimeout(600);
  check((await storedLayers('Aurora plus'))?.length === auroraBefore + 2 && (await storedLayers('Aurora')).length === auroraBefore + 1, 'Save as new stores a new scene and leaves the original');
  check(await shows(page.getByRole('heading', { name: 'Aurora plus' })), 'the editor shows the new scene after Save as new');
  await addLayer();
  await sceneList.getByRole('option', { name: 'Candy cane' }).click();
  check(await shows(page.getByRole('dialog', { name: 'Unsaved changes' })), 'opening another scene with unsaved edits asks first');
  await answer('Cancel');
  check(await shows(page.getByRole('heading', { name: 'Aurora plus' })), 'Cancel stays on the scene with its edits');
  await sceneList.getByRole('option', { name: 'Candy cane' }).click();
  await answer('Discard');
  check(await shows(page.getByRole('heading', { name: 'Candy cane' })) && (await storedLayers('Aurora plus')).length === auroraBefore + 2, 'Discard drops the edits and opens the other scene');
  await page.getByRole('button', { name: '+ New', exact: true }).click();
  check(await shows(page.getByRole('heading', { name: 'New scene' })) && await page.locator('.layer-list .layer-row').count() === 0, 'New starts a blank scene');
  check((await storedLayers('New scene')) === null, 'a new scene is not stored until it is saved');
  await sceneList.getByRole('option', { name: 'Candy cane' }).click(); // blank: nothing to ask
  // Select mode: there must be ways back to the editor (Done, Esc, or picking a scene).
  const editorBack = () => shows(page.getByRole('heading', { name: 'Candy cane' }));
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  check(await shows(page.getByRole('complementary', { name: 'Select lights' })), 'the Select panel opens');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('listbox', { name: 'Scenes' }).getByRole('option', { name: 'Candy cane' }).click();
  check(await editorBack() && !(await page.getByRole('complementary', { name: 'Select lights' }).isVisible()), 'picking a scene leaves Select for the editor');
  // Paint mode starts a new, blank scene: brush strokes become its painted layers, one undo step each;
  // Erase wipes them. Nothing is stored until Save as new.
  const shot = (name) => (process.env.E2E_SHOTS ? page.screenshot({ path: join(process.env.E2E_SHOTS, `${name}.png`) }) : null);
  const paintItems = page.locator('.paint-list .group-item');
  const scribble = async () => {
    await page.mouse.move(330, 240);
    await page.mouse.down();
    for (let y = 240; y <= 680; y += 40) { await page.mouse.move(900, y, { steps: 6 }); await page.mouse.move(330, y + 20, { steps: 6 }); }
    await page.mouse.up();
    await page.waitForTimeout(300);
  };
  const candyBefore = JSON.stringify(await storedLayers('Candy cane'));
  await page.getByRole('button', { name: 'Paint', exact: true }).click();
  check(await shows(page.getByRole('complementary', { name: 'Paint on the lights' })), 'the Paint panel opens');
  check(await shows(page.getByRole('heading', { name: 'Painting' })) && await paintItems.count() === 0 && await page.getByText('Nothing painted yet').isVisible(), 'Paint starts from a blank canvas, not the current scene');
  for (let i = 0; i < 4; i++) await page.keyboard.press(']');
  await scribble();
  await shot('paint-colour');
  check(await paintItems.count() === 1, 'a brush stroke adds a painted layer');
  await page.getByRole('radio', { name: 'Effect', exact: true }).click();
  await page.getByRole('dialog', { name: 'Add a layer' }).getByRole('option', { name: /^Rainbow/ }).first().click();
  await scribble();
  await shot('paint-effect');
  check(await paintItems.count() === 2, 'painting an effect adds a second painted layer');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  check(await paintItems.count() === 1, 'Undo takes back one whole stroke');
  await page.getByRole('radio', { name: 'Erase', exact: true }).click();
  await scribble();
  check(await paintItems.count() === 0, 'Erase wipes the paint off');
  await page.getByRole('radio', { name: 'Paint', exact: true }).click();
  await page.getByRole('radio', { name: 'Colour', exact: true }).click();
  await scribble();
  check((await storedLayers('Painting')) === null && JSON.stringify(await storedLayers('Candy cane')) === candyBefore, 'painting stores nothing on the server');
  await page.getByRole('button', { name: 'Save as new…', exact: true }).click();
  await page.locator('.dialog input').fill('Snowy roof');
  await answer('Save');
  await page.waitForTimeout(600);
  const snowy = await storedLayers('Snowy roof');
  check(snowy?.length === 1 && typeof snowy[0].paint === 'string', 'Save as new stores the painting as a scene');
  await page.keyboard.press('Escape');
  check(await shows(page.getByRole('heading', { name: 'Snowy roof' })) && !(await page.getByRole('complementary', { name: 'Paint on the lights' }).isVisible()), 'Esc leaves Paint for the editor');
  await page.getByRole('button', { name: 'Paint', exact: true }).click();
  await scribble();
  await page.keyboard.press('Escape');
  check(await shows(page.getByRole('dialog', { name: 'Unsaved changes' })), 'leaving Paint with an unsaved painting asks');
  await answer('Discard');
  check(await shows(page.getByRole('heading', { name: 'Snowy roof' })) && (await storedLayers('Painting')) === null, 'Discard drops the painting and goes back to the scene before');
  await sceneList.getByRole('option', { name: 'Candy cane' }).click();
  await editorBack();
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await page.locator('.preview-canvas').click({ position: { x: 640, y: 700 } });
  await page.keyboard.press('Escape');
  check(!(await page.getByRole('complementary', { name: 'Layout editor' }).isVisible()), 'Esc leaves Layout');
  await page.getByRole('tab', { name: /^Playlists/ }).click();
  check(await shows(page.getByRole('button', { name: '+ New playlist' })), 'the Playlists tab opens');
  // Per-scene fades: "Fade all" sets every scene, one scene can then differ, and Save keeps both.
  await page.getByRole('button', { name: '+ New playlist' }).click();
  await page.getByRole('button', { name: '+ Add scene' }).click();
  await page.getByLabel('Seconds to fade into every scene', { exact: true }).fill('2');
  await page.getByLabel('Seconds to fade into scene 1', { exact: true }).fill('0.7');
  await page.getByRole('button', { name: 'Save playlist' }).click();
  await shows(page.getByRole('button', { name: '+ New playlist' }));
  const savedFades = (await (await fetch(`${base}/api/playlists`)).json()).find((p) => p.name === 'Evening')?.entries.map((e) => e.fade);
  check(JSON.stringify(savedFades) === '[0.7,2]', `the playlist editor saves each scene's fade (got ${JSON.stringify(savedFades)})`);
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
  // Palette colours: the selected palette's colours show as swatches; changing one makes an edited copy
  // that the preview draws at once, and Undo puts the original back.
  const sceneApi = `${base}/api/scenes/${encodeURIComponent('Palette test')}`;
  const savedLayer = async () => (await (await fetch(sceneApi)).json()).layers[0];
  await fetch(`${sceneApi}?apply=false`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layers: [{ id: 'p', effect: 'wled-palette', params: { palette: 'Party', check1: false } }] }) });
  await page.getByRole('listbox', { name: 'Scenes' }).getByRole('option', { name: 'Palette test' }).click({ timeout: 8000 });
  const swatches = page.getByRole('group', { name: 'Colours of Party' }).locator('input[type="color"]');
  check(await shows(swatches) && await swatches.count() === 16, 'the selected palette shows its colours as swatches');
  const canvas = page.locator('.preview-canvas canvas');
  await page.waitForTimeout(500);
  const shotBefore = await canvas.screenshot();
  await page.getByLabel('Palette colour 1 of 16', { exact: true }).fill('#00ff00');
  await page.waitForTimeout(800);
  check(await shows(page.getByRole('button', { name: 'Palette: Party (edited)' })), 'changing a colour makes an edited copy of the palette');
  check(!shotBefore.equals(await canvas.screenshot()), 'the preview shows the edited palette');
  check((await savedLayer()).params.palette === 'Party', 'the palette edit is not stored before Save');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(600);
  const edited = await savedLayer();
  check(edited.params.palette === 'Party (edited)' && edited.params.paletteStops?.[0]?.[1] === '#00ff00', 'the edited colours are saved with the layer');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(600);
  const undone = await savedLayer();
  check(undone.params.palette === 'Party' && undone.params.paletteStops === undefined, 'Undo puts the original palette back');
  const camErrors = errors.filter((e) => !/camera|getUserMedia|NotFound|NotAllowed|Requested device/i.test(e));
  check(camErrors.length === 0, `no page errors${camErrors.length ? `: ${camErrors.join(' | ')}` : ''}`);

  // Phone
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(base, { waitUntil: 'networkidle' });
  await phone.waitForSelector('.phone-tabs', { timeout: 15000 });
  await phone.getByRole('radio', { name: 'Edit', exact: true }).click();
  check(await phone.locator('.editor').isVisible() && !(await phone.locator('.scenes').isVisible()), 'the phone layout switches between Scenes and Edit');
  await phone.getByRole('radio', { name: 'House', exact: true }).click();
  check(await phone.getByRole('radio', { name: 'House', exact: true }).getAttribute('aria-checked') === 'true', 'the phone has the camera views');

  // Map lights in demo mode (a simulated camera, nothing sent to the server's lights): one spot end to end.
  // The simulated camera waits for the decoder rather than dropping frames, so a busy machine only makes it slower
  // (about 17 s when idle). Close the other pages so their 3D views don't add to that, then wait for the spot to end
  // either way: found, or the error the screen shows.
  await page.close();
  await phone.close();
  const demo = await browser.newPage({ viewport: { width: 430, height: 932 } });
  const demoErrors = [];
  demo.on('pageerror', (e) => demoErrors.push(e.message));
  await demo.goto(`${base}/#map-demo`, { waitUntil: 'networkidle' });
  await demo.locator('.map-start').click();
  const before = (await (await fetch(`${base}/api/mapping/views`)).json()).length;
  const foundHead = demo.getByRole('heading', { name: /^Found \d+ lights$/ });
  const outcome = await foundHead.or(demo.getByRole('heading', { name: 'That spot didn’t work' })).waitFor({ timeout: 180000 })
    .then(async () => (await foundHead.isVisible() ? 'found' : `failed: ${await demo.locator('.map-warn').first().textContent()}`), () => 'still running after 3 minutes');
  check(outcome === 'found', `a demo spot is filmed and decoded${outcome === 'found' ? '' : ` (${outcome})`}`);
  const found = outcome === 'found' ? Number((await foundHead.textContent()).match(/\d+/)[0]) : 0;
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
