import { describe, expect, it } from 'vitest';
import type { SceneConfig } from '@xmas/engine';
import { SceneEditor, addLayer, duplicateLayer, moveLayer, removeLayer, setParam, updateLayer, uniqueName } from '../src/editor.js';

const scene = (): SceneConfig => ({
  name: 'Test',
  layers: [
    { id: 'base', effect: 'solid', params: { color: '#ff0000' } },
    { id: 'sparkle', effect: 'twinkle', blend: 'screen' },
  ],
});

describe('SceneEditor undo and redo', () => {
  it('undoes and redoes edits, and a new edit clears the redo history', () => {
    const ed = new SceneEditor(scene());
    ed.edit(setParam(ed.scene, 'base', 'color', '#00ff00'));
    ed.edit(updateLayer(ed.scene, 'sparkle', { opacity: 0.5 }));
    expect(ed.canUndo).toBe(true);
    ed.undo();
    expect(ed.scene.layers[1]!.opacity).toBeUndefined();
    ed.undo();
    expect(ed.scene.layers[0]!.params!.color).toBe('#ff0000');
    expect(ed.canUndo).toBe(false);
    ed.redo();
    expect(ed.scene.layers[0]!.params!.color).toBe('#00ff00');
    ed.edit(updateLayer(ed.scene, 'base', { opacity: 0.2 }));
    expect(ed.canRedo).toBe(false);
  });

  it('merges a continuous gesture (same merge key) into one undo step', () => {
    const ed = new SceneEditor(scene());
    for (const o of [0.9, 0.8, 0.7, 0.6]) ed.edit(updateLayer(ed.scene, 'base', { opacity: o }), { merge: 'base.opacity' });
    ed.endGesture();
    ed.edit(updateLayer(ed.scene, 'base', { opacity: 0.1 }), { merge: 'base.opacity' }); // new gesture
    ed.undo();
    expect(ed.scene.layers[0]!.opacity).toBe(0.6);
    ed.undo();
    expect(ed.scene.layers[0]!.opacity).toBeUndefined();
  });

  it('does not merge edits with different keys', () => {
    const ed = new SceneEditor(scene());
    ed.edit(updateLayer(ed.scene, 'base', { opacity: 0.5 }), { merge: 'base.opacity' });
    ed.edit(updateLayer(ed.scene, 'sparkle', { opacity: 0.5 }), { merge: 'sparkle.opacity' });
    ed.undo();
    expect(ed.scene.layers[0]!.opacity).toBe(0.5);
  });

  it('notifies subscribers and ignores edits that change nothing', () => {
    const ed = new SceneEditor(scene());
    let calls = 0;
    const off = ed.subscribe(() => calls++);
    ed.edit(ed.scene);
    expect(calls).toBe(0);
    expect(ed.canUndo).toBe(false);
    ed.edit(setParam(ed.scene, 'base', 'color', '#0000ff'));
    ed.undo();
    expect(calls).toBe(2);
    off();
    ed.redo();
    expect(calls).toBe(2);
  });

  it('never mutates the scene it was given or earlier history entries', () => {
    const original = scene();
    const frozen = JSON.stringify(original);
    const ed = new SceneEditor(original);
    ed.edit(setParam(ed.scene, 'base', 'color', '#123456'));
    ed.edit(moveLayer(ed.scene, 'base', 1));
    expect(JSON.stringify(original)).toBe(frozen);
    ed.undo(); ed.undo();
    expect(JSON.stringify(ed.scene)).toBe(frozen);
  });

  it('reset() loads another scene and clears history', () => {
    const ed = new SceneEditor(scene());
    ed.edit(updateLayer(ed.scene, 'base', { opacity: 0.3 }));
    ed.reset({ name: 'Other', layers: [] });
    expect(ed.scene.name).toBe('Other');
    expect(ed.canUndo).toBe(false);
  });
});

describe('layer operations', () => {
  it('adds a layer on top with a unique id', () => {
    let s = addLayer(scene(), 'solid');
    s = addLayer(s, 'solid');
    expect(s.layers.map((l) => l.id)).toEqual(['base', 'sparkle', 'solid', 'solid-2']);
    expect(s.layers[3]!.effect).toBe('solid');
  });

  it('duplicates a layer just above itself', () => {
    const s = duplicateLayer(scene(), 'base');
    expect(s.layers.map((l) => l.id)).toEqual(['base', 'base-2', 'sparkle']);
    expect(s.layers[1]!.params).toEqual({ color: '#ff0000' });
    expect(s.layers[1]!.params).not.toBe(s.layers[0]!.params);
  });

  it('removes and reorders layers, clamping at the ends', () => {
    expect(removeLayer(scene(), 'base').layers.map((l) => l.id)).toEqual(['sparkle']);
    expect(moveLayer(scene(), 'base', 1).layers.map((l) => l.id)).toEqual(['sparkle', 'base']);
    expect(moveLayer(scene(), 'base', -1).layers.map((l) => l.id)).toEqual(['base', 'sparkle']);
  });

  it('changing the effect keeps only params the new effect understands', () => {
    const s = updateLayer(scene(), 'base', { effect: 'sweep' });
    expect(s.layers[0]!.effect).toBe('sweep');
    expect(s.layers[0]!.params).toEqual({ color: '#ff0000' }); // sweep also has "color"
    const t = updateLayer(scene(), 'base', { effect: 'noise' });
    expect(t.layers[0]!.params).toEqual({});
  });

  it('makes unique scene names', () => {
    expect(uniqueName('Aurora', ['Aurora', 'Warm white'])).toBe('Aurora 2');
    expect(uniqueName('Aurora', ['Aurora', 'Aurora 2'])).toBe('Aurora 3');
    expect(uniqueName('New scene', [])).toBe('New scene');
  });
});
