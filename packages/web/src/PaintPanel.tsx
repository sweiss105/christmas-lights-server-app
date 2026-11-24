import { useMemo, useState } from 'react';
import { EFFECTS, paletteColors, resolveParams, type LayerConfig } from '@xmas/engine';
import { api } from './api';
import { lookOf, removeLayer, type Look, type SceneEditor } from './editor';
import { ParamControl, Slider, UndoIcon } from './EditorPanel';
import { LayerPicker } from './LayerPicker';
import { clearPaint, colorLook, isPainted, paintedCount, paintLayerFor, retunePaint, type Brush } from './paint';
import type { PaintTool } from './PaintOverlay';
import type { EditMode } from './useSceneEditor';
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
  editor: SceneEditor;
  paint: PaintState;
  mode: EditMode;
  onModeChange: (m: EditMode) => void;
  /** Back to editing the scene's layers. */
  onDone: () => void;
}

const TOOLS: [PaintTool, string, string][] = [['orbit', 'Move', 'Drag to turn the view'], ['paint', 'Paint', 'Drag over lights to paint them'], ['erase', 'Erase', 'Drag over lights to wipe paint off']];

/** Paint colours and effects onto the lights with a brush. What's painted is part of the scene. */
export function PaintPanel({ show, editor, paint, mode, onModeChange, onDone }: Props) {
  const scene = editor.scene;
  const [picking, setPicking] = useState(false);
  const { brush, look } = paint;
  const live = mode === 'live';
  const onStage = show.status?.stage.scene === scene.name;
  const painted = scene.layers.filter(isPainted).reverse();
  const current = look ? paintLayerFor(scene, look) : null;

  if (!scene.name) {
    return <aside className="editor glass paint-panel" aria-label="Paint on the lights"><p className="empty">Pick a scene to paint on.</p><div className="layer-actions"><button className="btn small" onClick={onDone}>Done</button></div></aside>;
  }

  const pickEffect = (lookIn: Look, name: string) => { paint.setEffect({ look: lookIn, name }); paint.setSource('effect'); paint.setTool('paint'); setPicking(false); };
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
  const setFxParam = (key: string, value: unknown, merge: boolean) => {
    if (!fx) return;
    const next: Look = { ...fx.look, params: { ...(fx.look.params ?? {}), [key]: value } };
    if (paintLayerFor(editor.scene, fx.look)) editor.edit(retunePaint(editor.scene, fx.look, next), merge ? { merge: `brush.${key}` } : {});
    paint.setEffect({ ...fx, look: next });
  };

  return (
    <aside className={`editor glass paint-panel ${live ? 'is-live' : ''}`} aria-label="Paint on the lights">
      <div className="editor-sticky">
        <div className="editor-head">
          <div className="editor-title">
            <span className="eyebrow">Painting on</span>
            <h2>{scene.name}</h2>
          </div>
          <div className="history">
            <button className="icon-btn" onClick={() => editor.undo()} disabled={!editor.canUndo} aria-label="Undo" title="Undo (⌘Z)"><UndoIcon /></button>
            <button className="icon-btn" onClick={() => editor.redo()} disabled={!editor.canRedo} aria-label="Redo" title="Redo (⇧⌘Z)"><UndoIcon flip /></button>
            <button className="btn small done-btn" onClick={onDone} title="Back to the scene's layers (Esc)">Done</button>
          </div>
        </div>
        <div className="mode-row">
          <div className="segmented mode" role="radiogroup" aria-label="Edit mode">
            <button role="radio" aria-checked={!live} className={!live ? 'active' : ''} onClick={() => onModeChange('blind')}>Blind</button>
            <button role="radio" aria-checked={live} className={live ? 'active live' : ''} onClick={() => onModeChange('live')}><span className="live-dot" aria-hidden /> Live</button>
          </div>
          <p className="mode-hint">
            {!live ? 'Painting is saved in the scene but stays off the porch until you press Go.'
              : onStage ? (show.status?.output.enabled ? 'Every stroke shows on the porch as you paint.' : 'Live, but streaming is off: the porch is on its WLED playlist.')
              : 'Live only affects the scene on stage. Press Go on this scene to paint on the porch.'}
          </p>
          <div className="segmented tools-seg" role="radiogroup" aria-label="Paint tool">
            {TOOLS.map(([t, label, hint]) => <button key={t} role="radio" aria-checked={paint.tool === t} className={paint.tool === t ? 'active' : ''} title={hint} onClick={() => paint.setTool(t)}>{label}</button>)}
          </div>
        </div>
      </div>

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
              onPickEffect={(id) => pickEffect({ effect: id, params: {} }, EFFECTS[id]?.name ?? id)}
              onPickPreset={({ name, ...lookIn }) => pickEffect(lookIn, name)}
              onDeletePreset={(name) => { api.deletePreset(name).then(show.refreshPresets).catch(show.reportError); }}
            />
          )}
          {!fx && !picking && <p className="empty">Choose an effect or a saved preset, then drag over the lights.</p>}
          {fx && fxDef?.params.map((p) => (
            <ParamControl key={`${fx.look.effect}.${p.key}`} spec={p} value={fxParams[p.key]} params={fxParams} onEnd={() => editor.endGesture()} onChange={(v, merge) => setFxParam(p.key, v, merge)} />
          ))}
        </>
      )}

      <div className="section-head"><h3>Brush</h3><span className="hint-inline">[ and ] change the size</span></div>
      <Slider label="Size" min={6} max={160} step={1} value={brush.size} format={(v) => `${Math.round(v)} px`} onChange={(v) => paint.setBrush({ ...brush, size: v })} onEnd={() => {}} />
      <Slider label="Soft edge" min={0} max={1} step={0.01} value={brush.softness} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => paint.setBrush({ ...brush, softness: v })} onEnd={() => {}} />
      <Slider label="Strength" min={0.05} max={1} step={0.01} value={brush.strength} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => paint.setBrush({ ...brush, strength: v })} onEnd={() => {}} />

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
      {painted.length > 0 && (
        <div className="layer-actions">
          <button className="btn small ghost danger-quiet" onClick={() => editor.edit(clearPaint(editor.scene))}>Clear all paint</button>
        </div>
      )}
      <p className="mode-hint paint-foot">Each paint is a layer of the scene: press Done to reorder it or fine-tune it with the other layers. Hold Option/Alt to erase.</p>
    </aside>
  );
}

const paintName = (l: LayerConfig): string => (l.effect === 'solid' && typeof l.params?.['color'] === 'string' ? (l.params['color'] as string).toUpperCase() : EFFECTS[l.effect]?.name ?? l.effect);

/** A chip showing a paint's colours. */
function layerSwatch(l: LayerConfig): string {
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
