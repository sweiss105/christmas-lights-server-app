import { useMemo, useState } from 'react';
import { EFFECTS, paletteColors, resolveParams, type LayerConfig } from '@xmas/engine';
import { api } from './api';
import { confirmClear, lookOf, removeLayer, type Look } from './editor';
import { modeHint, ParamControl, Slider, UnsavedNote } from './EditorPanel';
import { PanelHead } from './PanelHead';
import { LayerPicker } from './LayerPicker';
import { clearPaint, colorLook, isPainted, isPatternColourParam, isPatternEffect, isPatternPaint, paintedCount, paintLayerFor, patternLook, retunePaint, type Brush } from './paint';
import type { PaintTool } from './PaintOverlay';
import type { EditMode } from './useSceneEditor';
import type { WorkingCopy } from './workingCopy';
import type { Show } from './useShow';

/** Ready-mixed colours: warm white first, then the Christmas ones. */
const SWATCHES = ['#ffb46b', '#ffffff', '#ff1a1a', '#00c040', '#ffc400', '#1e6bff', '#00d0ff', '#b44dff', '#ff4fa3', '#ff6a00'];

export interface PaintState {
  tool: PaintTool; setTool: (t: PaintTool) => void;
  brush: Brush; setBrush: (b: Brush) => void;
  source: 'color' | 'effect'; setSource: (s: 'color' | 'effect') => void;
  color: string; setColor: (c: string) => void;
  /** The effect brush: a layer look, plus the preset's name when it came from one. */
  effect: { look: Look; name: string } | null; setEffect: (e: { look: Look; name: string } | null) => void;
  /** What the brush paints with right now. */
  look: Look | null;
}

/** The brush, kept while the app is open so leaving Paint and coming back keeps it. */
export function usePaint(): PaintState {
  const [tool, setTool] = useState<PaintTool>('paint');
  const [brush, setBrush] = useState<Brush>({ size: 28, softness: 0.5, strength: 1 });
  const [source, setSource] = useState<'color' | 'effect'>('color');
  const [color, setColor] = useState(SWATCHES[2]!);
  const [effect, setEffect] = useState<PaintState['effect']>(null);
  const look = useMemo(() => (source === 'color' ? colorLook(color) : effect?.look ?? null), [source, color, effect]);
  return { tool, setTool, brush, setBrush, source, setSource, color, setColor, effect, setEffect, look };
}

interface Props {
  show: Show;
  editor: WorkingCopy;
  paint: PaintState;
  mode: EditMode;
  onHide?: () => void;
}

