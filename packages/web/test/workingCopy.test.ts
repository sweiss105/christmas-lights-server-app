import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneConfig } from '@xmas/engine';

// The server, as far as saving goes: a map of stored scenes and a record of calls.
const server = vi.hoisted(() => ({ scenes: new Map<string, unknown>(), calls: [] as string[] }));
vi.mock('../src/api', () => ({
  api: {
    saveScene: vi.fn(async (scene: { name: string }, apply: boolean) => { server.calls.push(`save ${scene.name} ${apply}`); server.scenes.set(scene.name, structuredClone(scene)); return structuredClone(scene); }),
    previewStage: vi.fn(async (scene: { name: string }) => { server.calls.push(`preview ${scene.name}`); return { stage: scene, preview: scene.name }; }),
    endPreview: vi.fn(async () => { server.calls.push('end preview'); return { preview: null }; }),
    deleteScene: vi.fn(async (name: string) => { server.calls.push(`delete ${name}`); server.scenes.delete(name); return { deleted: name }; }),
    renameScene: vi.fn(async (name: string, to: string) => { server.calls.push(`rename ${name} ${to}`); return { name: to, layers: [] }; }),
  },
}));

import { addLayer, setParam } from '../src/editor.js';
import { applyStroke } from '../src/paint.js';
import { createSceneFlow } from '../src/sceneFlow.js';
import { DEMO_REFUSAL } from '../src/demo/flag.js';
import type { DialogAnswer, DialogSpec } from '../src/Dialog.js';
import { createSceneWork, type EditMode } from '../src/useSceneEditor.js';
import type { Show } from '../src/useShow.js';
import { WorkingCopy } from '../src/workingCopy.js';

const red = (): SceneConfig => ({ name: 'Red', layers: [{ id: 'l', effect: 'solid', params: { color: '#ff0000' } }] });
const blue = (): SceneConfig => ({ name: 'Blue', layers: [{ id: 'l', effect: 'solid', params: { color: '#0000ff' } }] });

describe('WorkingCopy', () => {
  it('tracks unsaved changes against the stored scene, through undo and redo', () => {
    const wc = new WorkingCopy();
    expect(wc.dirty).toBe(false); // nothing open
    wc.load(red());
    expect(wc.dirty).toBe(false);
    wc.edit(setParam(wc.scene, 'l', 'color', '#00ff00'));
    expect(wc.dirty).toBe(true);
    wc.undo();
    expect(wc.dirty).toBe(false);
    wc.redo();
    expect(wc.dirty).toBe(true);
    expect(wc.stored!.layers[0]!.params!.color).toBe('#ff0000'); // the stored version never changes with edits
  });

  it('revert goes back to the stored scene', () => {
    const wc = new WorkingCopy();
    wc.load(red());
    wc.edit(addLayer(wc.scene, 'twinkle'));
    wc.revert();
    expect(wc.scene).toEqual(red());
    expect(wc.dirty).toBe(false);
  });

  it('a new scene is blank and unsaved; blank is not worth asking about', () => {
    const wc = new WorkingCopy();
    wc.startNew('New scene');
    expect(wc.scene).toEqual({ name: 'New scene', layers: [] });
    expect(wc.neverStored).toBe(true);
    expect(wc.dirty).toBe(true);
    expect(wc.worthKeeping).toBe(false);
    wc.edit(addLayer(wc.scene, 'solid'));
    expect(wc.worthKeeping).toBe(true);
    wc.revert();
    expect(wc.scene.layers).toEqual([]);
  });

  it('after a save, it is clean, and later edits are unsaved again', () => {
    const wc = new WorkingCopy();
    wc.load(red());
    wc.edit(setParam(wc.scene, 'l', 'color', '#00ff00'));
    wc.markStored(wc.scene);
    expect(wc.dirty).toBe(false);
    wc.edit(setParam(wc.scene, 'l', 'color', '#ffffff'));
    expect(wc.dirty).toBe(true);
  });

  it('rename keeps the edits and their undo history', () => {
    const wc = new WorkingCopy();
    wc.load(red());
    wc.edit(setParam(wc.scene, 'l', 'color', '#00ff00'));
    wc.rename('Green');
    expect(wc.name).toBe('Green');
    expect(wc.stored!.name).toBe('Green');
    expect(wc.dirty).toBe(true);
    wc.undo();
    expect(wc.scene).toEqual({ ...red(), name: 'Green' });
  });

  it('takes a version stored elsewhere only when there are no edits here', () => {
    const wc = new WorkingCopy();
    wc.load(red());
    expect(wc.storedChanged({ ...red(), layers: [] })).toBe(true);
    expect(wc.scene.layers).toEqual([]);
    wc.edit(addLayer(wc.scene, 'solid'));
    expect(wc.storedChanged(red())).toBe(false);
    expect(wc.scene.layers[0]!.effect).toBe('solid');
  });
});

