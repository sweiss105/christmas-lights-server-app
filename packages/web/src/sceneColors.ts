import { buildLayout, Engine, type Layout, type LayoutConfig, type SceneConfig } from '@xmas/engine';

/**
 * The colours a scene actually puts on the lights, for its swatch: the scene is run on the real
 * layout for a few moments (as the porch would show it, without gamma) and the lights' colours are
 * gathered into a few main ones, most used first. Reading params instead misses most WLED effects,
 * which draw from palettes and their own colour slots.
 */

/** Moments sampled, in seconds: spread out so chases and slow fades show their colours. */
const TIMES = [0.5, 1.5, 3, 4.5, 6.5, 8.5, 11, 14];
/** Lights dimmer than this (0..255) are left out: dark gaps aren't a colour. */
const DARK = 40;
/** A colour must cover at least this share of what's lit to be shown. */
const MIN_SHARE = 0.06;

const layouts = new WeakMap<LayoutConfig, Layout | null>();
const cache = new Map<string, string[]>();
let cacheFor: Layout | null = null;

function layoutOf(config: LayoutConfig): Layout | null {
  if (!layouts.has(config)) {
    try { layouts.set(config, buildLayout(config)); } catch { layouts.set(config, null); }
  }
  return layouts.get(config)!;
}

/** Up to `max` main colours of the scene as #rrggbb, most used first; [] for an empty or dark scene, null if it can't run. */
export function sceneColors(scene: SceneConfig, config: LayoutConfig, max = 5): string[] | null {
  const layout = layoutOf(config);
  if (!layout) return null;
  if (cacheFor !== layout) { cache.clear(); cacheFor = layout; }
  const key = JSON.stringify(scene.layers);
  const hit = cache.get(key);
  if (hit) return hit.slice(0, max);
  let colors: string[];
  try { colors = measure(scene, layout); } catch { return null; }
  if (cache.size > 300) cache.clear();
  cache.set(key, colors);
  return colors.slice(0, max);
}

function measure(scene: SceneConfig, layout: Layout): string[] {
  const engine = new Engine(layout);
  engine.setOutput({ brightness: 1, gamma: 1 });
  engine.setScene(scene);
  // Buckets by hue (24 steps) for colours, by warmth (3 steps) for whites; each sums its lights' colour, weighted by brightness.
  const buckets = new Map<string, { w: number; r: number; g: number; b: number }>();
  let total = 0;
  for (const t of TIMES) {
    const frame = engine.render(t);
    for (let i = 0; i < layout.count; i++) {
      const r = frame[i * 3]!, g = frame[i * 3 + 1]!, b = frame[i * 3 + 2]!;
      const m = Math.max(r, g, b);
      if (m < DARK) continue;
      const mn = Math.min(r, g, b), sat = 1 - mn / m;
      let key: string;
      if (sat < 0.25) key = `w${r - b > 25 ? 'warm' : b - r > 25 ? 'cool' : 'n'}`;
      else {
        const d = m - mn;
        const h = m === r ? ((g - b) / d + 6) % 6 : m === g ? (b - r) / d + 2 : (r - g) / d + 4; // 0..6
        key = `h${Math.floor((h / 6) * 24) % 24}`;
      }
      const w = m / 255;
      const s = buckets.get(key) ?? { w: 0, r: 0, g: 0, b: 0 };
      // Colour at full brightness, so a dim red and a bright red count as the same red.
      s.w += w; s.r += (r / m) * w; s.g += (g / m) * w; s.b += (b / m) * w;
      buckets.set(key, s);
      total += w;
    }
  }
  if (total === 0) return [];
  // Most used first; a shade close to one already kept joins it rather than showing twice.
  const kept: { w: number; r: number; g: number; b: number }[] = [];
  for (const s of [...buckets.values()].sort((a, b) => b.w - a.w)) {
    const c = [s.r / s.w, s.g / s.w, s.b / s.w];
    const near = kept.find((k) => Math.hypot(k.r / k.w - c[0]!, k.g / k.w - c[1]!, k.b / k.w - c[2]!) < 0.25);
    if (near) { near.w += s.w; near.r += s.r; near.g += s.g; near.b += s.b; } else kept.push({ ...s });
  }
  const hex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return kept
    .filter((s) => s.w / total >= MIN_SHARE)
    .sort((a, b) => b.w - a.w)
    .map((s) => `#${hex(s.r / s.w)}${hex(s.g / s.w)}${hex(s.b / s.w)}`);
}

// ---- measuring in the background ---------------------------------------------------------------

/**
 * Measuring a scene takes tens of milliseconds, so a list of scenes is measured one at a time in idle
 * moments rather than while the list draws. Each swatch shows its colours once they're ready.
 */
const queue = new Map<string, { scene: SceneConfig; config: LayoutConfig }>();
const listeners = new Set<() => void>();
let scheduled = false;

/** The scene's colours if already measured (`undefined` while queued), queuing it otherwise. */
export function sceneColorsSoon(scene: SceneConfig, config: LayoutConfig): string[] | null | undefined {
  const layout = layoutOf(config);
  if (!layout) return null;
  if (cacheFor === layout) {
    const hit = cache.get(JSON.stringify(scene.layers));
    if (hit) return hit.slice(0, 5);
  }
  queue.set(JSON.stringify(scene.layers), { scene, config });
  schedule();
  return undefined;
}

/** Call `fn` whenever more scenes have been measured; returns the unsubscribe. */
export function onSceneColors(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const idle = (fn: () => void) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 500 }); else setTimeout(fn, 16);
};

function schedule() {
  if (scheduled) return;
  scheduled = true;
  idle(() => {
    scheduled = false;
    const next = queue.entries().next();
    if (next.done) return;
    const [key, { scene, config }] = next.value;
    queue.delete(key);
    if (sceneColors(scene, config) === null && layoutOf(config)) cache.set(key, []); // can't run: show the fallback, don't retry
    for (const fn of listeners) fn();
    if (queue.size) schedule();
  });
}
