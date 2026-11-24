/** Persisted show state: one JSON file, written atomically. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LayerConfig, LayoutConfig, OutputSettings, SceneConfig } from '@xmas/engine';

/** A saved layer look: an effect with all its settings, reusable in any scene. */
export type PresetConfig = Omit<LayerConfig, 'id' | 'enabled'> & { name: string };

export interface HouseConfig {
  /** Metres, added to the model's own coordinates. */
  position: [number, number, number];
  /** Degrees around the vertical axis. */
  rotation: number;
  scale: number;
  /** 0..1 in the preview. */
  opacity: number;
  /** Set when a model file (house.glb next to the state file) has been uploaded. */
  model?: { bytes: number; uploadedAt: string };
}

export const DEFAULT_HOUSE: HouseConfig = { position: [0, 0, 0], rotation: 0, scale: 1, opacity: 0.85 };

export interface ShowState {
  layout: LayoutConfig;
  scenes: Record<string, SceneConfig>;
  activeScene: string | null;
  output: OutputSettings & { fps: number; enabled: boolean };
  /** 3D house model (a phone scan) and how it lines up with the lights. */
  house?: HouseConfig;
  /** Layer presets by name. Missing in state files from before presets existed. */
  presets?: Record<string, PresetConfig>;
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
  writing = writing.then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, path);
  });
  return writing;
}
