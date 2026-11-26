import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { SceneConfig } from '@xmas/engine';
import { api } from './api';
import { latestWins } from './latest';
import type { Show } from './useShow';
import { WorkingCopy } from './workingCopy';

export type EditMode = 'blind' | 'live';

export interface SceneWork {
  /** The working copy (a SceneEditor, with undo and redo). */
  wc: WorkingCopy;
  /** Store the working copy: over its stored scene, or as a new scene called `asName`. */
  save: (asName?: string) => Promise<boolean>;
  /** Throw the edits away. A never-stored scene goes back to blank; the porch gets the stored version back. */
  revert: () => Promise<void>;
  /** Throw the working copy away before leaving it (a never-stored one is closed). */
  discard: () => Promise<void>;
}

/**
 * The scene being edited. Edits change a working copy kept in this browser only; the stored scene
 * changes only on Save. In Live, the porch shows the working copy as it's edited (a preview the
 * server doesn't store) when the scene is on stage, or when it's a new scene that has never been
 * stored (New, Paint).
 */
export function useSceneEditor(show: Show, sceneName: string | null, mode: EditMode, select: (n: string | null) => void): SceneWork {
  const wc = useMemo(() => new WorkingCopy(), []);
  useSyncExternalStore((fn) => wc.subscribe(fn), () => wc.version);

  // Open the selected scene when the selection changes. The working copy is kept when it already is
  // that scene (just saved under a new name, or a new scene that isn't stored).
  const stored = show.scenes.find((s) => s.name === sceneName) ?? null;
  useEffect(() => {
    if (sceneName === wc.name) return;
    if (stored) wc.load(stored);
    else if (sceneName === null) wc.close();
  }, [wc, sceneName, stored]);

  // The stored scenes changed underneath us (another device, or a restore). Without edits here, take
  // the new version; with edits, keep them (Save stores them over it).
  const epoch = useRef(show.epoch);
  useEffect(() => {
    if (epoch.current === show.epoch) return;
    epoch.current = show.epoch;
    if (!wc.open || wc.neverStored) return;
    const now = show.scenes.find((s) => s.name === wc.name);
    if (now) wc.storedChanged(now);
    else if (!wc.dirty) select(null); // deleted elsewhere
  }, [wc, show.epoch, show.scenes, select]);

  // ---- Live: the porch shows the working copy ------------------------------------------------
  const sendLive = useMemo(() => latestWins((scene: SceneConfig) => api.previewStage(scene), show.reportError), [show.reportError]);
  const lastLive = useRef<string | null>(null);
  const stage = show.status?.stage;
  useEffect(() => {
    if (mode !== 'live') { lastLive.current = null; return; }
    if (!wc.open || !stage) return;
    // Owner's choice (2026-11-26): Live always puts what you're editing on the porch, whichever scene
    // was on stage. (A blank new scene waits until it has something in it, rather than blacking out.)
    if (wc.neverStored && !wc.worthKeeping) return;
    const onPorch = (stage.preview ?? stage.scene) === wc.name;
    const key = `${wc.name}\n${JSON.stringify(wc.scene.layers)}`;
    if (key === lastLive.current) return;
    lastLive.current = key;
    // Already on the porch and unedited: nothing to send, unless Blind-saved edits are waiting there.
    if (onPorch && !wc.dirty && !(stage.dirty && stage.scene === wc.name && !stage.preview)) return;
    sendLive(wc.scene);
  }, [mode, wc, wc.version, stage, sendLive]);

  const latest = useRef({ show, mode });
  latest.current = { show, mode };
  const ops = useMemo(() => createSceneWork(wc, { show: () => latest.current.show, mode: () => latest.current.mode, select, lastLive }), [wc, select]);

  // A refresh or closing the tab would lose the edits: let the browser ask.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!wc.worthKeeping) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [wc]);

  return ops;
}

/**
 * Saving, reverting and discarding the working copy (no React here, so it can be tested on its own).
 * `lastLive` remembers what Live last sent to the porch.
 */
export function createSceneWork(wc: WorkingCopy, ctx: { show: () => Show; mode: () => EditMode; select: (n: string | null) => void; lastLive: { current: string | null } }): SceneWork {
  /** If the porch shows unsaved edits of this copy, put the stored version (or what was on before) back. */
  const restorePorch = async () => {
    const show = ctx.show();
    if (show.status?.stage.preview !== wc.name) return;
    try {
      if (wc.stored) await api.previewStage(wc.stored); // the stored version ends the preview
      else await api.endPreview();
    } catch (e) { show.reportError(e); }
    ctx.lastLive.current = null;
  };

  return {
    wc,
    save: async (asName?: string) => {
      const show = ctx.show();
      const from = wc.name;
      const scene: SceneConfig = { ...wc.scene, name: asName ?? from };
      const previewing = show.status?.stage.preview === from;
      try {
        const echo = await api.saveScene(scene, ctx.mode() === 'live');
        wc.markStored(scene);
        show.markSceneSaved(echo);
        if (scene.name !== from) {
          ctx.select(scene.name);
          // The porch was showing these edits under the old name: now it shows the stored new scene.
          if (previewing) await api.previewStage(scene);
        }
        ctx.lastLive.current = `${scene.name}\n${JSON.stringify(scene.layers)}`;
        return true;
      } catch (e) { show.reportError(e); return false; }
    },
    revert: async () => {
      await restorePorch();
      wc.revert();
    },
    discard: async () => {
      await restorePorch();
      if (wc.neverStored) wc.close(); else wc.revert();
    },
  };
}
