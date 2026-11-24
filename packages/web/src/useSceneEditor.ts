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
  const saved = show.scenes.find((s) => s.name === sceneName) ?? null;
  useEffect(() => {
    if (sceneName !== loaded.current && saved) {
      loaded.current = sceneName;
      editor.reset(saved);
      lastSent.current = JSON.stringify(saved.layers);
    }
  }, [editor, sceneName, saved]);

  const modeRef = useRef(mode);
  modeRef.current = mode;

  const save = useMemo(() => latestWins(
    async (scene: SceneConfig) => { await api.saveScene(scene, modeRef.current === 'live'); show.markSceneSaved(scene); },
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
