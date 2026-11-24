import { EFFECTS, type LayerConfig, type SceneConfig } from '@xmas/engine';

/** A layer's look without its identity: what a preset stores. */
export type Look = Omit<LayerConfig, 'id' | 'enabled'>;

/**
 * A working copy of any JSON value with undo and redo. Values are treated as immutable: every edit
 * produces a new value, so history entries never change underneath us.
 */
export class History<T> {
  private current: T;
  private past: T[] = [];
  private future: T[] = [];
  private mergeKey: string | null = null;
  private listeners = new Set<() => void>();
  /** Bumps on every change; handy as a React snapshot. */
  version = 0;

  constructor(value: T, private readonly limit = 200) {
    this.current = value;
  }

  get value(): T { return this.current; }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }

  /**
   * Replace the working value. Edits sharing a `merge` key with the previous one (a slider drag)
   * collapse into a single undo step until `endGesture()`.
   */
  edit(next: T, opts: { merge?: string } = {}): void {
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    const merging = opts.merge !== undefined && opts.merge === this.mergeKey && this.past.length > 0;
    if (!merging) {
      this.past.push(this.current);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.future = [];
    this.mergeKey = opts.merge ?? null;
    this.set(next);
  }

  /** Ends a continuous gesture, so the next edit starts a new undo step. */
  endGesture(): void { this.mergeKey = null; }

  undo(): void {
    const prev = this.past.pop();
    if (prev === undefined) return;
    this.future.push(this.current);
    this.mergeKey = null;
    this.set(prev);
  }

  redo(): void {
    const next = this.future.pop();
    if (next === undefined) return;
    this.past.push(this.current);
    this.mergeKey = null;
    this.set(next);
  }

  /** Load a different value, clearing history. */
  reset(value: T): void {
    this.past = [];
    this.future = [];
    this.mergeKey = null;
    this.set(value);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(value: T) {
    this.current = value;
    this.version++;
    for (const fn of this.listeners) fn();
  }
}

/** Working copy of one scene. */
export class SceneEditor extends History<SceneConfig> {
  get scene(): SceneConfig { return this.value; }
}

// ---- pure scene operations (each returns a new scene) -----------------------------------------

const mapLayer = (scene: SceneConfig, id: string, fn: (l: LayerConfig) => LayerConfig): SceneConfig => ({
  ...scene,
  layers: scene.layers.map((l) => (l.id === id ? fn(l) : l)),
});

function uniqueId(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Add a layer with the effect's defaults on top of the stack. */
export function addLayer(scene: SceneConfig, effect: string): SceneConfig {
  const id = uniqueId(effect, scene.layers.map((l) => l.id));
  return { ...scene, layers: [...scene.layers, { id, effect, params: {} }] };
}

export function duplicateLayer(scene: SceneConfig, id: string): SceneConfig {
  const i = scene.layers.findIndex((l) => l.id === id);
  if (i < 0) return scene;
  const src = scene.layers[i]!;
  const copy: LayerConfig = { ...src, id: uniqueId(src.id.replace(/-\d+$/, ''), scene.layers.map((l) => l.id)), params: structuredClone(src.params ?? {}) };
  const layers = [...scene.layers];
  layers.splice(i + 1, 0, copy);
  return { ...scene, layers };
}

export function removeLayer(scene: SceneConfig, id: string): SceneConfig {
  return { ...scene, layers: scene.layers.filter((l) => l.id !== id) };
}

/** Move a layer up (+1, towards the top of the stack) or down (-1). */
export function moveLayer(scene: SceneConfig, id: string, delta: number): SceneConfig {
  const i = scene.layers.findIndex((l) => l.id === id);
  const j = Math.max(0, Math.min(scene.layers.length - 1, i + delta));
  if (i < 0 || i === j) return scene;
  const layers = [...scene.layers];
  const [layer] = layers.splice(i, 1);
  layers.splice(j, 0, layer!);
  return { ...scene, layers };
}

/** Patch a layer. Changing its effect keeps only the params the new effect understands. */
export function updateLayer(scene: SceneConfig, id: string, patch: Partial<Omit<LayerConfig, 'id'>>): SceneConfig {
  return mapLayer(scene, id, (l) => {
    const next = { ...l, ...patch };
    if (patch.effect && patch.effect !== l.effect) {
      const keys = new Set(EFFECTS[patch.effect]?.params.map((p) => p.key) ?? []);
      next.params = Object.fromEntries(Object.entries(l.params ?? {}).filter(([k]) => keys.has(k)));
    }
    return next;
  });
}

export function setParam(scene: SceneConfig, id: string, key: string, value: unknown): SceneConfig {
  return mapLayer(scene, id, (l) => ({ ...l, params: { ...(l.params ?? {}), [key]: value } }));
}

/** The parts of a layer a preset saves. */
export function lookOf(layer: LayerConfig): Look {
  const { id: _id, enabled: _enabled, ...look } = layer;
  return structuredClone(look);
}

/** Add a new layer on top with a saved look. */
export function addLayerFromLook(scene: SceneConfig, look: Look & { name?: string }): SceneConfig {
  const { name: _name, ...rest } = look;
  const id = uniqueId(rest.effect, scene.layers.map((l) => l.id));
  return { ...scene, layers: [...scene.layers, { ...structuredClone(rest), id }] };
}

/** Replace a layer's look with a saved one, keeping its id and visibility. */
export function applyLook(scene: SceneConfig, id: string, look: Look & { name?: string }): SceneConfig {
  const { name: _name, ...rest } = look;
  return mapLayer(scene, id, (l) => ({ ...structuredClone(rest), id: l.id, ...(l.enabled === false ? { enabled: false } : {}) }));
}