/** A flow over a fake show, with the dialog answered from a queue. */
function setup(opts: { mode?: EditMode; stage?: { scene: string | null; dirty: boolean; preview?: string }; demo?: boolean; errors?: string[] } = {}) {
  server.scenes = new Map([['Red', red()], ['Blue', blue()]]);
  server.calls = [];
  let selected: string | null = 'Red';
  const answers: string[] = [];
  const asked: DialogSpec[] = [];
  const show = {
    get scenes() { return [...server.scenes.values()] as SceneConfig[]; },
    status: { stage: opts.stage ?? { scene: 'Blue', dirty: false } },
    reportError: (e: unknown) => { if (opts.errors) opts.errors.push((e as Error).message); else throw e; },
    markSceneSaved: () => {},
    refresh: async () => {},
  } as unknown as Show;
  const wc = new WorkingCopy();
  wc.load(red());
  const select = (n: string | null) => {
    selected = n;
    // What useSceneEditor does when the selection changes.
    const s = show.scenes.find((x) => x.name === n);
    if (n !== wc.name && s) wc.load(s);
  };
  const work = createSceneWork(wc, { show: () => show, mode: () => opts.mode ?? 'blind', select, lastLive: { current: null } });
  const ask = async (spec: DialogSpec): Promise<DialogAnswer> => {
    asked.push(spec);
    const a = answers.shift() ?? spec.cancel;
    const [choice, value] = a.split(':');
    return { choice: choice!, value: value ?? spec.input?.value ?? '' };
  };
  const flow = createSceneFlow(show, work, ask, select, { current: null }, () => true, { demo: opts.demo ?? false });
  return { wc, flow, answers, asked, show, selected: () => selected };
}

describe('saving the working copy', () => {
  beforeEach(() => { server.calls = []; });

  it('edits in Blind never reach the server until Save', async () => {
    const { wc, flow } = setup();
    wc.edit(setParam(wc.scene, 'l', 'color', '#00ff00'));
    expect(server.calls).toEqual([]);
    expect((server.scenes.get('Red') as SceneConfig).layers[0]!.params!.color).toBe('#ff0000');
    expect(await flow.save()).toBe(true);
    expect(server.calls).toEqual(['save Red false']);
    expect((server.scenes.get('Red') as SceneConfig).layers[0]!.params!.color).toBe('#00ff00');
    expect(wc.dirty).toBe(false);
  });

  it('Save as new stores a copy under the new name, leaves the original, and opens the copy', async () => {
    const { wc, flow, answers, selected } = setup();
    wc.edit(setParam(wc.scene, 'l', 'color', '#00ff00'));
    answers.push('save:Green');
    expect(await flow.saveAsNew()).toBe(true);
    expect((server.scenes.get('Green') as SceneConfig).layers[0]!.params!.color).toBe('#00ff00');
    expect((server.scenes.get('Red') as SceneConfig).layers[0]!.params!.color).toBe('#ff0000');
    expect(wc.name).toBe('Green');
    expect(wc.dirty).toBe(false);
    expect(selected()).toBe('Green');
  });

  it('Save as new refuses a name that is taken', async () => {
    const { wc, flow, answers, asked } = setup();
    wc.edit(setParam(wc.scene, 'l', 'color', '#00ff00'));
    answers.push('cancel');
    await flow.saveAsNew();
    expect(asked[0]!.input!.check!('Blue')).toMatch(/already/);
    expect(asked[0]!.input!.check!('Fresh')).toBe(null);
    expect(asked[0]!.input!.value).toBe('Red 2'); // the suggestion is free
  });

  it('Revert throws the edits away without touching the server (Blind)', async () => {
    const { wc, flow, answers } = setup();
    wc.edit(setParam(wc.scene, 'l', 'color', '#00ff00'));
    answers.push('revert');
    await flow.revert();
    expect(wc.scene).toEqual(red());
    expect(server.calls).toEqual([]);
  });

  it('Revert in Live puts the stored version back on the porch when it shows the edits', async () => {
    const { wc, flow, answers } = setup({ mode: 'live', stage: { scene: 'Red', dirty: false, preview: 'Red' } });
    wc.edit(setParam(wc.scene, 'l', 'color', '#00ff00'));
    answers.push('revert');
    await flow.revert();
    expect(server.calls).toEqual(['preview Red']); // the stored version ends the preview on the server
    expect(wc.dirty).toBe(false);
  });

  it('New starts a blank scene that is not stored; its first Save asks for a name', async () => {
    const { wc, flow, answers, selected } = setup();
    await flow.create();
    expect(wc.scene).toEqual({ name: 'New scene', layers: [] });
    expect(wc.neverStored).toBe(true);
    expect(selected()).toBe('New scene');
    expect(server.calls).toEqual([]);
    wc.edit(addLayer(wc.scene, 'solid'));
    answers.push('save:Porch glow');
    expect(await flow.save()).toBe(true);
    expect(server.scenes.has('Porch glow')).toBe(true);
    expect(server.scenes.has('New scene')).toBe(false);
    expect(wc.neverStored).toBe(false);
  });

  it('Paint starts from a blank canvas, not the current scene', async () => {
    const { wc, flow } = setup();
    expect(await flow.startNew('Painting')).toBe(true);
    expect(wc.scene).toEqual({ name: 'Painting', layers: [] });
    const stroke = new Float32Array(10).fill(0);
    stroke[2] = 1;
    wc.edit(applyStroke(wc.scene, { kind: 'look', look: { effect: 'solid', params: { color: '#ffffff' } } }, stroke));
    expect(wc.scene.layers).toHaveLength(1);
    expect(wc.scene.layers[0]!.paint).toBeDefined();
  });
});

