import type { SceneConfig } from '@xmas/engine';
import { SceneEditor, uniqueName } from './editor';

const EMPTY: SceneConfig = { name: '', layers: [] };
const layersKey = (s: SceneConfig) => JSON.stringify(s.layers);

/**
 * The scene being edited, kept in this browser only. Edits (undo and redo included) change the
 * working copy; the stored scene on the server changes only when it's saved. `stored` is the version
 * it started from (or was last saved as); null means it has never been stored (New, Paint).
 */
export class WorkingCopy extends SceneEditor {
  private base: SceneConfig | null = null;

  constructor() { super(EMPTY); }

  /** The stored version this copy started from, or null for a scene that has never been stored. */
  get stored(): SceneConfig | null { return this.base; }
  get name(): string { return this.scene.name; }
  get open(): boolean { return this.scene.name !== ''; }
  get neverStored(): boolean { return this.open && this.base === null; }

  /** Differs from the stored scene (a never-stored scene is always unsaved). */
  get dirty(): boolean {
    if (!this.open) return false;
    return this.base === null || layersKey(this.scene) !== layersKey(this.base);
  }

  /** Leaving would lose something: unsaved edits, but not a new scene that's still blank. */
  get worthKeeping(): boolean {
    return this.dirty && !(this.base === null && this.scene.layers.length === 0);
  }

  /** Edit a stored scene. */
  load(stored: SceneConfig): void {
    this.base = structuredClone(stored);
    this.reset(structuredClone(stored));
  }

  /** Start a scene that isn't stored yet: no layers, so every light is off. */
  startNew(name: string): void {
    this.base = null;
    this.reset({ name, layers: [] });
  }

  /** Nothing open. */
  close(): void {
    this.base = null;
    this.reset(EMPTY);
  }

  /** Throw the edits away: back to the stored scene (or a blank one if it was never stored). */
  revert(): void {
    this.reset(this.base ? structuredClone(this.base) : { name: this.scene.name, layers: [] });
  }

  /** Rename the copy (and its stored version), keeping the edits and their undo history. */
  rename(name: string): void {
    if (this.base) this.base = { ...this.base, name };
    this.rewrite((s) => ({ ...s, name }));
  }

  /**
   * `scene` (this copy as it was sent, possibly under a new name) is now stored. Edits made while the
   * save was on its way stay unsaved.
   */
  markStored(scene: SceneConfig): void {
    if (scene.name !== this.scene.name) this.rewrite((s) => ({ ...s, name: scene.name }));
    this.base = structuredClone(scene);
    this.set(this.scene); // tell listeners: dirty may have changed
  }

  /**
   * The stored version changed elsewhere (another device, a restore). With no edits here, load it;
   * with edits, keep them (Save will store them over it). Returns true if it was loaded.
   */
  storedChanged(stored: SceneConfig): boolean {
    if (this.dirty) return false;
    if (this.base && layersKey(this.base) === layersKey(stored)) return false;
    this.load(stored);
    return true;
  }
}

/** A name for a new scene that no stored scene has. */
export const suggestName = (base: string, taken: string[]) => uniqueName(base, taken);

/** Why a name can't be used for a new scene, or null if it's fine. */
export function nameProblem(name: string, taken: string[]): string | null {
  const n = name.trim();
  if (!n) return 'Give the scene a name.';
  if (n.length > 80) return 'That name is too long (80 characters at most).';
  if (taken.includes(n)) return `There's already a scene called “${n}”.`;
  return null;
}
