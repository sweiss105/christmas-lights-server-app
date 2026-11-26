import type { LayerConfig, LayoutConfig, PaletteStop, ParamSpec, SavedPalette, SceneConfig } from '@xmas/engine';
import type { DecodeStats, MappingParams, MappingPlan } from '@xmas/engine/mapping';

/** A saved layer look. */
export type Preset = Omit<LayerConfig, 'id' | 'enabled' | 'paint'> & { name: string };

/** One uploaded scan, placed relative to the house. */
export interface HousePart {
  id: string;
  name: string;
  bytes: number;
  uploadedAt: string;
  position: [number, number, number];
  rotation: number;
  scale: number;
  visible: boolean;
}

export interface House {
  position: [number, number, number];
  /** Degrees around the vertical axis. */
  rotation: number;
  scale: number;
  opacity: number;
  /** Strength of the lights' spill on the house model in the preview: 0 is off, 1 the default. */
  glow?: number;
  parts: HousePart[];
}

export interface EffectInfo { id: string; name: string; description: string; params: ParamSpec[] }

export interface ControllerHealth {
  id: string;
  host: string;
  online: boolean;
  framesSent: number;
  sendErrors: number;
  lastError?: string;
  info?: { name: string; version: string; ledCount: number };
  warning?: string;
}

export interface PlaylistEntry {
  scene: string;
  seconds: number;
  /** Seconds to crossfade into this scene (0..60); absent = the app's fade. */
  fade?: number;
}
export interface Playlist { name: string; entries: PlaylistEntry[]; loop: boolean; /** Random order, new each time round. */ shuffle?: boolean }
export type OnAt = { kind: 'sunset'; offsetMinutes?: number } | { kind: 'time'; time: string };
export type OffAt = { kind: 'time'; time: string } | { kind: 'sunrise'; offsetMinutes?: number };
export interface Schedule {
  enabled: boolean;
  timezone: string;
  latitude?: number;
  longitude?: number;
  on: OnAt;
  off: OffAt;
  run: { kind: 'scene' | 'playlist'; name: string };
}
export interface ScheduleStatus extends Schedule { active: boolean; nextOn: number; nextOff: number }

export interface Status {
  scene: string | null;
  /** `preview` names the scene whose unsaved edits are on the porch (Live editing), when there is one. */
  stage: { scene: string | null; dirty: boolean; preview?: string };
  playlist: { name: string; index: number; scene: string | null; nextAt: number | null } | null;
  schedule: ScheduleStatus | null;
  pixels: number;
  output: { brightness: number; gamma: number; enabled: boolean; transition: number };
  stream: { running: boolean; targetFps: number; fps: number; renderMs: number; lateFrames: number; controllers: ControllerHealth[] };
  /** Counts changes made through the API; `by` is the id of the browser that made the last one. */
  rev?: { boot: string; n: number; by: string };
  /** The MQTT link to Home Assistant (enabled when XMAS_MQTT_URL is set on the server). */
  homeassistant?: { enabled: boolean; connected: boolean };
}

/** One spot the phone filmed from: what it found, kept on the server so it can be solved again. */
export interface MappingView {
  id: string;
  createdAt: string;
  width: number;
  height: number;
  layoutPixels: number;
  params: MappingParams;
  detections: { pixel: number; x: number; y: number; strength?: number; margin?: number }[];
  stats?: Partial<DecodeStats>;
  label?: string;
  /** Which camera filmed it ("label@zoom"); spots with the same one share a focal length when solving. */
  camera?: string;
}

export interface MappingStart { active: boolean; now: number; streaming: boolean; startsAt: number; endsAt: number; plan: MappingPlan }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** This tab's id, sent with every request so the server can say who made the latest change. */
export const CLIENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