describe('leaving unsaved edits', () => {
  it('opening another scene asks first; Cancel stays, Discard drops the edits', async () => {
    const { wc, flow, answers, asked, selected } = setup();
    wc.edit(setParam(wc.scene, 'l', 'color', '#00ff00'));
    answers.push('cancel');
    expect(await flow.open('Blue')).toBe(false);
    expect(asked.at(-1)!.buttons.map((b) => b.label)).toEqual(['Save', 'Save as new…', 'Discard', 'Cancel']);
    expect(selected()).toBe('Red');
    expect(wc.dirty).toBe(true);
    answers.push('discard');
    expect(await flow.open('Blue')).toBe(true);
    expect(selected()).toBe('Blue');
    expect((server.scenes.get('Red') as SceneConfig).layers[0]!.params!.color).toBe('#ff0000');
  });

  it('choosing Save stores the edits, then goes on', async () => {
    const { wc, flow, answers, selected } = setup();
    wc.edit(setParam(wc.scene, 'l', 'color', '#00ff00'));
    answers.push('save');
    expect(await flow.open('Blue')).toBe(true);
    expect((server.scenes.get('Red') as SceneConfig).layers[0]!.params!.color).toBe('#00ff00');
    expect(selected()).toBe('Blue');
  });

  it('without edits nothing is asked', async () => {
    const { flow, asked } = setup();
    expect(await flow.open('Blue')).toBe(true);
    expect(asked).toEqual([]);
  });

  it('leaving an unsaved painting offers Save as new, Discard or Cancel; Discard goes back to the scene before', async () => {
    const { wc, flow, answers, asked, selected } = setup();
    await flow.startNew('Painting');
    wc.edit(addLayer(wc.scene, 'solid'));
    answers.push('discard');
    expect(await flow.leave()).toBe(true);
    expect(asked.at(-1)!.buttons.map((b) => b.label)).toEqual(['Save as new…', 'Discard', 'Cancel']);
    expect(selected()).toBe('Red');
    expect(wc.name).toBe('Red');
  });

  it('a blank new scene is dropped without asking', async () => {
    const { wc, flow, asked } = setup();
    await flow.create();
    expect(await flow.leave()).toBe(true);
    expect(asked).toEqual([]);
    expect(wc.name).toBe('Red');
  });

  it('discarding a painting the porch shows (Live) puts back what was on stage', async () => {
    const { wc, flow, answers } = setup({ mode: 'live', stage: { scene: 'Blue', dirty: false, preview: 'Painting' } });
    await flow.startNew('Painting');
    wc.edit(addLayer(wc.scene, 'solid'));
    answers.push('discard');
    await flow.leave();
    expect(server.calls).toEqual(['end preview']);
  });

  it('Go on the scene with unsaved edits asks: Save and Go, the stored version, or Cancel', async () => {
    const { wc, flow, answers, asked } = setup();
    expect(await flow.confirmGo('Red')).toBe(true); // no edits: no question
    wc.edit(setParam(wc.scene, 'l', 'color', '#00ff00'));
    answers.push('stored');
    expect(await flow.confirmGo('Red')).toBe(true);
    expect(server.calls).toEqual([]); // the stored version, untouched
    expect(asked.at(-1)!.buttons.map((b) => b.label)).toEqual(['Save and Go', 'Go with the stored version', 'Cancel']);
    answers.push('cancel');
    expect(await flow.confirmGo('Red')).toBe(false);
    answers.push('save');
    expect(await flow.confirmGo('Red')).toBe(true);
    expect(server.calls).toEqual(['save Red false']);
    expect(await flow.confirmGo('Blue')).toBe(true); // another scene: nothing to ask
  });

  it('Duplicate stores a copy of the stored scene', async () => {
    const { flow, selected } = setup();
    await flow.duplicate();
    expect(server.scenes.get('Red 2')).toEqual({ ...red(), name: 'Red 2' });
    expect(selected()).toBe('Red 2');
  });

  it('renaming keeps unsaved edits', async () => {
    const { wc, flow } = setup();
    wc.edit(setParam(wc.scene, 'l', 'color', '#00ff00'));
    expect(await flow.rename('Crimson')).toBe(true);
    expect(server.calls).toEqual(['rename Red Crimson']);
    expect(wc.name).toBe('Crimson');
    expect(wc.dirty).toBe(true);
  });

  it('Control can duplicate any scene without touching the working copy', async () => {
    const { wc, flow, selected } = setup();
    wc.edit(setParam(wc.scene, 'l', 'color', '#00ff00'));
    expect(await flow.duplicateScene('Blue')).toBe('Blue 2');
    expect(server.scenes.get('Blue 2')).toEqual({ ...blue(), name: 'Blue 2' });
    expect(selected()).toBe('Red');
    expect(wc.name).toBe('Red');
    expect(wc.dirty).toBe(true);
  });

  it('Control can rename another scene; renaming the one being edited keeps its edits', async () => {
    const { wc, flow } = setup();
    wc.edit(setParam(wc.scene, 'l', 'color', '#00ff00'));
    expect(await flow.renameScene('Blue', 'Navy')).toBe(true);
    expect(server.calls).toEqual(['rename Blue Navy']);
    expect(wc.name).toBe('Red');
    expect(await flow.renameScene('Red', 'Crimson')).toBe(true);
    expect(wc.name).toBe('Crimson');
    expect(wc.dirty).toBe(true);
  });

  it('deleting another scene leaves the working copy open', async () => {
    const { wc, flow, selected } = setup({ stage: { scene: null, dirty: false } });
    await flow.remove('Blue');
    expect(server.calls).toEqual(['delete Blue']);
    expect(wc.name).toBe('Red');
    expect(selected()).toBe('Red');
    await flow.remove('Red');
    expect(wc.open).toBe(false);
    expect(selected()).toBe(null);
  });
});

