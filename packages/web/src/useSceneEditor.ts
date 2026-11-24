import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { SceneConfig } from '@xmas/engine';
import { api } from './api';
import { SceneEditor } from './editor';
import { latestWins } from './latest';
import type { Show } from './useShow';

export type EditMode = 'blind' | 'live';

/**
 * Edits one scene. Every change is saved as it happens: Blind saves leave the porch alone, Live saves
 * update it straight away if this scene is on stage.
 */
export function useSceneEditor(show: Show, sceneName: string | null, mode: EditMode) {
  const editor = useMemo(() => new SceneEditor({ name: '', layers: [] }), []);
  useSyncExternalStore((fn) => editor.subscribe(fn), () => editor.version);

  // Load a scene into the editor when the selection changes (not when the list merely refreshes).
  const loaded = useRef<string | null>(null);
  const lastSent = useRef('');
  /** What the server made of the last save (it fills in defaults), to tell our own echo from someone else's edit. */
  const lastEcho = useRef('');
  const epoch = useRef(show.epoch);
  const saved = show.scenes.find((s) => s.name === sceneName) ?? null;
  useEffect(() => {
    // The saved scenes changed underneath us (another device, or a restore): if this scene is one
    // of them, drop the working copy. Otherwise the next edit would save the old layers over it.
    const outside = epoch.current !== show.epoch;
    epoch.current = show.epoch;
    const key = saved ? JSON.stringify(saved.layers) : '';
    const replaced = outside && sceneName === loaded.current && saved !== null && key !== lastSent.current && key !== lastEcho.current;
    if ((sceneName !== loaded.current || replaced) && saved) {
      loaded.current = sceneName;
      editor.reset(saved);
      lastSent.current = key;
      lastEcho.current = key;
    }
  }, [editor, sceneName, saved, show.epoch]);

  const modeRef = useRef(mode);
  modeRef.current = mode;

  const save = useMemo(() => latestWins(
    async (scene: SceneConfig) => {
      const echo = await api.saveScene(scene, modeRef.current === 'live');
      lastEcho.current = JSON.stringify(echo.layers);
      show.markSceneSaved(scene);
    },
    show.reportError,
  ), [show.reportError, show.markSceneSaved]);

  // Save after each change (undo and redo included). latestWins keeps it to one request at a time.
  useEffect(() => {
    const scene = editor.scene;
    if (!scene.name || scene.name !== loaded.current) return;
    const key = JSON.stringify(scene.layers);
    if (key === lastSent.current) return;
    lastSent.current = key;
    save(scene);
  }, [editor, editor.version, save]);

  // Arming Live on the scene that's on stage sends the current working copy to the porch at once.
  const prevMode = useRef(mode);
  useEffect(() => {
    if (prevMode.current === 'blind' && mode === 'live' && editor.scene.name && show.status?.stage.scene === editor.scene.name) {
      api.saveScene(editor.scene, true).then(() => show.markSceneSaved(editor.scene)).catch(show.reportError);
    }
    prevMode.current = mode;
  }, [mode, editor, show]);

  return editor;
}