/** Paint colours and effects onto the lights with a brush. What's painted is part of the scene. */
export function PaintPanel({ show, editor, paint, mode, onHide }: Props) {
  const scene = editor.scene;
  const [picking, setPicking] = useState(false);
  const { look } = paint;
  const live = mode === 'live';
  const painted = scene.layers.filter(isPainted).reverse();
  const current = look ? paintLayerFor(scene, look) : null;

  if (!scene.name) {
    return <aside className="editor glass paint-panel" aria-label="Paint on the lights"><PanelHead title="Paint" onHide={onHide} /><p className="empty">Pick a scene to paint on.</p></aside>;
  }

  /** An effect (or a preset) picked for the Brush paints as a pattern over the colours below. */
  const pickEffect = (lookIn: Look, name: string) => { paint.setEffect({ look: patternLook(lookIn), name }); paint.setSource('effect'); paint.setTool('paint'); setPicking(false); };
  /** Carry on with a paint that's already in the scene. */
  const pickUp = (l: LayerConfig) => {
    const lk = lookOf(l);
    const plainColor = l.effect === 'solid' && Object.keys(lk).every((k) => k === 'effect' || k === 'params' || (k === 'group' && lk.group === 'all') || (k === 'opacity' && lk.opacity === 1) || (k === 'blend' && lk.blend === 'normal'));
    if (plainColor && typeof l.params?.['color'] === 'string') { paint.setColor(l.params['color'] as string); paint.setSource('color'); }
    else { paint.setEffect({ look: lk, name: EFFECTS[l.effect]?.name ?? l.effect }); paint.setSource('effect'); }
    paint.setTool('paint');
  };

  const fx = paint.effect;
  const fxDef = fx ? EFFECTS[fx.look.effect] : undefined;
  const fxParams = fx && fxDef ? resolveParams(fxDef, fx.look.params) : {};
  /** Tuning the effect brush also retunes what it has already painted. */
  /** Set brush-effect params (`undefined` removes one); `key` names the gesture for merging undo steps. */
  const setFxParams = (patch: Record<string, unknown>, merge: boolean, key: string) => {
    if (!fx) return;
    const params: Record<string, unknown> = { ...(fx.look.params ?? {}), ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete params[k];
    const next: Look = { ...fx.look, params };
    if (paintLayerFor(editor.scene, fx.look)) editor.edit(retunePaint(editor.scene, fx.look, next), merge ? { merge: `brush.${key}` } : {});
    paint.setEffect({ ...fx, look: next });
  };

  return (
    <aside className={`editor glass paint-panel ${live ? 'is-live' : ''}`} aria-label="Paint on the lights">
      <PanelHead eyebrow={<>{paint.tool === 'erase' ? 'Eraser' : 'Brush'} · {editor.neverStored ? 'new painting' : 'painting on'}<UnsavedNote editor={editor} /></>}
        title={<h2>{scene.name}{editor.dirty && <span className="unsaved-dot" role="img" aria-label="Unsaved changes" title="Unsaved changes" />}</h2>} onHide={onHide}>
        <div className="mode-row">
          {editor.neverStored && <p className="canvas-note">A blank canvas: paint, then Save as new.</p>}
          <p className="mode-hint">{modeHint(show, editor, live, 'paint')}</p>
        </div>
      </PanelHead>

      <div className="section-head"><h3>Paint with</h3></div>
      <div className="mode-row">
        <div className="segmented tools-seg" role="radiogroup" aria-label="Paint with">
          <button role="radio" aria-checked={paint.source === 'color'} className={paint.source === 'color' ? 'active' : ''} onClick={() => { paint.setSource('color'); if (paint.tool === 'erase') paint.setTool('paint'); }}>Colour</button>
          <button role="radio" aria-checked={paint.source === 'effect'} className={paint.source === 'effect' ? 'active' : ''} onClick={() => { paint.setSource('effect'); if (paint.tool === 'erase') paint.setTool('paint'); if (!paint.effect) setPicking(true); }}>Effect</button>
        </div>
      </div>

      {paint.source === 'color' && (
        <div className="paint-colors">
          <div className="swatch-row" role="radiogroup" aria-label="Colour">
            {SWATCHES.map((c) => (
              <button key={c} role="radio" aria-checked={paint.color.toLowerCase() === c} aria-label={c} className={`paint-swatch ${paint.color.toLowerCase() === c ? 'active' : ''}`} style={{ background: c }}
                onClick={() => { paint.setColor(c); if (paint.tool !== 'paint') paint.setTool('paint'); }} />
            ))}
          </div>
          <div className="field">
            <span className="field-label">Any colour</span>
            <span className="color-field">
              <input type="color" value={paint.color} aria-label="Any colour" onChange={(e) => paint.setColor(e.target.value)} />
              <span className="hex">{paint.color.toUpperCase()}</span>
            </span>
          </div>
        </div>
      )}

      {paint.source === 'effect' && (
        <>
          <div className="layer-actions">
            <button className="btn small" aria-expanded={picking} onClick={() => setPicking((p) => !p)}>{fx ? 'Change effect' : 'Choose an effect'}</button>
            {fx && <span className="paint-fx-name">{fx.name}</span>}
          </div>
          {picking && (
            <LayerPicker
              presets={show.presets}
              onClose={() => setPicking(false)}
              only={isPatternEffect}
              onPickEffect={(id) => pickEffect({ effect: id, params: {} }, EFFECTS[id]?.name ?? id)}
              onPickPreset={({ name, ...lookIn }) => pickEffect(lookIn, name)}
              onDeletePreset={(name) => { api.deletePreset(name).then(show.refreshPresets).catch(show.reportError); }}
            />
          )}
          <p className="mode-hint paint-pattern-note">Effects paint as a pattern, not a colour: the lights you’ve already coloured twinkle, chase or ripple in their own colours. Paint colours first, then the effect over them.</p>
          {!fx && !picking && <p className="empty">Choose an effect or a saved preset, then drag over the lights.</p>}
          {fx && fxDef?.params.filter((p) => fx.look.blend !== 'mask' || !isPatternColourParam(p)).map((p) => (
            <ParamControl key={`${fx.look.effect}.${p.key}`} spec={p} value={fxParams[p.key]} params={fxParams} onEnd={() => editor.endGesture()} show={show}
              onChange={(v, merge) => setFxParams({ [p.key]: v }, merge, p.key)} onPatch={(patch, merge) => setFxParams({ ...patch }, merge, 'paletteStops')} />
          ))}
        </>
      )}

      <div className="section-head"><h3>Painted in this scene</h3><span className="hint-inline">newest strokes on top</span></div>
      <ul className="group-list paint-list">
        {painted.map((l) => (
          <li key={l.id} className={`group-item ${current?.id === l.id && paint.tool === 'paint' ? 'current' : ''}`}>
            <div className="group-top">
              <span className="swatch" style={{ background: layerSwatch(l) }} aria-hidden />
              <button className="group-name" title="Paint more of this" onClick={() => pickUp(l)}>{paintName(l)}</button>
              <span className="muted">{paintedCount(l)} lights</span>
              <button className="icon-btn small" aria-label={`Remove the ${paintName(l)} paint`} onClick={() => editor.edit(removeLayer(editor.scene, l.id))}>×</button>
            </div>
          </li>
        ))}
        {painted.length === 0 && <li className="empty">Nothing painted yet. Drag over the lights in the view.</li>}
      </ul>
      <p className="mode-hint paint-foot">Painting starts from a blank scene with every light off. When you like it, Save as new… stores it as a scene. Each paint is a layer: pick the Move tool (V) to reorder it or fine-tune it with the other layers. The brush’s size and softness are in its pop-out by the Brush tool.</p>
    </aside>
  );
}

/** The Brush's settings (its pop-out from the rail): size, soft edge and strength. */
export function BrushTools({ paint }: { paint: PaintState }) {
  const { brush } = paint;
  return (
    <div className="brush-tools">
      <Slider label="Size" min={6} max={160} step={1} value={brush.size} format={(v) => `${Math.round(v)} px`} onChange={(v) => paint.setBrush({ ...brush, size: v })} onEnd={() => {}} />
      <Slider label="Soft edge" min={0} max={1} step={0.01} value={brush.softness} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => paint.setBrush({ ...brush, softness: v })} onEnd={() => {}} />
      <Slider label="Strength" min={0.05} max={1} step={0.01} value={brush.strength} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => paint.setBrush({ ...brush, strength: v })} onEnd={() => {}} />
      <p className="mode-hint">[ and ] change the size. Hold Option/Alt to erase.</p>
    </div>
  );
}

