/** Shapes shared by the public demo's server (which builds the snapshot) and the browser (which plays it). */
import type { GroupConfig, LayoutConfig, RunConfig, Vec3 } from './layout.js';
import type { PlaylistConfig } from './playlist.js';
import type { LayerConfig, SceneConfig } from './scene.js';
import type { SavedPalette } from './wled/stops.js';

export interface DemoHousePart { id: string; name: string; uploadedAt: string; bytes: number; position: Vec3; rotation: number; scale: number; visible: boolean }

/** The show as the public demo sees it: an allow-list of the real show, plus the demo-only strings. */
export interface DemoSnapshot {
  layout: LayoutConfig;
  scenes: Record<string, SceneConfig>;
  playlists: Record<string, PlaylistConfig>;
  presets: Record<string, Omit<LayerConfig, 'id' | 'enabled' | 'paint'> & { name: string }>;
  palettes: Record<string, SavedPalette>;
  activeScene: string | null;
  stage: SceneConfig | null;
  output: { brightness: number; gamma: number; transition: number };
  house: { position: Vec3; rotation: number; scale: number; opacity: number; glow?: number; parts: DemoHousePart[] } | null;
}

/** A demo-only run: a normal run (points + coil), or lights spread over a dome filling a box (bushes). */
export type DemoRun = Omit<RunConfig, 'controller' | 'start'> & { dome?: { min: Vec3; max: Vec3 } };

export interface DemoExtras { runs: DemoRun[]; groups: Record<string, GroupConfig> }
