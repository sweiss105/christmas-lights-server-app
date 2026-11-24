import { EFFECTS, resolveParams, type Params, type RenderFn } from './effects.js';
import type { Layout } from './layout.js';
import { decodePaint } from './paint.js';

/**
 * How a layer combines with the layers below it. The two mask modes don't add colour: they use the
 * layer's brightness to show ("mask") or hide ("mask-invert") what's below, so any effect can act as
 * a stencil, e.g. a white-on-black Ripple revealing a rainbow only inside its rings.
 */
export type BlendMode = 'normal' | 'add' | 'multiply' | 'screen' | 'max' | 'mask' | 'mask-invert';
export const BLEND_MODES: BlendMode[] = ['normal', 'add', 'multiply', 'screen', 'max', 'mask', 'mask-invert'];

export interface LayerConfig {
  id: string;
  effect: string;
  params?: Params;
  /** Group name to restrict the layer to; default "all". */
  group?: string;
  opacity?: number;
  blend?: BlendMode;
  /** For mask blend modes: mask everything below (default) or only the layer directly below ("clipping"). */
  maskScope?: MaskScope;
  /**
   * Painted on with the brush: the layer shows only on the lights painted, as strongly as each was
   * painted (see paint.ts for the format). Absent = the whole group, as usual.
   */
  paint?: string;
  enabled?: boolean;
}

export type MaskScope = 'below' | 'layer';
export const MASK_SCOPES: MaskScope[] = ['below', 'layer'];
const isMask = (b: BlendMode) => b === 'mask' || b === 'mask-invert';

export interface SceneConfig {
  name: string;
  /** Bottom layer first. */
  layers: LayerConfig[];
}

export interface OutputSettings {
  /** Master brightness 0..1, applied before gamma. */
  brightness: number;
  /** Output gamma; set to 1 if WLED is applying its own gamma to realtime data. */
  gamma: number;
}

interface CompiledLayer {
  render: RenderFn;
  mask: Uint8Array;
  /** Per-pixel weights for a feathered group, else null. */
  weight: Float32Array | null;
  opacity: number;
  blend: BlendMode;
  maskScope: MaskScope;
}

export function validateScene(scene: SceneConfig, layout: Layout): SceneConfig {
  if (typeof scene?.name !== 'string' || !Array.isArray(scene.layers)) throw new Error('scene needs name and layers[]');
  const ids = new Set<string>();
  return {
    name: scene.name,
    layers: scene.layers.map((l) => {
      if (typeof l.id !== 'string' || !l.id) throw new Error('layer needs an id');
      if (ids.has(l.id)) throw new Error(`duplicate layer id "${l.id}"`);
      ids.add(l.id);
      const def = EFFECTS[l.effect];
      if (!def) throw new Error(`layer "${l.id}": unknown effect "${l.effect}"`);
      const group = l.group ?? 'all';
      if (!layout.groups.has(group)) throw new Error(`layer "${l.id}": unknown group "${group}"`);
      const blend = l.blend ?? 'normal';
      if (!BLEND_MODES.includes(blend)) throw new Error(`layer "${l.id}": unknown blend "${blend}"`);
      const opacity = l.opacity ?? 1;
      if (typeof opacity !== 'number' || opacity < 0 || opacity > 1) throw new Error(`layer "${l.id}": opacity must be 0..1`);
      const maskScope = l.maskScope ?? 'below';
      if (!MASK_SCOPES.includes(maskScope)) throw new Error(`layer "${l.id}": unknown mask scope "${maskScope}"`);
      if (l.paint !== undefined) {
        try { decodePaint(l.paint, 0); } catch (e) { throw new Error(`layer "${l.id}": ${(e as Error).message}`); }
      }
      return { id: l.id, effect: l.effect, params: resolveParams(def, l.params), group, opacity, blend, ...(isMask(blend) && { maskScope }), ...(l.paint !== undefined && { paint: l.paint }), enabled: l.enabled ?? true };
    }),
  };
}

