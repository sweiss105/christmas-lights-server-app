#!/usr/bin/env node
/**
 * Browser smoke test: starts a throwaway server (controller address 192.0.2.1, which nothing answers,
 * so the real porch is never touched), opens the built UI in headless Chromium and clicks through the
 * three pages (Create, Control, Setup) and the full-screen display at desktop and phone sizes.
 *
 *   npm run build:web && npm run e2e
 *
 * Needs the `playwright` package and its Chromium (npx playwright install chromium-headless-shell).
 * Set PLAYWRIGHT_MODULE to a playwright install elsewhere (e.g. a scratch folder) if it isn't in
 * node_modules. Set E2E_SHOTS to a folder to keep screenshots of the painting steps.
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
/** True once the locator is gone. */
const gone = (locator) => locator.first().waitFor({ state: 'hidden', timeout: 8000 }).then(() => true, () => false);

try {
  // Refuse to test against something already on the port (e.g. a server left over from a crashed run).
  try { await fetch(`${base}/api/health`); throw new Error(`port ${PORT} is already in use; set E2E_PORT`); } catch (e) { if (String(e).includes('already in use')) throw e; }
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

  // ---- Desktop / tablet ------------------------------------------------------------------------
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const modeLight = page.locator('.topbar .mode-light');
  const tone = () => modeLight.getAttribute('data-tone');
  const pages = page.getByRole('navigation', { name: 'Pages' });
  const toPage = async (name) => { await pages.getByRole('link', { name, exact: true }).click(); await page.waitForTimeout(200); };
  const storedLayers = async (name) => {
    const res = await fetch(`${base}/api/scenes/${encodeURIComponent(name)}`);
    return res.ok ? (await res.json()).layers : null;
  };
  const answer = async (label) => {
    const dialog = page.locator('.dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await dialog.getByRole('button', { name: label, exact: true }).click();
  };

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('.library-row', { timeout: 15000 });
  check(page.url().endsWith('/') || page.url().endsWith('#/control'), 'the app opens without an address');
  check(await pages.getByRole('link', { name: 'Control' }).getAttribute('aria-current') === 'page', 'the app opens on Control');
  check(await tone() === 'green' && await modeLight.getAttribute('aria-label') === 'Mode: Control', 'the mode light is green on Control, with its name');
  check(await page.locator('.preview-canvas canvas').count() === 1, 'the 3D preview renders');

  // The camera views are in one menu on the 3D view.
  await page.getByRole('button', { name: 'Camera view: Angle' }).click();
  const houseView = page.getByRole('menuitemradio', { name: /^House/ });
  check(await shows(houseView), 'the camera menu opens with a House view');
  await houseView.click();
  await page.waitForTimeout(500);
  const box = await page.locator('.preview-canvas canvas').boundingBox();
  check(await page.getByRole('button', { name: 'Camera view: House' }).isVisible() && !(await houseView.isVisible()) && !!box && box.width > 300 && box.height > 300 && errors.length === 0,
    'the House view is picked, the menu closes and the preview still renders');
  await page.getByRole('button', { name: 'Camera view: House' }).click();
  await page.getByRole('menuitemradio', { name: /^Angle/ }).click();

  // Control: Go and Edit per scene.
  const names = await page.locator('.library-row .scene-name').allTextContents();
  check(names.includes('Candy cane'), 'scenes are listed on Control');
  await page.getByLabel('Search scenes').fill('auro');
  check(await page.locator('.library-row').count() === 1, 'the scene search narrows the list');
  await page.getByLabel('Search scenes').fill('');
  await page.getByRole('button', { name: 'Go Aurora' }).click();
  await page.waitForTimeout(800);
  const status = await (await fetch(`${base}/api/status`)).json();
  check(status.stage.scene === 'Aurora', 'Go on Control puts the scene on stage');
  check(await shows(page.locator('.porch-card', { hasText: 'Aurora' })), 'Control shows what is on the porch');
  await page.getByRole('button', { name: 'Edit Aurora' }).click();
  check(await shows(page.getByRole('heading', { name: 'Aurora' })) && page.url().endsWith('#/create'), 'Edit on Control opens the scene in Create');
  check(await tone() === 'blue' && await modeLight.getAttribute('aria-label') === 'Mode: Create · Blind', 'the mode light is blue in Create Blind');
  await page.getByRole('button', { name: 'Add layer', exact: true }).click();
  check(await shows(page.getByRole('dialog', { name: 'Add a layer' })), 'the layer picker opens');
  await page.keyboard.press('Escape'); // close the layer picker

  // Edits change a working copy in the browser; the stored scene changes only on Save.
  const addLayer = async () => {
    await page.getByRole('button', { name: 'Add layer', exact: true }).click();
    await page.getByRole('dialog', { name: 'Add a layer' }).getByRole('option', { name: /^Rainbow/ }).first().click();
  };
  const openScene = async (name) => {
    await page.getByRole('button', { name: /^Editing .*Pick a scene to edit$/ }).click();
    await page.getByRole('dialog', { name: 'Scenes' }).getByRole('button', { name, exact: true }).click();
  };
  const unsavedNote = page.getByText('· Unsaved changes');
  const unsavedMark = page.locator('.topbar .unsaved-mark');
  const auroraBefore = (await storedLayers('Aurora')).length;
  await addLayer();
  await page.waitForTimeout(600);
  check((await storedLayers('Aurora')).length === auroraBefore, 'an edit in Blind leaves the stored scene alone');
  check(await shows(unsavedNote) && await unsavedMark.isVisible(), 'unsaved changes show in the panel and the top bar');
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
  // Unsaved edits are kept in the working copy across pages: Control marks the scene.
  await toPage('Control');
  check(await shows(page.locator('.library-row', { hasText: 'Aurora plus' }).getByText('unsaved edits in Create')), 'Control marks a scene with unsaved edits in Create');
  await toPage('Create');
  await openScene('Candy cane');
  check(await shows(page.getByRole('dialog', { name: 'Unsaved changes' })), 'opening another scene with unsaved edits asks first');
  await answer('Cancel');
  check(await shows(page.getByRole('heading', { name: 'Aurora plus' })), 'Cancel stays on the scene with its edits');
  await openScene('Candy cane');
  await answer('Discard');
  check(await shows(page.getByRole('heading', { name: 'Candy cane' })) && (await storedLayers('Aurora plus')).length === auroraBefore + 2, 'Discard drops the edits and opens the other scene');
  await toPage('Control');
  await page.getByRole('button', { name: '+ New', exact: true }).click();
  check(await shows(page.getByRole('heading', { name: 'New scene' })) && page.url().endsWith('#/create') && await page.locator('.layer-list .layer-row').count() === 0, '+ New on Control starts a blank scene in Create');
  check((await storedLayers('New scene')) === null, 'a new scene is not stored until it is saved');
  await openScene('Candy cane'); // blank: nothing to ask
  check(await shows(page.getByRole('heading', { name: 'Candy cane' })), 'a blank new scene is left without asking');

  // The tool rail picks a tool and opens its settings in a pop-out beside the rail button; the right panel
  // keeps the layers. Clicking the tool again, its ×, or Esc closes the pop-out; a second Esc goes back to Move.
  const rail = page.getByRole('navigation', { name: 'Tools' });
  const editPanel = page.getByRole('complementary', { name: 'Editing Candy cane' });
  const selectButton = rail.getByRole('button', { name: 'Select', exact: true });
  const selectPop = page.getByRole('dialog', { name: 'Select settings' });
  await selectButton.click();
  check(await shows(selectPop) && await selectPop.getByRole('radio', { name: 'Lasso' }).isVisible() && await selectPop.getByRole('radio', { name: 'Remove' }).isVisible()
    && await selectButton.getAttribute('aria-pressed') === 'true' && await selectButton.getAttribute('aria-expanded') === 'true', 'the rail’s Select tool opens its pop-out with the selection tools');
  await page.waitForTimeout(250); // the pop-out slides in
  const railBox = await rail.boundingBox();
  const selBtnBox = await selectButton.boundingBox();
  const popBox = await selectPop.boundingBox();
  check(!!popBox && popBox.x >= railBox.x + railBox.width && popBox.x < railBox.x + railBox.width + 30 && Math.abs(popBox.y - selBtnBox.y) < 4, 'the Select pop-out sits beside the rail, level with its button');
  check(await editPanel.isVisible() && await page.locator('.layer-list').isVisible(), 'the right panel keeps the Edit panel (layers) while selecting');
  // A box selection on the 3D view, with the pop-out open.
  await page.mouse.move(popBox.x + popBox.width + 20, 160);
  await page.mouse.down();
  await page.mouse.move(910, 780, { steps: 10 });
  await page.mouse.up();
  const selectedCount = async () => Number((await selectPop.locator('.tool-pop-sub').textContent()).match(/\d+/)[0]);
  check(await selectedCount() > 0 && await selectPop.isVisible(), `a box selection works with the pop-out open (${await selectedCount()} selected)`);
  await selectPop.getByRole('button', { name: 'None', exact: true }).click();
  // Drag the pop-out by its header: it stays where it was put, on this device; a double-click puts it back.
  const head = selectPop.locator('.tool-pop-head');
  const hb = await head.boundingBox();
  await page.mouse.move(hb.x + 90, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 490, hb.y + hb.height / 2 + 140, { steps: 8 });
  await page.mouse.up();
  const moved = await selectPop.boundingBox();
  check(Math.abs(moved.x - (popBox.x + 400)) < 3 && Math.abs(moved.y - (popBox.y + 140)) < 3 && await selectedCount() === 0, 'dragging the pop-out’s header moves it (and selects nothing)');
  await page.reload({ waitUntil: 'networkidle' });
  await selectButton.waitFor();
  if (await selectButton.getAttribute('aria-pressed') !== 'true') await selectButton.click();
  await shows(selectPop);
  await page.waitForTimeout(250);
  const after = await selectPop.boundingBox();
  check(Math.abs(after.x - moved.x) < 3 && Math.abs(after.y - moved.y) < 3, 'the moved pop-out is still there after a reload');
  await selectPop.locator('.tool-pop-head').dblclick({ position: { x: 90, y: 12 } });
  await page.waitForTimeout(100);
  const reset = await selectPop.boundingBox();
  check(Math.abs(reset.x - popBox.x) < 3 && Math.abs(reset.y - popBox.y) < 3, 'a double-click on its header puts the pop-out back by the rail');
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(150);
  const small = await selectPop.boundingBox();
  check(small.x + small.width <= 900 && small.y + small.height <= 700, 'the pop-out stays inside a smaller window');
  await page.setViewportSize({ width: 1280, height: 860 });
  if (!(await editPanel.isVisible())) await openScene('Candy cane'); // after the reload the editor opens what's on stage
  check(await shows(editPanel), 'Candy cane is open again');
  await selectButton.click();
  check(await gone(selectPop) && await selectButton.getAttribute('aria-expanded') === 'false' && await selectButton.getAttribute('aria-pressed') === 'true', 'clicking Select again closes its pop-out');
  await selectButton.click();
  check(await shows(selectPop), 'and again opens it');
  await page.keyboard.press('Escape');
  check(await gone(selectPop) && await selectButton.getAttribute('aria-pressed') === 'true', 'Esc closes the pop-out');
  await page.keyboard.press('Escape');
  check(await rail.getByRole('button', { name: 'Move' }).getAttribute('aria-pressed') === 'true' && await editPanel.isVisible(), 'a second Esc goes back to Move');
  await selectButton.click();
  await selectPop.getByRole('button', { name: 'Close the Select settings' }).click();
  check(await gone(selectPop), 'the pop-out’s × closes it');
  await page.keyboard.press('v');
  await page.keyboard.press('m');
  check(await selectButton.getAttribute('aria-pressed') === 'true' && !(await selectPop.isVisible()), 'M picks Select with its pop-out as it was left (closed)');
  await selectButton.click();
  await page.keyboard.press('v');
  check(await rail.getByRole('button', { name: 'Move' }).getAttribute('aria-pressed') === 'true' && await page.locator('.tool-pop').count() === 0, 'V picks the Move tool, which has no pop-out');

  // Brush and Eraser start a new, blank scene: brush strokes become its painted layers, one undo step
  // each; the eraser wipes them. Nothing is stored until Save as new.
  const shot = (name) => (process.env.E2E_SHOTS ? page.screenshot({ path: join(process.env.E2E_SHOTS, `${name}.png`) }) : null);
  const paintItems = page.locator('.paint-list .group-item');
  const scribble = async () => {
    // Right of the tool pop-out (which sits beside the rail), left of the panel.
    await page.mouse.move(440, 240);
    await page.mouse.down();
    for (let y = 240; y <= 680; y += 40) { await page.mouse.move(900, y, { steps: 8 }); await page.mouse.move(440, y + 20, { steps: 8 }); }
    await page.mouse.up();
    await page.waitForTimeout(300);
  };
  const candyBefore = JSON.stringify(await storedLayers('Candy cane'));
  await rail.getByRole('button', { name: 'Brush', exact: true }).click();
  check(await shows(page.getByRole('complementary', { name: 'Paint on the lights' })), 'the Brush tool shows the paint panel');
  const brushPop = page.getByRole('dialog', { name: 'Brush settings' });
  check(await shows(brushPop) && await brushPop.getByRole('slider', { name: 'Size' }).isVisible() && await brushPop.getByRole('slider', { name: 'Soft edge' }).isVisible()
    && await brushPop.getByRole('slider', { name: 'Strength' }).isVisible(), 'the Brush opens its pop-out with size, soft edge and strength');
  check(await page.getByRole('complementary', { name: 'Paint on the lights' }).getByRole('radiogroup', { name: 'Colour' }).isVisible() && !(await brushPop.getByRole('radiogroup', { name: 'Colour' }).isVisible()),
    'the colours stay in the right panel');
  check(await shows(page.getByRole('heading', { name: 'Painting' })) && await paintItems.count() === 0 && await page.getByText('Nothing painted yet').isVisible(), 'the Brush starts from a blank canvas, not the current scene');
  for (let i = 0; i < 4; i++) await page.keyboard.press(']');
  await scribble();
  await shot('paint-colour');
  check(await paintItems.count() === 1, 'a brush stroke adds a painted layer');
  // Space held moves the view for a moment (even right after clicking Brush on the rail); letting go goes back to the Brush.
  check(await page.locator('.hold-move').count() === 0, 'no round hold button with a mouse and keyboard');
  await rail.getByRole('button', { name: 'Brush', exact: true }).click(); // closes its pop-out; the rail button keeps focus
  await page.keyboard.down(' ');
  check(await gone(page.locator('.paint-overlay')) && await page.locator('.move-label').isVisible()
    && await rail.getByRole('button', { name: 'Brush' }).getAttribute('aria-pressed') === 'true', 'holding Space moves the view, with the Brush still picked');
  await page.mouse.move(500, 300); await page.mouse.down(); await page.mouse.move(800, 420, { steps: 8 }); await page.mouse.up();
  check(await paintItems.count() === 1, 'a drag while Space is held turns the view and paints nothing');
  await page.keyboard.up(' ');
  check(await shows(page.locator('.paint-overlay')) && await page.locator('.move-label').count() === 0 && await page.locator('.tool-pop').count() === 0,
    'letting go of Space goes back to the Brush (Space didn’t press the focused rail button)');
  // Put the camera back where the strokes were painted, so the Eraser below follows them.
  await page.getByRole('button', { name: /^Camera view:/ }).click();
  await page.getByRole('menuitemradio', { name: /^Angle/ }).click();
  await page.waitForTimeout(1500);
  await rail.getByRole('button', { name: 'Brush', exact: true }).click(); // its pop-out again
  await page.getByRole('radio', { name: 'Effect', exact: true }).click();
  const brushPicker = page.getByRole('dialog', { name: 'Add a layer' });
  await brushPicker.getByRole('searchbox').or(brushPicker.locator('input')).first().fill('solid');
  check(await brushPicker.getByRole('option', { name: /^Solid(?! Pattern)/ }).count() === 0, 'the Brush doesn’t offer effects that make no pattern (Solid)');
  await brushPicker.getByRole('searchbox').or(brushPicker.locator('input')).first().fill('');
  await brushPicker.getByRole('option', { name: /^Rainbow/ }).first().click();
  const paintPanel = page.getByRole('complementary', { name: 'Paint on the lights' });
  check(await paintPanel.getByText('Effects paint as a pattern').isVisible() && await paintPanel.getByLabel(/^Colour/).count() === 0 && await paintPanel.getByLabel(/^Palette/).count() === 0,
    'a Brush effect paints as a pattern, so its colour and palette settings are hidden');
  await scribble();
  await shot('paint-effect');
  check(await paintItems.count() === 2 && /pattern/.test(await paintItems.first().textContent()), 'painting an effect adds a second painted layer, a pattern');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  check(await paintItems.count() === 1, 'Undo takes back one whole stroke');
  await rail.getByRole('button', { name: 'Eraser', exact: true }).click();
  check(await rail.getByRole('button', { name: 'Eraser' }).getAttribute('aria-pressed') === 'true' && await page.getByRole('heading', { name: 'Painting' }).isVisible(), 'the Eraser keeps the same painting');
  // A hard-edged eraser (set in its pop-out) along the brush's path takes every painted light back to nothing.
  const softEdge = page.getByRole('dialog', { name: 'Eraser settings' }).getByRole('slider', { name: 'Soft edge' });
  await softEdge.focus();
  await page.keyboard.press('Home');
  check(await softEdge.inputValue() === '0', 'the Eraser’s soft edge is set in its pop-out');
  await scribble();
  await shot('paint-erased');
  check(await paintItems.count() === 0, `the Eraser wipes the paint off (${await paintItems.count()} left)`);
  await page.keyboard.press('b');
  await page.getByRole('radio', { name: 'Colour', exact: true }).click();
  await scribble();
  // Clear painting is in the Eraser's pop-out.
  await page.keyboard.press('e');
  const eraserPop = page.getByRole('dialog', { name: 'Eraser settings' });
  check(await shows(eraserPop) && await paintItems.count() === 1, 'the Eraser opens its pop-out');
  page.once('dialog', (d) => d.accept());
  await eraserPop.getByRole('button', { name: 'Clear painting' }).click();
  check(await paintItems.count() === 0, 'Clear painting in the Eraser’s pop-out wipes the painting');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  check(await paintItems.count() === 1, 'Undo brings the cleared painting back');
  await page.keyboard.press('b');
  check((await storedLayers('Painting')) === null && JSON.stringify(await storedLayers('Candy cane')) === candyBefore, 'painting stores nothing on the server');
  await page.getByRole('button', { name: 'Save as new…', exact: true }).click();
  await page.locator('.dialog input').fill('Snowy roof');
  await answer('Save');
  await page.waitForTimeout(600);
  const snowy = await storedLayers('Snowy roof');
  check(snowy?.length === 1 && typeof snowy[0].paint === 'string', 'Save as new stores the painting as a scene');
  await page.keyboard.press('Escape'); // closes the Brush's pop-out
  await page.keyboard.press('Escape');
  check(await shows(page.getByRole('heading', { name: 'Snowy roof' })) && !(await page.getByRole('complementary', { name: 'Paint on the lights' }).isVisible()), 'Esc, Esc leaves the Brush for the Edit panel of the saved painting');
  await rail.getByRole('button', { name: 'Brush', exact: true }).click();
  check(await shows(page.getByRole('complementary', { name: 'Paint on the lights' })) && await page.getByRole('heading', { name: 'Snowy roof' }).isVisible(), 'Move then Brush carries on with the same painting (to turn the view mid-painting)');
  await page.keyboard.press('e');
  await scribble();
  const snowyBefore = JSON.stringify(await storedLayers('Snowy roof'));
  await openScene('Candy cane');
  check(await shows(page.getByRole('dialog', { name: 'Unsaved changes' })), 'leaving an unsaved painting asks');
  await answer('Discard');
  check(await shows(page.getByRole('heading', { name: 'Candy cane' })) && JSON.stringify(await storedLayers('Snowy roof')) === snowyBefore, 'Discard drops the unsaved strokes, the saved painting is unchanged');
  check(await rail.getByRole('button', { name: 'Move' }).getAttribute('aria-pressed') === 'true', 'opening an ordinary scene from the Brush goes back to Move');

  // Hold to see the porch (Blind): the stage shows while held, by pointer or Space.
  const peekButton = page.getByRole('button', { name: 'Hold to see the porch' });
  const peekLabel = page.getByText('Showing the porch while you hold');
  const pb = await peekButton.boundingBox();
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  await page.mouse.down();
  check(await shows(peekLabel) && await peekButton.getAttribute('aria-pressed') === 'true', 'holding the button shows the porch, with a label');
  await page.mouse.up();
  check(await gone(peekLabel), 'letting go goes back to the scene being edited');
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null));
  await page.keyboard.down(' ');
  check(await shows(peekLabel), 'holding Space shows the porch too');
  await page.keyboard.up(' ');
  check(await gone(peekLabel), 'letting go of Space goes back');

  // Setup: strings, house, mapping, controllers, backups, Home.
  await toPage('Setup');
  check(await tone() === 'grey' && await modeLight.getAttribute('aria-label') === 'Mode: Setup', 'the mode light is grey on Setup');
  const setupRail = page.getByRole('navigation', { name: 'Setup tools' });
  check(await shows(page.getByRole('complementary', { name: 'Layout editor' })), 'Setup opens on Strings (the layout editor)');
  for (const [tool, panel] of [['House', 'House model'], ['WLED', 'WLED controllers'], ['Backups', 'Backups'], ['Home', 'Home and connections'], ['Map', 'Mapping results']]) {
    await setupRail.getByRole('button', { name: tool, exact: true }).click();
    check(await shows(page.getByRole('complementary', { name: panel })), `Setup’s ${tool} tool shows its panel`);
  }
  check(page.url().endsWith('#/setup/map'), 'Setup’s tool is in the address');
  // Map lights: the filming screen opens (headless Chromium has no camera, so it explains that) and closes again.
  await page.getByRole('button', { name: 'Film a spot' }).click();
  check(await shows(page.getByRole('dialog', { name: 'Map lights' })), 'the Map lights screen opens');
  await page.getByRole('button', { name: 'Close mapping' }).click();
  check(await shows(page.getByRole('complementary', { name: 'Mapping results' })), 'closing Map lights goes back to Setup');

  // Control's playlists and schedule.
  await toPage('Control');
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
  await page.getByRole('tab', { name: /^Scenes/ }).click();

  // Palette colours: the selected palette's colours show as swatches; changing one makes an edited copy
  // that the preview draws at once, and Undo puts the original back.
  const sceneApi = `${base}/api/scenes/${encodeURIComponent('Palette test')}`;
  const savedLayer = async () => (await (await fetch(sceneApi)).json()).layers[0];
  await fetch(`${sceneApi}?apply=false`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layers: [{ id: 'p', effect: 'wled-palette', params: { palette: 'Party', check1: false } }] }) });
  await page.getByRole('button', { name: 'Edit Palette test' }).click({ timeout: 8000 });
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

  // Live: the light turns red, and there's nothing to hold (the edits are on the porch).
  await page.getByRole('radio', { name: 'Live', exact: true }).click();
  check(await tone() === 'red' && await modeLight.getAttribute('aria-label') === 'Mode: Create · Live' && await page.getByRole('button', { name: 'Hold to see the porch' }).count() === 0,
    'the mode light is red in Live, and Hold to see the porch is hidden');
  await page.getByRole('radio', { name: 'Blind', exact: true }).click();

  // The full-screen display: the live porch with no editing controls.
  await toPage('Control');
  await page.locator('.porch-card').getByRole('button', { name: 'Full-screen display' }).click();
  check(await shows(page.locator('.watch-card')) && page.url().endsWith('#/watch') && await page.locator('.preview-canvas canvas').count() === 1
    && await page.locator('.editor, .rail, .topbar').count() === 0, 'Full-screen display opens #/watch: the porch, no editing controls');
  await page.getByRole('button', { name: 'Exit', exact: true }).click();
  check(await shows(page.locator('.library-row')) && page.url().endsWith('#/control'), 'Exit goes back to Control');
  await page.goto(`${base}/#/watch`, { waitUntil: 'networkidle' });
  check(await shows(page.locator('.watch-card')), '#/watch opens the full-screen display directly');
  await page.goto(`${base}/#/setup/house`, { waitUntil: 'networkidle' });
  check(await shows(page.getByRole('complementary', { name: 'House model' })), 'a Setup address opens that tool');
  await page.goto(`${base}/#/create`, { waitUntil: 'networkidle' });
  check(await shows(page.getByRole('navigation', { name: 'Tools' })), '#/create opens Create');

  // The panel can be tucked away (remembered), giving the 3D view the room.
  await page.getByRole('button', { name: 'Hide the panel' }).click();
  check(await gone(page.locator('.editor')) && await page.getByRole('button', { name: 'Show the panel' }).isVisible(), 'the panel hides');
  await page.reload({ waitUntil: 'networkidle' });
  check(await shows(page.getByRole('button', { name: 'Show the panel' })) && await page.locator('.editor').count() === 0, 'a hidden panel stays hidden on this device');
  await page.getByRole('button', { name: 'Show the panel' }).click();
  check(await shows(page.locator('.editor')), 'the panel comes back');

  const camErrors = errors.filter((e) => !/camera|getUserMedia|NotFound|NotAllowed|Requested device/i.test(e));
  check(camErrors.length === 0, `no page errors${camErrors.length ? `: ${camErrors.join(' | ')}` : ''}`);

  // ---- Phone -----------------------------------------------------------------------------------
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(base, { waitUntil: 'networkidle' });
  await phone.waitForSelector('.control-panel', { timeout: 15000 });
  check(await phone.getByRole('tab', { name: /^Playlists/ }).isVisible(), 'the phone shows Control’s tabs in the bottom sheet');
  await phone.getByRole('button', { name: /^Page: Control/ }).click();
  await phone.getByRole('menuitemradio', { name: /^Create/ }).click();
  const strip = phone.getByRole('navigation', { name: 'Tools' });
  const sb = await strip.boundingBox();
  check(await shows(phone.locator('.editor')) && !!sb && sb.width > sb.height * 3, 'on a phone Create’s tools are a strip and its panel a sheet');
  await strip.getByRole('button', { name: 'Select', exact: true }).click();
  const phonePop = phone.getByRole('dialog', { name: 'Select settings' });
  check(await shows(phonePop), 'the phone’s tool strip opens the Select pop-out');
  await phone.waitForTimeout(300);
  const pp = await phonePop.boundingBox();
  const sb2 = await strip.boundingBox();
  check(pp.y + pp.height <= sb2.y && sb2.y - (pp.y + pp.height) < 20 && pp.height < 844 * 0.3 && await phone.locator('.editor .layer-list').isVisible(),
    'on a phone the pop-out is a compact sheet just above the strip, and the bottom sheet keeps the layers');
  if (process.env.E2E_SHOTS) await phone.screenshot({ path: join(process.env.E2E_SHOTS, 'phone-select.png') });
  // The round hold button: Move while it's held, above the open pop-out; back to Select on release.
  const holdBtn = phone.getByRole('button', { name: 'Hold to move the view' });
  const hold = await holdBtn.boundingBox();
  check(!!hold && hold.y + hold.height <= pp.y && hold.x + hold.width <= 390, 'the phone has a round hold-to-move button above the pop-out');
  await phone.mouse.move(hold.x + hold.width / 2, hold.y + hold.height / 2);
  await phone.mouse.down();
  check(await gone(phone.locator('.select-overlay')) && await holdBtn.getAttribute('aria-pressed') === 'true', 'holding the round button switches to moving the view');
  await phone.mouse.up();
  check(await shows(phone.locator('.select-overlay')) && await holdBtn.getAttribute('aria-pressed') === 'false', 'letting go goes back to Select');
  await phone.keyboard.press('Escape');
  check(await gone(phonePop), 'Esc closes the phone’s pop-out');
  await phone.getByRole('button', { name: 'Camera view: Angle' }).click();
  await phone.getByRole('menuitemradio', { name: /^House/ }).click();
  check(await shows(phone.getByRole('button', { name: 'Camera view: House' })), 'the phone has the camera views');

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