/** The Eraser's settings (its pop-out from the rail): size, soft edge, and clearing the whole painting. */
export function EraserTools({ paint, editor, mode }: { paint: PaintState; editor: WorkingCopy; mode: EditMode }) {
  const { brush } = paint;
  const painted = editor.scene.layers.some(isPainted);
  return (
    <div className="brush-tools">
      <Slider label="Size" min={6} max={160} step={1} value={brush.size} format={(v) => `${Math.round(v)} px`} onChange={(v) => paint.setBrush({ ...brush, size: v })} onEnd={() => {}} />
      <Slider label="Soft edge" min={0} max={1} step={0.01} value={brush.softness} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => paint.setBrush({ ...brush, softness: v })} onEnd={() => {}} />
      <p className="mode-hint">[ and ] change the size.</p>
      <div className="layer-actions">
        <button className="btn small ghost danger-quiet" disabled={!painted} title="Remove everything painted (the scene's other layers stay; Undo brings the paint back)"
          onClick={() => { if (confirmClear(editor.scene.name, mode === 'live', 'painting')) editor.edit(clearPaint(editor.scene)); }}>Clear painting</button>
      </div>
    </div>
  );
}

const paintName = (l: LayerConfig): string => (l.effect === 'solid' && typeof l.params?.['color'] === 'string' ? (l.params['color'] as string).toUpperCase() : `${EFFECTS[l.effect]?.name ?? l.effect}${isPatternPaint(l) ? ' pattern' : ''}`);

/** A chip showing a paint's colours. */
function layerSwatch(l: LayerConfig): string {
  if (isPatternPaint(l)) return 'repeating-linear-gradient(90deg, #f4f6fb 0 5px, #2a3142 5px 10px)';
  const def = EFFECTS[l.effect];
  let params: Record<string, unknown> = l.params ?? {};
  try { if (def) params = resolveParams(def, l.params); } catch { /* show what we can */ }
  const colors: string[] = [];
  for (const k of ['color', 'colorA', 'colorB']) { const v = params[k]; if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) colors.push(v); }
  const pal = def?.params.find((p) => p.type === 'palette');
  if (pal && typeof params[pal.key] === 'string') colors.push(...paletteColors(params[pal.key] as string, params, 5));
  if (l.effect === 'rainbow') colors.push('#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2');
  return colors.length === 0 ? '#2a3142' : colors.length === 1 ? colors[0]! : `linear-gradient(90deg, ${colors.slice(0, 6).join(', ')})`;
}