function blend(mode: BlendMode, a: number, b: number): number {
  switch (mode) {
    case 'normal': return b;
    case 'add': return Math.min(1, a + b);
    case 'multiply': return a * b;
    case 'screen': return 1 - (1 - a) * (1 - b);
    case 'max': return Math.max(a, b);
    default: return b; // mask modes are handled per pixel in composite()
  }
}

/** Composites layers into an 8-bit RGB frame in global pixel order. */
export class Engine {
  private layers: CompiledLayer[] = [];
  private acc: Float32Array;
  private tmp: Float32Array;
  /** Per-pixel opacity from a clipping mask. */
  private clipKeep: Float32Array;
  /** Crossfade in progress: the layers being faded out. `start` is set on the first frame after the change. */
  /** The running effect of each layer, by layer id, with the effect and settings it was made for. */
  private instances = new Map<string, { key: string; render: RenderFn }>();
  private fade: { from: CompiledLayer[]; duration: number; start: number | null; acc: Float32Array } | null = null;
  readonly frame: Uint8Array;
  private gammaLut = new Uint8Array(4096);
  private settings: OutputSettings = { brightness: 1, gamma: 2.2 };
  scene: SceneConfig = { name: 'Blackout', layers: [] };

  constructor(readonly layout: Layout) {
    this.acc = new Float32Array(layout.count * 3);
    this.tmp = new Float32Array(layout.count * 3);
    this.clipKeep = new Float32Array(layout.count);
    this.frame = new Uint8Array(layout.count * 3);
    this.setOutput({});
  }

  /** Switch scene. With `fade` (seconds) the old scene crossfades into the new one. */
  setScene(scene: SceneConfig, opts: { fade?: number } = {}): SceneConfig {
    const valid = validateScene(scene, this.layout);
    const fade = opts.fade ?? 0;
    // Fade from what's on screen now; if a fade is already running, from the scene it was heading to.
    this.fade = fade > 0 ? { from: this.layers, duration: fade, start: null, acc: this.fade?.acc ?? new Float32Array(this.layout.count * 3) } : null;
    // An edit that leaves a layer's effect and settings alone (a brush stroke, opacity, the lights it
    // covers) keeps that effect running rather than restarting it. Not during a crossfade: the old
    // stack is still rendering with its own instances.
    const kept = fade > 0 ? new Map<string, { key: string; render: RenderFn }>() : this.instances;
    this.instances = new Map();
    this.layers = valid.layers.filter((l) => l.enabled).map((l) => {
      const key = `${l.effect}\n${JSON.stringify(l.params)}`;
      const prev = kept.get(l.id);
      const render = prev?.key === key ? prev.render : EFFECTS[l.effect]!.create(l.params!, this.layout);
      this.instances.set(l.id, { key, render });
      return {
      render,
      ...this.coverage(l),
      opacity: l.opacity!,
      blend: l.blend!,
      maskScope: l.maskScope ?? 'below',
      };
    });
    this.scene = valid;
    return valid;
  }

  /** Which lights a layer touches and how strongly: its group, narrowed to where it's painted. */
  private coverage(l: LayerConfig): { mask: Uint8Array; weight: Float32Array | null } {
    const group = this.layout.groups.get(l.group!)!;
    const groupWeight = this.layout.groupWeights.get(l.group!) ?? null;
    if (l.paint === undefined) return { mask: group, weight: groupWeight };
    const paint = decodePaint(l.paint, this.layout.count);
    const mask = new Uint8Array(this.layout.count), weight = new Float32Array(this.layout.count);
    for (let i = 0; i < mask.length; i++) {
      if (!group[i] || !paint[i]) continue;
      mask[i] = 1;
      weight[i] = (paint[i]! / 255) * (groupWeight ? groupWeight[i]! : 1);
    }
    return { mask, weight };
  }

  get output(): OutputSettings { return { ...this.settings }; }

  setOutput(s: Partial<OutputSettings>): OutputSettings {
    const next = { ...this.settings, ...s };
    if (typeof next.brightness !== 'number' || !(next.brightness >= 0 && next.brightness <= 1)) throw new Error('brightness must be a number 0..1');
    if (typeof next.gamma !== 'number' || !(next.gamma >= 1 && next.gamma <= 3)) throw new Error('gamma must be a number 1..3');
    this.settings = next;
    for (let i = 0; i < 4096; i++) this.gammaLut[i] = Math.round(Math.pow((i / 4095) * next.brightness, next.gamma) * 255);
    return this.output;
  }

