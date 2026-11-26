/**
 * The public demo's stand-in for the server. In the demo build every request the app makes (see
 * `call()` in api.ts) is answered here, from the tab's own copy of the show, so each visitor's Go,
 * Live edits and playlists stay in their tab and nothing is ever stored. It follows the server's
 * routes in packages/server/src/api.ts; whatever stores, renames or deletes is refused.
 */
import { buildLayout, EFFECTS, Engine, PALETTE_NAMES, playlistPosition, validateScene, type DemoSnapshot, type LayerConfig, type SceneConfig } from '@xmas/engine';
import { ApiError } from '../api';
import { DEMO_REFUSAL } from './flag';

export { DEMO_REFUSAL };
const UNAVAILABLE = 'The demo is unavailable right now. Try again in a minute.';
const MAX_NAME = 80;

export interface DemoBackend { handle(method: string, path: string, body?: unknown): Promise<unknown> }

const refuse = () => new ApiError(403, DEMO_REFUSAL);
const bad = (e: unknown) => new ApiError(400, (e as Error).message);

/**
 * A stand-in started from the snapshot. `now` is the wall clock in ms (playlists), `clock` the effect
 * clock in seconds (the 3D preview animates on it).
 */
export function createDemoBackend(snapshot: DemoSnapshot, now: () => number = Date.now, clock: () => number = () => performance.now() / 1000): DemoBackend {
  const show = structuredClone(snapshot);
  const engine = new Engine(buildLayout(show.layout));
  engine.setOutput({ brightness: show.output.brightness, gamma: show.output.gamma });
  let activeScene: string | null = null;
  if (show.activeScene && show.scenes[show.activeScene]) {
    try { engine.setScene(show.stage ?? show.scenes[show.activeScene]!); activeScene = show.activeScene; } catch {
      try { engine.setScene(show.scenes[show.activeScene]!); activeScene = show.activeScene; } catch { /* starts dark */ }
    }
  }
  let preview: { of: string; base: SceneConfig } | null = null;
  let playing: { playlist: string; startedAt: number } | null = null;
  let enabled = true;
  let transition = show.output.transition;
  const has = <T>(o: Record<string, T>, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);
  const storedStage = () => (preview ? preview.base : engine.scene);
  const fade = () => transition;

  /** A layer naming a saved palette without its colours gets a copy, as the server does. */
  const withSavedPalettes = (layers: LayerConfig[] | undefined): LayerConfig[] => {
    if (!Array.isArray(layers)) return layers as unknown as LayerConfig[];
    return layers.map((l) => {
      const name = l?.params?.palette;
      if (typeof name !== 'string' || l.params!.paletteStops != null || PALETTE_NAMES.includes(name)) return l;
      const saved = has(show.palettes, name);
      return saved ? { ...l, params: { ...l.params, paletteStops: structuredClone(saved.stops) } } : l;
    });
  };
  const sceneNameOk = (name: string) => name.length > 0 && name.length <= MAX_NAME && name === name.trim() && name !== '__proto__';

  const playlistStatus = () => {
    const pl = playing && has(show.playlists, playing.playlist);
    if (!pl || !playing) return null;
    const pos = playlistPosition(pl.entries, playing.startedAt, now(), pl.loop, pl.shuffle);
    return { name: pl.name, index: pos.index, scene: pl.entries[pos.index]?.scene ?? null, nextAt: pos.nextAt };
  };
  /** Put the playlist's current scene on stage when it's time (the server does this every second). */
  const advancePlaylist = () => {
    const st = playlistStatus();
    if (!st?.scene || st.scene === activeScene) return;
    const scene = has(show.scenes, st.scene);
    if (!scene) return; // deleted since; skip
    const entryFade = has(show.playlists, st.name)?.entries[st.index]?.fade;
    try { engine.setScene(scene, { fade: entryFade ?? fade() }); } catch { return; }
    preview = null;
    activeScene = scene.name;
  };

  const stageDirty = () => {
    const saved = activeScene ? has(show.scenes, activeScene) : undefined;
    if (!saved) return false;
    try { return JSON.stringify(validateScene(saved, engine.layout)) !== JSON.stringify(storedStage()); } catch { return true; }
  };
  const output = () => ({ ...engine.output, enabled, transition: fade() });
  const status = () => {
    advancePlaylist();
    return {
      scene: activeScene,
      stage: { scene: activeScene, dirty: stageDirty(), ...(preview && { preview: preview.of }) },
      playlist: playlistStatus(),
      schedule: null,
      pixels: engine.layout.count,
      output: output(),
      stream: {
        running: enabled, targetFps: 40, fps: enabled ? 40 : 0, renderMs: 0, lateFrames: 0,
        controllers: [{ id: 'demo', host: 'demo', online: true, framesSent: 0, sendErrors: 0 }],
      },
      rev: { boot: 'demo', n: 0, by: '' },
      homeassistant: { enabled: false, connected: false },
    };
  };

  const go = (name: string) => {
    const s = has(show.scenes, name);
    if (!s) throw new ApiError(404, 'no such scene');
    try { engine.setScene(s, { fade: fade() }); } catch (e) { throw bad(e); }
    preview = null;
    activeScene = s.name;
    playing = null; // a manual Go takes over from a playlist
    return { active: name };
  };

  const startPreview = (body: Partial<SceneConfig> | undefined) => {
    const name = typeof body?.name === 'string' ? body.name : '';
    if (!sceneNameOk(name)) throw new ApiError(400, `a scene name must be 1..${MAX_NAME} characters`);
    let valid: SceneConfig;
    try { valid = new Engine(engine.layout).setScene({ ...body, name, layers: withSavedPalettes(body?.layers) } as SceneConfig); } catch (e) { throw bad(e); }
    const showing = preview ? preview.of : activeScene;
    const f = showing === name ? {} : { fade: fade() };
    const stored = has(show.scenes, name);
    let storedValid: SceneConfig | undefined;
    try { storedValid = stored && validateScene(stored, engine.layout); } catch { storedValid = undefined; }
    if (storedValid && JSON.stringify(storedValid) === JSON.stringify(valid)) {
      const unchanged = !preview && activeScene === name && JSON.stringify(engine.scene) === JSON.stringify(valid);
      if (!unchanged) engine.setScene(stored!, f);
      preview = null;
      activeScene = name;
      return { stage: engine.scene, preview: null };
    }
    const base = preview ? preview.base : engine.scene;
    engine.setScene(valid, f);
    preview = { of: name, base };
    return { stage: engine.scene, preview: name };
  };

  const setOutput = (b: { brightness?: number; gamma?: number; fps?: number; enabled?: boolean; transition?: number }) => {
    if (b.fps !== undefined && (!Number.isInteger(b.fps) || b.fps < 1 || b.fps > 60)) throw new ApiError(400, 'fps must be an integer 1..60');
    if (b.transition !== undefined && (typeof b.transition !== 'number' || !Number.isFinite(b.transition) || b.transition < 0 || b.transition > 10)) throw new ApiError(400, 'transition must be 0..10 seconds');
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') throw new ApiError(400, 'enabled must be boolean');
    try { engine.setOutput({ ...(b.brightness !== undefined && { brightness: b.brightness }), ...(b.gamma !== undefined && { gamma: b.gamma }) }); } catch (e) { throw bad(e); }
    if (b.enabled !== undefined) enabled = b.enabled;
    if (b.transition !== undefined) transition = b.transition;
    return { ...output(), fps: 40 };
  };

  const sorted = <T extends { name: string }>(o: Record<string, T>) => Object.values(o).sort((a, b) => a.name.localeCompare(b.name));
  const found = <T>(v: T | undefined, what: string): T => { if (v === undefined) throw new ApiError(404, `no such ${what}`); return v; };

  /** One request, by method and path (with its query string). */
  const route = (method: string, url: string, body: unknown): unknown => {
    const path = url.split('?')[0]!;
    const seg = path.split('/').slice(1).map((s) => decodeURIComponent(s)); // ['api', ...]
    const [api, a, b, c] = seg;
    if (api !== 'api') throw new ApiError(404, `no route ${method} ${path}`);
    if (method === 'GET' || method === 'HEAD') {
      if (seg.length === 2) {
        switch (a) {
          case 'status': return status();
          case 'stage': advancePlaylist(); return engine.scene;
          case 'clock': return { t: clock() };
          case 'effects': return Object.values(EFFECTS).map(({ id, name, description, params }) => ({ id, name, description, params }));
          case 'layout': return show.layout;
          case 'groups': return [...engine.layout.groups.entries()].map(([name, m]) => ({ name, pixels: m.reduce((x, y) => x + y, 0) }));
          case 'scenes': return { active: activeScene, scenes: Object.values(show.scenes) };
          case 'presets': return sorted(show.presets);
          case 'palettes': return sorted(show.palettes);
          case 'playlists': return sorted(show.playlists);
          case 'house': return show.house ?? { position: [0, 0, 0], rotation: 0, scale: 1, opacity: 0.85, glow: 1, parts: [] };
          case 'output': return { ...output(), fps: 40 };
          case 'schedule': return { enabled: false };
          case 'controllers': return status().stream.controllers;
          case 'backups': throw refuse();
        }
      }
      if (seg.length === 3) {
        if (a === 'scenes') return found(has(show.scenes, b!), 'scene');
        if (a === 'presets') return found(has(show.presets, b!), 'preset');
        if (a === 'palettes') return found(has(show.palettes, b!), 'palette');
        if (a === 'mapping' && b === 'views') throw refuse();
      }
      throw new ApiError(404, `no route ${method} ${path}`);
    }
    if (method === 'POST') {
      if (a === 'scenes' && c === 'activate' && seg.length === 4) return go(b!);
      if (a === 'blackout' && seg.length === 2) {
        engine.setScene({ name: 'Blackout', layers: [] }, { fade: fade() });
        preview = null; activeScene = null; playing = null;
        return { active: null };
      }
      if (a === 'stage' && b === 'preview' && seg.length === 3) return startPreview(body as Partial<SceneConfig>);
      if (a === 'playlists' && b === 'stop' && seg.length === 3) { playing = null; return { playing: null }; }
      if (a === 'playlists' && c === 'play' && seg.length === 4) {
        if (!has(show.playlists, b!)) throw new ApiError(404, 'no such playlist');
        playing = { playlist: b!, startedAt: now() };
        advancePlaylist();
        return { playing: b };
      }
      if (a === 'identify' && seg.length === 2) return { run: null, streaming: false };
    }
    if (method === 'DELETE' && a === 'stage' && b === 'preview' && seg.length === 3) {
      if (preview) {
        const { base } = preview;
        preview = null;
        try { engine.setScene(base, { fade: fade() }); } catch { /* keep what's showing */ }
      }
      return { preview: null };
    }
    if (method === 'PATCH' && a === 'output' && seg.length === 2) return setOutput((body ?? {}) as Parameters<typeof setOutput>[0]);
    throw refuse(); // everything else stores, renames or deletes something
  };

  return {
    handle: async (method, path, body) => structuredClone(route(method.toUpperCase(), path, body)),
  };
}

/** Fetch the demo snapshot once and start the stand-in on it. */
export async function loadDemoBackend(): Promise<DemoBackend> {
  let res: Response;
  try { res = await fetch('/demo/show.json', { cache: 'no-cache' }); } catch { throw new ApiError(503, UNAVAILABLE); }
  if (!res.ok) throw new ApiError(503, UNAVAILABLE);
  return createDemoBackend((await res.json()) as DemoSnapshot);
}
