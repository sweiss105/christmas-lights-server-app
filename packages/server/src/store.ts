/** Persisted show state: one JSON file, written atomically. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LayerConfig, LayoutConfig, OutputSettings, SavedPalette, SceneConfig } from '@xmas/engine';
import type { PlaylistConfig, ScheduleConfig } from './show.js';

/** A saved layer look: an effect with all its settings, reusable in any scene. */
export type PresetConfig = Omit<LayerConfig, 'id' | 'enabled' | 'paint'> & { name: string };

/** One uploaded scan (a .glb), placed relative to the house. */
export interface HousePart {
  id: string;
  name: string;
  /** File name next to the state file. */
  file: string;
  bytes: number;
  uploadedAt: string;
  /** Metres, degrees around the vertical axis, and scale: this part relative to the house. */
  position: [number, number, number];
  rotation: number;
  scale: number;
  visible: boolean;
}

export interface HouseConfig {
  /** Metres, added to every part: lines the whole house up with the lights. */
  position: [number, number, number];
  /** Degrees around the vertical axis. */
  rotation: number;
  scale: number;
  /** 0..1 in the preview. */
  opacity: number;
  /** Strength of the lights' coloured spill on the house in the preview: 0 is off, 1 the default, up to 3. */
  glow?: number;
  /** Scans, e.g. two halves of the house captured separately. */
  parts?: HousePart[];
  /** Before parts existed: a single model in house.glb. Migrated into parts on startup. */
  model?: { bytes: number; uploadedAt: string };
}

export const DEFAULT_HOUSE: HouseConfig = { position: [0, 0, 0], rotation: 0, scale: 1, opacity: 0.85, glow: 1 };

export interface ShowState {
  layout: LayoutConfig;
  scenes: Record<string, SceneConfig>;
  activeScene: string | null;
  /** `transition`: seconds Go and Blackout crossfade over (0 = cut); missing in older state files. */
  output: OutputSettings & { fps: number; enabled: boolean; transition?: number };
  /** 3D house model (a phone scan) and how it lines up with the lights. */
  house?: HouseConfig;
  /** The scene the porch was running (may differ from the saved copy while Blind edits are pending), so a restart restores it. */
  stage?: SceneConfig;
  /** Playlists by name: scenes played in turn. */
  playlists?: Record<string, PlaylistConfig>;
  /** The playlist running now, if any (its position follows from when it started). */
  playing?: { playlist: string; startedAt: number };
  /** Nightly on/off. */
  schedule?: ScheduleConfig;
  /** Whether the schedule's on window was open when the server last acted on it, so a restart can catch up on a switch it missed. */
  scheduleInWindow?: boolean;
  /** Layer presets by name. Missing in state files from before presets existed. */
  presets?: Record<string, PresetConfig>;
  /**
   * Saved palettes by name (edited copies of built-in ones), for any layer to pick. A layer that uses
   * one keeps its own copy of the stops (params.paletteStops), so renaming or deleting one never changes
   * a scene. Missing in state files from before palettes could be saved.
   */
  palettes?: Record<string, SavedPalette>;
}

export async function loadState(path: string, examplePath: string): Promise<ShowState> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    raw = await readFile(examplePath, 'utf8');
  }
  return JSON.parse(raw) as ShowState;
}

let writing: Promise<void> = Promise.resolve();

export function saveState(path: string, state: ShowState): Promise<void> {
  const body = JSON.stringify(state, null, 2) + '\n';
  // Each write waits for the one before it, whether that one worked or not: a failed save (disk full,
  // a file owned by someone else) must not stop every later save from being tried.
  const mine = writing.catch(() => {}).then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, path);
  });
  writing = mine;
  return mine;
}