type DemoHandler = (method: string, path: string, body?: unknown) => Promise<unknown>;
let demoHandler: DemoHandler | null = null;
/** The public demo answers every request in the browser instead of the network (see demo/install.ts). */
export function setDemoHandler(h: DemoHandler | null) { demoHandler = h; }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (demoHandler) return demoHandler(method, path, body) as Promise<T>;
  const res = await fetch(path, {
    method,
    headers: { 'x-client-id': CLIENT_ID, ...(body !== undefined && { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  // Cloudflare Access sends an expired session to its login page; reload to sign in again.
  if (res.redirected && !res.url.startsWith(location.origin)) { location.reload(); throw new ApiError(401, 'signing in again'); }
  const text = await res.text();
  let data: unknown = undefined;
  try { data = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? `${method} ${path} failed (${res.status})`);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  status: () => call<Status>('GET', '/api/status'),
  /** Sign in with the server's API token; the server answers with a cookie the browser then sends by itself. */
  login: (token: string) => call<{ ok: true; required: boolean }>('POST', '/api/login', { token }),
  clock: async () => (await call<{ t: number }>('GET', '/api/clock')).t,
  layout: () => call<LayoutConfig>('GET', '/api/layout'),
  scenes: () => call<{ active: string | null; scenes: SceneConfig[] }>('GET', '/api/scenes'),
  stage: () => call<SceneConfig>('GET', '/api/stage'),
  groups: () => call<{ name: string; pixels: number }[]>('GET', '/api/groups'),
  effects: () => call<EffectInfo[]>('GET', '/api/effects'),
  /** Save a scene. Blind (apply=false) leaves the porch alone; Live (apply=true) updates it if the scene is on stage. */
  saveScene: (scene: SceneConfig, apply: boolean) => call<SceneConfig>('PUT', `/api/scenes/${enc(scene.name)}?apply=${apply}`, { layers: scene.layers }),
  /** Live editing: show a scene that isn't stored on the porch. Sending a scene's stored version ends the preview. */
  previewStage: (scene: SceneConfig) => call<{ stage: SceneConfig; preview: string | null }>('POST', '/api/stage/preview', { name: scene.name, layers: scene.layers }),
  /** End a Live preview: what was on stage before it comes back. */
  endPreview: () => call<{ preview: null }>('DELETE', '/api/stage/preview'),
  /** Rename a scene; playlists, the schedule and the stage follow it. */
  renameScene: (name: string, to: string) => call<SceneConfig>('POST', `/api/scenes/${enc(name)}/rename`, { to }),
  deleteScene: (name: string) => call<{ deleted: string }>('DELETE', `/api/scenes/${enc(name)}`),
  presets: () => call<Preset[]>('GET', '/api/presets'),
  savePreset: (name: string, look: Omit<Preset, 'name'>) => call<Preset>('PUT', `/api/presets/${enc(name)}`, look),
  deletePreset: (name: string) => call<{ deleted: string }>('DELETE', `/api/presets/${enc(name)}`),
  palettes: () => call<SavedPalette[]>('GET', '/api/palettes'),
  savePalette: (name: string, stops: PaletteStop[]) => call<SavedPalette>('PUT', `/api/palettes/${enc(name)}`, { stops }),
  renamePalette: (name: string, to: string) => call<SavedPalette>('POST', `/api/palettes/${enc(name)}/rename`, { to }),
  deletePalette: (name: string) => call<{ deleted: string }>('DELETE', `/api/palettes/${enc(name)}`),
  /** Flash one run on the porch (only visible while streaming); run null cancels. */
  identify: (run: string | null, seconds = 5) => call<{ run: string | null; streaming?: boolean }>('POST', '/api/identify', { run, seconds }),
  saveLayout: (l: LayoutConfig) => call<{ pixels: number; groups: string[] }>('PUT', '/api/layout', l),
  house: () => call<House>('GET', '/api/house'),
  setHouse: (h: Partial<Omit<House, 'parts'>>) => call<House>('PATCH', '/api/house', h),
  uploadHousePart: async (file: Blob, name: string) => {
    if (demoHandler) return demoHandler('POST', '/api/house/parts') as Promise<HousePart>;
    const res = await fetch(`/api/house/parts?name=${encodeURIComponent(name)}`, { method: 'POST', body: file, headers: { 'content-type': 'model/gltf-binary', 'x-client-id': CLIENT_ID }, credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `upload failed (${res.status})`);
    return (await res.json()) as HousePart;
  },
  setHousePart: (id: string, p: Partial<Omit<HousePart, 'id' | 'bytes' | 'uploadedAt'>>) => call<HousePart>('PATCH', `/api/house/parts/${enc(id)}`, p),
  deleteHousePart: (id: string) => call<{ deleted: string }>('DELETE', `/api/house/parts/${enc(id)}`),
  playlists: () => call<Playlist[]>('GET', '/api/playlists'),
  savePlaylist: (p: Playlist) => call<Playlist>('PUT', `/api/playlists/${enc(p.name)}`, { entries: p.entries, loop: p.loop, shuffle: !!p.shuffle }),
  deletePlaylist: (name: string) => call<{ deleted: string }>('DELETE', `/api/playlists/${enc(name)}`),
  playPlaylist: (name: string) => call<{ playing: string }>('POST', `/api/playlists/${enc(name)}/play`),
  stopPlaylist: () => call<{ playing: null }>('POST', '/api/playlists/stop'),
  schedule: () => call<ScheduleStatus | { enabled: false }>('GET', '/api/schedule'),
  saveSchedule: (s: Schedule) => call<ScheduleStatus>('PUT', '/api/schedule', s),
  /** Look for WLED controllers on the network (mDNS), with each one's info. */
  discoverControllers: () => call<{ host: string; port: number; mdnsName: string; info?: { name: string; version: string; ledCount: number }; error?: string }[]>('POST', '/api/controllers/discover?timeout=3000'),
  backups: () => call<{ file: string; bytes: number; modified: number }[]>('GET', '/api/backups'),
  restore: (data: unknown) => call<{ restored: true; savedFirst: string }>('POST', '/api/restore', data),
  restoreBackup: (file: string) => call<{ restored: true; savedFirst: string }>('POST', `/api/backups/${enc(file)}/restore`),
  /** Go: put a saved scene on the porch. */
  go: (name: string) => call<{ active: string }>('POST', `/api/scenes/${enc(name)}/activate`),
  blackout: () => call<{ active: null }>('POST', '/api/blackout'),
  mappingStart: (p: Partial<MappingParams> & { leadMs?: number }) => call<MappingStart>('POST', '/api/mapping/start', p),
  /** Brightness test: every k-th light held at `level` for `seconds` (0 stops it). */
  mappingPreview: (p: Partial<MappingParams> & { seconds: number }) => call<{ preview: { lights: number; level: number } | null }>('POST', '/api/mapping/preview', p),
  mappingStop: () => call<{ active: boolean }>('POST', '/api/mapping/stop'),
  mappingViews: () => call<MappingView[]>('GET', '/api/mapping/views'),
  saveMappingView: (v: Omit<MappingView, 'id' | 'createdAt' | 'layoutPixels'>) => call<MappingView>('POST', '/api/mapping/views', v),
  /** A spot's footage copy (see mapping/cameraControl.ts); raw bytes, not JSON. */
  uploadRecording: async (blob: Blob, q: { view: string; label: string; gz: boolean }) => {
    if (demoHandler) return demoHandler('POST', '/api/mapping/recordings') as Promise<{ saved: string; bytes: number }>;
    const res = await fetch(`/api/mapping/recordings?view=${enc(q.view)}&label=${enc(q.label)}&gz=${q.gz ? 1 : 0}`, {
      method: 'POST', headers: { 'x-client-id': CLIENT_ID, 'content-type': 'application/octet-stream' }, body: blob, credentials: 'same-origin',
    });
    if (!res.ok) throw new ApiError(res.status, `uploading the footage failed (${res.status})`);
    return (await res.json()) as { saved: string; bytes: number };
  },
  deleteMappingView: (id: string) => call<{ deleted: string }>('DELETE', `/api/mapping/views/${enc(id)}`),
  /** Save a backup now; `reason` starts its file name. */
  backupNow: (reason: string) => call<{ file: string }>('POST', '/api/backups', { reason }),
  setOutput: (o: Partial<{ brightness: number; enabled: boolean; fps: number; transition: number }>) => call<Status['output']>('PATCH', '/api/output', o),
};
