import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LayoutConfig, SceneConfig } from '@xmas/engine';
import { api, ApiError, CLIENT_ID, type House, type Preset, type Status } from './api';
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
  presets: Preset[];
  refreshPresets: () => Promise<void>;
  house: House | null;
  setHouseLocal: (h: House) => void;
  /** Record a scene the editor just saved, without reloading everything. */
  markSceneSaved: (scene: SceneConfig) => void;
  /** The server wants its API token and this browser hasn't signed in. */
  needsToken: boolean;
  /**
   * Goes up when saved scenes changed underneath this tab (another tab or device edited them, or a
   * backup was restored), so editors drop their working copy and load the saved one.
   */
  epoch: number;
  /** Reload everything after this tab replaced the whole show (a restore). */
  reloadAll: () => Promise<void>;
}

const POLL_MS = 1000;

/** Loads the show from the server and keeps status and stage current. */
export function useShow(): Show {
  const [layout, setLayout] = useState<LayoutConfig | null>(null);
  const [scenes, setScenes] = useState<SceneConfig[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [stage, setStage] = useState<SceneConfig | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [house, setHouse] = useState<House | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clockRef = useRef(new ServerClock(api.clock));
  const stageKey = useRef('');
  const [needsToken, setNeedsToken] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const revKey = useRef<string | null>(null);
  const scenesKey = useRef('');
  const onOutsideChange = useRef<() => void>(() => {});

  const reportError = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);

  const pollStatus = useCallback(async () => {
    try {
      const s = await api.status();
      setStatus(s);
      setConnected(true);
      setNeedsToken(false);
      // Someone else changed something (another tab, the tablet): load it, so this tab doesn't
      // carry on from a stale copy and overwrite their work with its next save.
      if (s.rev) {
        const key = `${s.rev.boot}:${s.rev.n}`;
        const first = revKey.current === null;
        if (key !== revKey.current) {
          revKey.current = key;
          if (!first && s.rev.by !== CLIENT_ID) onOutsideChange.current();
        }
      }
      // Fetch the running scene only when what's on stage changes.
      const key = `${s.stage.scene}|${s.stage.dirty}`;
      if (key !== stageKey.current) {
        stageKey.current = key;
        setStage(await api.stage());
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedsToken(true);
      setConnected(false);
    }
  }, []);

  /** Load layout and scenes; true if the saved scenes differ from what this tab had. */
  const load = useCallback(async () => {
    const [l, sc] = await Promise.all([api.layout(), api.scenes()]);
    setLayout(l);
    setScenes(sc.scenes);
    const key = JSON.stringify(sc.scenes);
    const changed = scenesKey.current !== '' && key !== scenesKey.current;
    scenesKey.current = key;
    stageKey.current = '';
    await pollStatus();
    return changed;
  }, [pollStatus]);
  const refresh = useCallback(async () => { await load(); }, [load]);

  useEffect(() => {
    let stop = false;
    refresh().catch((e) => { if (e instanceof ApiError && e.status === 401) setNeedsToken(true); else reportError(e); });
    clockRef.current.sync().catch(() => {});
    const poll = setInterval(() => { if (!stop) void pollStatus(); }, POLL_MS);
    // Re-sync now and then so the preview stays in step after the tab sleeps.
    const resync = setInterval(() => { clockRef.current.sync().catch(() => {}); }, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') { clockRef.current.sync().catch(() => {}); void pollStatus(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stop = true; clearInterval(poll); clearInterval(resync); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh, pollStatus, reportError]);

  const refreshPresets = useCallback(async () => { setPresets(await api.presets()); }, []);
  useEffect(() => { refreshPresets().catch(() => {}); api.house().then(setHouse).catch(() => {}); }, [refreshPresets]);

  const reloadAll = useCallback(async () => {
    await Promise.all([load(), refreshPresets(), api.house().then(setHouse)]);
    setEpoch((n) => n + 1);
  }, [load, refreshPresets]);
  onOutsideChange.current = () => {
    void (async () => {
      const [scenesChanged] = await Promise.all([load(), refreshPresets(), api.house().then(setHouse)]);
      if (scenesChanged) setEpoch((n) => n + 1);
    })().catch(() => {});
  };

  const markSceneSaved = useCallback((scene: SceneConfig) => {
    setScenes((prev) => {
      const i = prev.findIndex((s) => s.name === scene.name);
      const next = i < 0 ? [...prev, scene] : prev.map((s, j) => (j === i ? scene : s));
      scenesKey.current = JSON.stringify(next); // our own save isn't a change from outside
      return next;
    });
    void pollStatus();
  }, [pollStatus]);

  const clearError = useCallback(() => setError(null), []);

  return useMemo(() => ({
    layout, scenes, status, stage, clock: clockRef.current, connected, error,
    reportError, clearError, refresh, markSceneSaved, presets, refreshPresets, house, setHouseLocal: setHouse,
    needsToken, epoch, reloadAll,
  }), [layout, scenes, status, stage, connected, error, reportError, clearError, refresh, markSceneSaved, presets, refreshPresets, house, needsToken, epoch, reloadAll]);
}
