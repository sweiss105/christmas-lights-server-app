import { decodePaint, EFFECTS, encodePaint, resolveParams, type LayerConfig, type SceneConfig } from '@xmas/engine';
import { uniqueId, type Look } from './editor';

/**
 * Painting on the lights: pure functions. A stroke is how strongly the brush touched each light
 * (0..1 per global pixel index, from the lights' positions on screen). Applying a stroke to a scene
 * puts it on a painted layer with the brush's look.
 */
export interface Brush {
  /** Radius in screen pixels. */
  size: number;
  /** 0 = hard edge, 1 = fades all the way from the centre. */
  softness: number;
  /** How much one stroke covers, 0..1. */
  strength: number;
}

/** Paint wiped down below this (about 2%) is gone: it can't be seen, and would keep an empty-looking layer alive. */
const FAINT = 6;

export type PaintTarget = { kind: 'look'; look: Look } | { kind: 'erase' };

/** One touch of the brush at (cx, cy): raises `stroke` where the brush reaches, never lowers it. */
export function dab(screen: Float32Array, cx: number, cy: number, brush: Brush, stroke: Float32Array): void {
  const r = brush.size, core = r * (1 - brush.softness);
  for (let i = 0; i < stroke.length; i++) {
    const x = screen[i * 2]!, y = screen[i * 2 + 1]!;
    if (Number.isNaN(x)) continue;
    const dx = x - cx, dy = y - cy;
    if (dx > r || dx < -r || dy > r || dy < -r) continue;
    const d = Math.hypot(dx, dy);
    if (d > r) continue;
    const w = brush.strength * (d <= core ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (d - core)) / (r - core)));
    if (w > stroke[i]!) stroke[i] = w;
  }
}

/** Touches along the line from a to b, close enough together that a fast drag leaves no gaps. */
export function dabLine(screen: Float32Array, a: [number, number], b: [number, number], brush: Brush, stroke: Float32Array): void {
  const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const steps = Math.max(1, Math.ceil(dist / Math.max(2, brush.size / 3)));
  for (let s = 1; s <= steps; s++) dab(screen, a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps, brush, stroke);
}

export const isPainted = (l: LayerConfig): boolean => l.paint !== undefined;

/** How many lights a painted layer covers. */
export function paintedCount(l: LayerConfig): number {
  if (l.paint === undefined) return 0;
  let n = 0;
  for (const w of decodePaint(l.paint)) if (w) n++;
  return n;
}

const lookKey = (l: Look): string => {
  const def = EFFECTS[l.effect];
  let params: unknown = l.params ?? {};
  try { if (def) params = resolveParams(def, l.params); } catch { /* compare as given */ }
  return JSON.stringify([l.effect, params, l.group ?? 'all', l.blend ?? 'normal', l.opacity ?? 1, l.maskScope ?? 'below']);
};

/** Two looks that would render the same (defaults filled in). */
export const sameLook = (a: Look, b: Look): boolean => lookKey(a) === lookKey(b);

/** A brush that paints one colour. */
export const colorLook = (color: string): Look => ({ effect: 'solid', params: { color } });

/** The painted layer a brush with this look adds to: the topmost one that looks the same. */
export function paintLayerFor(scene: SceneConfig, look: Look): LayerConfig | null {
  for (let i = scene.layers.length - 1; i >= 0; i--) {
    const l = scene.layers[i]!;
    if (isPainted(l) && sameLook(l, look)) return l;
  }
  return null;
}

/**
 * Put a stroke on the scene as it was when the stroke began.
 *
 * Painting adds to the painted layer with the brush's look (a new one on top if there is none) and
 * wipes the same lights on painted layers above it, so the newest stroke is always the one you see.
 * Erasing wipes every painted layer. Layers that aren't painted are never touched; a painted layer
 * left with no paint is removed.
 */
export function applyStroke(scene: SceneConfig, target: PaintTarget, stroke: Float32Array): SceneConfig {
  let touched = false;
  for (let i = 0; i < stroke.length; i++) if (stroke[i]! > 0) { touched = true; break; }
  if (!touched) return scene;

  const wipe = (paint: string): string => {
    const w = decodePaint(paint, stroke.length);
    for (let i = 0; i < w.length; i++) {
      if (!(stroke[i]! > 0)) continue;
      const v = Math.round(w[i]! * (1 - stroke[i]!));
      w[i] = v < FAINT ? 0 : v; // don't leave traces too faint to see
    }
    return encodePaint(w);
  };
  const add = (paint: string): string => {
    const w = decodePaint(paint, stroke.length);
    for (let i = 0; i < w.length; i++) if (stroke[i]! > 0) w[i] = Math.round(w[i]! + (255 - w[i]!) * stroke[i]!);
    return encodePaint(w);
  };

  let layers: LayerConfig[];
  if (target.kind === 'erase') {
    layers = scene.layers.map((l) => (isPainted(l) ? { ...l, paint: wipe(l.paint!) } : l));
  } else {
    const mine = paintLayerFor(scene, target.look);
    const at = mine ? scene.layers.indexOf(mine) : scene.layers.length;
    layers = scene.layers.map((l, i) => (!isPainted(l) ? l : i === at ? { ...l, paint: add(l.paint!) } : i > at ? { ...l, paint: wipe(l.paint!) } : l));
    if (!mine) layers.push({ ...structuredClone(target.look), id: uniqueId('paint', scene.layers.map((l) => l.id)), paint: add('') });
  }
  return { ...scene, layers: layers.filter((l) => l.paint !== '') };
}

/** Remove every painted layer. */
export function clearPaint(scene: SceneConfig): SceneConfig {
  return { ...scene, layers: scene.layers.filter((l) => !isPainted(l)) };
}

/** Change the settings of the painted layers that have `from`'s look to `to`'s, so tuning a brush retunes its paint. */
export function retunePaint(scene: SceneConfig, from: Look, to: Look): SceneConfig {
  return { ...scene, layers: scene.layers.map((l) => (isPainted(l) && sameLook(l, from) ? { ...l, params: structuredClone(to.params ?? {}) } : l)) };
}
