import { useRef } from 'react';
import { api } from './api';
import type { Ask } from './Dialog';
import { uniqueName } from './editor';
import type { SceneWork } from './useSceneEditor';
import type { Show } from './useShow';
import { nameProblem } from './workingCopy';

export interface SceneFlow {
  /** Save over the stored scene (a never-stored scene asks for its name first). */
  save: () => Promise<boolean>;
  /** Ask for a name and store the working copy as a new scene; the original stays as it was. */
  saveAsNew: () => Promise<boolean>;
  revert: () => Promise<void>;
  /**
   * Deal with unsaved edits before leaving the working copy: Save, Save as new, Discard or Cancel.
   * True when it's fine to go on.
   */
  leave: () => Promise<boolean>;
  /** Before Go on `name`: with unsaved edits, Save and Go, Go with the stored version, or Cancel. */
  confirmGo: (name: string) => Promise<boolean>;
  /** Open another scene. */
  open: (name: string) => Promise<boolean>;
  /** A new, blank working copy that isn't stored yet (New, and Paint's blank canvas). */
  startNew: (base: string) => Promise<boolean>;
  create: () => Promise<void>;
  duplicate: () => Promise<void>;
  remove: (name: string) => Promise<void>;
  rename: (newName: string) => Promise<boolean>;
}

/** What the scene list and the editors do with the working copy, asking where edits could be lost. */
export function useSceneFlow(show: Show, work: SceneWork, ask: Ask, select: (n: string | null) => void): SceneFlow {
  /** The scene to go back to when a new scene is thrown away. */
  const returnTo = useRef<string | null>(null);
  return createSceneFlow(show, work, ask, select, returnTo, (m) => window.confirm(m));
}

/** The same without React, for tests. */
export function createSceneFlow(show: Show, work: SceneWork, ask: Ask, select: (n: string | null) => void,
  returnTo: { current: string | null }, confirm: (message: string) => boolean): SceneFlow {
  const { wc } = work;
  const taken = () => show.scenes.map((s) => s.name);

  const saveAsNew = async () => {
    const t = taken();
    const suggested = wc.neverStored && !t.includes(wc.name) ? wc.name : uniqueName(wc.name, t);
    const r = await ask({
      title: 'Save as a new scene',
      message: wc.neverStored ? undefined : `“${wc.name}” stays as it was stored.`,
      input: { label: 'Name', value: suggested, check: (v) => nameProblem(v, taken()) },
      buttons: [{ id: 'save', label: 'Save', kind: 'primary' }, { id: 'cancel', label: 'Cancel', kind: 'ghost' }],
      cancel: 'cancel',
    });
    return r.choice === 'save' ? work.save(r.value) : false;
  };
  const save = async () => (wc.neverStored ? saveAsNew() : work.save());

  const discard = async () => {
    const wasNew = wc.neverStored;
    await work.discard();
    if (wasNew) select(returnTo.current && taken().includes(returnTo.current) ? returnTo.current : null);
  };

  const leave = async () => {
    if (!wc.worthKeeping) { if (wc.neverStored) await discard(); return true; }
    const { choice } = await ask({
      title: 'Unsaved changes',
      message: wc.neverStored ? `“${wc.name}” isn’t saved yet. Save it as a scene before you go on?` : `“${wc.name}” has changes that aren’t saved.`,
      buttons: [
        ...(wc.neverStored ? [] : [{ id: 'save', label: 'Save', kind: 'primary' as const }]),
        { id: 'saveAs', label: 'Save as new…', kind: wc.neverStored ? 'primary' as const : 'ghost' as const },
        { id: 'discard', label: 'Discard', kind: 'danger' },
        { id: 'cancel', label: 'Cancel', kind: 'ghost' },
      ],
      cancel: 'cancel',
    });
    if (choice === 'save') return save();
    if (choice === 'saveAs') return saveAsNew();
    if (choice === 'discard') { await discard(); return true; }
    return false;
  };

  const startNew = async (base: string) => {
    const back = wc.neverStored ? returnTo.current : wc.name || null;
    if (!(await leave())) return false;
    returnTo.current = back;
    wc.startNew(uniqueName(base, taken()));
    select(wc.name);
    return true;
  };

  return {
    save, saveAsNew, leave,
    revert: async () => {
      const { choice } = await ask({
        title: 'Revert',
        message: wc.neverStored ? `Clear “${wc.name}” back to a blank scene?` : `Throw away the unsaved changes to “${wc.name}” and go back to the stored scene?`,
        buttons: [{ id: 'revert', label: 'Revert', kind: 'primary' }, { id: 'cancel', label: 'Cancel', kind: 'ghost' }],
        cancel: 'cancel',
      });
      if (choice === 'revert') await work.revert();
    },
    confirmGo: async (name) => {
      if (wc.name !== name || wc.neverStored || !wc.dirty) return true;
      const { choice } = await ask({
        title: 'Unsaved changes',
        message: `“${name}” has changes that aren’t saved. Go puts the stored scene on the porch.`,
        buttons: [{ id: 'save', label: 'Save and Go', kind: 'primary' }, { id: 'stored', label: 'Go with the stored version', kind: 'ghost' }, { id: 'cancel', label: 'Cancel', kind: 'ghost' }],
        cancel: 'cancel',
      });
      if (choice === 'save') return work.save();
      return choice === 'stored';
    },
    open: async (name) => {
      if (name === wc.name) return true;
      if (!(await leave())) return false;
      select(name);
      return true;
    },
    startNew,
    create: async () => { await startNew('New scene'); },
    duplicate: async () => {
      if (!(await leave())) return;
      const src = show.scenes.find((s) => s.name === wc.name);
      if (!src) return;
      try {
        const saved = await api.saveScene({ ...structuredClone(src), name: uniqueName(src.name, taken()) }, false);
        show.markSceneSaved(saved);
        select(saved.name);
      } catch (e) { show.reportError(e); }
    },
    remove: async (name) => {
      if (wc.name === name && wc.neverStored) {
        if (wc.worthKeeping && !confirm(`Throw away “${name}”? It has never been saved.`)) return;
        await discard();
        return;
      }
      const st = show.status?.stage;
      if (st?.scene === name || st?.preview === name) { show.reportError(new Error(`“${name}” is on stage. Go to another scene first, then delete it.`)); return; }
      const lost = wc.name === name && wc.worthKeeping ? ' Its unsaved changes are lost too.' : '';
      if (!confirm(`Delete the scene “${name}”? This can’t be undone.${lost}`)) return;
      try {
        await api.deleteScene(name);
        await show.refresh();
        if (wc.name === name) wc.close();
        select(null);
      } catch (e) { show.reportError(e); }
    },
    rename: async (newName) => {
      if (taken().includes(newName)) { show.reportError(new Error(`There's already a scene called “${newName}”.`)); return false; }
      // Unsaved edits come along under the new name, so there's nothing to ask.
      if (wc.neverStored) { wc.rename(newName); select(newName); return true; }
      try {
        // One step on the server, which also updates playlists, the schedule and the stage.
        await api.renameScene(wc.name, newName);
        wc.rename(newName);
        select(newName);
        await show.refresh();
        return true;
      } catch (e) { show.reportError(e); return false; }
    },
  };
}