describe('the public demo: nothing is stored', () => {
  beforeEach(() => { server.calls = []; });

  it('leaving unsaved edits offers only Discard and Cancel', async () => {
    const { wc, flow, asked, answers } = setup({ demo: true });
    wc.edit(setParam(wc.scene, 'l', 'color', '#00ff00'));
    answers.push('discard');
    expect(await flow.leave()).toBe(true);
    expect(asked[0]!.buttons.map((b) => b.id)).toEqual(['discard', 'cancel']);
    expect(server.calls).toEqual([]);
  });

  it('Go with unsaved edits offers the stored version or Cancel, never Save and Go', async () => {
    const { wc, flow, asked, answers } = setup({ demo: true });
    wc.edit(setParam(wc.scene, 'l', 'color', '#00ff00'));
    answers.push('stored');
    expect(await flow.confirmGo('Red')).toBe(true);
    expect(asked[0]!.buttons.map((b) => b.id)).toEqual(['stored', 'cancel']);
  });

  it('Save, Save as new, Duplicate, Rename and Delete say saving is off and store nothing', async () => {
    const errors: string[] = [];
    const { wc, flow } = setup({ demo: true, errors });
    wc.edit(setParam(wc.scene, 'l', 'color', '#00ff00'));
    expect(await flow.save()).toBe(false);
    expect(await flow.saveAsNew()).toBe(false);
    await flow.duplicate();
    expect(await flow.duplicateScene('Blue')).toBeNull();
    expect(await flow.rename('Crimson')).toBe(false);
    expect(await flow.renameScene('Blue', 'Navy')).toBe(false);
    await flow.remove('Blue');
    expect(server.calls).toEqual([]);
    expect(errors.length).toBe(7);
    expect(new Set(errors)).toEqual(new Set([DEMO_REFUSAL]));
    expect(server.scenes.has('Blue')).toBe(true);
  });

  it('a new, never-stored canvas can still be renamed and thrown away', async () => {
    const { wc, flow } = setup({ demo: true });
    await flow.startNew('New scene');
    expect(await flow.rename('Mine')).toBe(true);
    expect(wc.name).toBe('Mine');
    await flow.remove('Mine');
    expect(server.calls).toEqual([]);
  });
});