  /** Render the frame for time t (seconds). Returns the shared frame buffer. */
  /** Composite a layer stack into `acc` (linear 0..1). */
  private composite(layers: CompiledLayer[], t: number, acc: Float32Array): void {
    const tmp = this.tmp, n = this.layout.count;
    acc.fill(0);
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li]!;
      const { mask, opacity: o, blend: mode } = layer;
      // A clipping mask directly above this layer becomes this layer's per-pixel opacity.
      const clip = layers[li + 1];
      if (clip && isMask(clip.blend) && clip.maskScope === 'layer' && !isMask(mode)) {
        const keep = this.clipKeep;
        clip.render(t, tmp);
        const invert = clip.blend === 'mask-invert';
        for (let i = 0; i < n; i++) {
          if (!clip.mask[i]) { keep[i] = 1; continue; }
          const j = i * 3;
          const luma = 0.2126 * tmp[j]! + 0.7152 * tmp[j + 1]! + 0.0722 * tmp[j + 2]!;
          keep[i] = 1 + ((invert ? 1 - luma : luma) - 1) * clip.opacity * (clip.weight ? clip.weight[i]! : 1);
        }
        layer.render(t, tmp);
        for (let i = 0; i < n; i++) {
          if (!mask[i]) continue;
          const oi = o * keep[i]! * (layer.weight ? layer.weight[i]! : 1);
          for (let c = i * 3; c < i * 3 + 3; c++) {
            const a = acc[c]!;
            acc[c] = a + (blend(mode, a, tmp[c]!) - a) * oi;
          }
        }
        li++; // the clipping mask has been applied
        continue;
      }
      // A clipping mask with no ordinary layer directly below it has nothing to clip.
      if (isMask(mode) && layer.maskScope === 'layer') continue;
      layer.render(t, tmp);
      if (isMask(mode)) {
        const invert = mode === 'mask-invert';
        for (let i = 0; i < n; i++) {
          if (!mask[i]) continue;
          const j = i * 3;
          const luma = 0.2126 * tmp[j]! + 0.7152 * tmp[j + 1]! + 0.0722 * tmp[j + 2]!; // Rec. 709 brightness
          const keep = 1 + ((invert ? 1 - luma : luma) - 1) * o * (layer.weight ? layer.weight[i]! : 1); // opacity (and a feathered group) weakens the mask
          acc[j] = acc[j]! * keep; acc[j + 1] = acc[j + 1]! * keep; acc[j + 2] = acc[j + 2]! * keep;
        }
        continue;
      }
      const weight = layer.weight;
      for (let i = 0; i < n; i++) {
        if (!mask[i]) continue;
        const oi = weight ? o * weight[i]! : o;
        for (let c = i * 3; c < i * 3 + 3; c++) {
          const a = acc[c]!;
          acc[c] = a + (blend(mode, a, tmp[c]!) - a) * oi;
        }
      }
    }
  }

  render(t: number): Uint8Array {
    const acc = this.acc, n = this.layout.count, mapped = this.layout.mapped;
    this.composite(this.layers, t, acc);
    const fade = this.fade;
    if (fade) {
      if (fade.start === null) fade.start = t;
      const f = (t - fade.start) / fade.duration;
      if (f >= 1 || f < 0) this.fade = null;
      else {
        this.composite(fade.from, t, fade.acc);
        const from = fade.acc;
        for (let c = 0; c < n * 3; c++) acc[c] = from[c]! + (acc[c]! - from[c]!) * f;
      }
    }
    const lut = this.gammaLut, frame = this.frame;
    for (let i = 0; i < n; i++) {
      for (let c = i * 3; c < i * 3 + 3; c++) {
        const v = mapped[i] ? acc[c]! : 0;
        frame[c] = lut[Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 4095)]!;
      }
    }
    return frame;
  }
}
