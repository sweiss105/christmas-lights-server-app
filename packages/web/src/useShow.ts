import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LayoutConfig, SceneConfig } from '@xmas/engine';
import { api, type Status } from './api';
import { ServerClock } from './clock';

export interface Show {
  layout: LayoutConfig | null;
  scenes: SceneConfig[];
  status: Status | null;
  /** The scene the porch is running (fetched whenever the stage changes). */
  stage: SceneConfig | null;
  clock: ServerClock;
  connected: boolean;
  error: string | null;
  reportError: (e: unknown) => void;
  clearError: () => void;
  refresh: () => Promise<void>;
  /** Record a scene the editor just saved, without reloading everything. */
  markSceneSaved: (scene: SceneConfig) => void;
}

const POLL_MS = 1000;

/** Loads the show from the server and keeps status and stage current. */
export function useShow(): Show {
  const [layout, setLayout] = useState<LayoutConfig | null>(null);
  const [scenes, setScenes] = useState<SceneConfig[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [stage, setStage] = useState<SceneConfig | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clockRef = useRef(new ServerClock(api.clock));
  const stageKey = useRef('');

  const reportError = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);

  const pollStatus = useCallback(async () => {
    try {
      const s = await api.status();
      setStatus(s);
      setConnected(true);
      // Fetch the running scene only when what's on stage changes.
      const key = `${s.stage.scene}|${s.stage.dirty}`;
      if (key !== stageKey.current) {
        stageKey.current = key;
        setStage(await api.stage());
      }
    } catch {
      setConnected(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    const [l, sc] = await Promise.all([api.layout(), api.scenes()]);
    setLayout(l);
    setScenes(sc.scenes);
    stageKey.current = '';
    await pollStatus();
  }, [pollStatus]);

  useEffect(() => {
    let stop = false;
    refresh().catch(reportError);
    clockRef.current.sync().catch(() => {});
    const poll = setInterval(() => { if (!stop) void pollStatus(); }, POLL_MS);
    // Re-sync now and then so the preview stays in step after the tab sleeps.
    const resync = setInterval(() => { clockRef.current.sync().catch(() => {}); }, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') { clockRef.current.sync().catch(() => {}); void pollStatus(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stop = true; clearInterval(poll); clearInterval(resync); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh, pollStatus, reportError]);

  const markSceneSaved = useCallback((scene: SceneConfig) => {
    setScenes((prev) => {
      const i = prev.findIndex((s) => s.name === scene.name);
      if (i < 0) return [...prev, scene];
      const next = [...prev];
      next[i] = scene;
      return next;
    });
    void pollStatus();
  }, [pollStatus]);

  const clearError = useCallback(() => setError(null), []);

  return useMemo(() => ({
    layout, scenes, status, stage, clock: clockRef.current, connected, error,
    reportError, clearError, refresh, markSceneSaved,
  }), [layout, scenes, status, stage, connected, error, reportError, clearError, refresh, markSceneSaved]);
}
