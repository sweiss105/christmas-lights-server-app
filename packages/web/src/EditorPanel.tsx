import { cloneElement, useEffect, useId, useMemo, useState } from 'react';
import { BLEND_MODES, EFFECTS, buildLayout, resolveParams, type BlendMode, type LayerConfig, type ParamSpec } from '@xmas/engine';
import { addLayer, addLayerFromLook, applyLook, duplicateLayer, lookOf, moveLayer, removeLayer, setParam, setParams, updateLayer, type SceneEditor } from './editor';
import { api, type Preset } from './api';
import { LayerPicker } from './LayerPicker';
import { paintedCount } from './paint';
import { PaletteControl, type PalettePatch } from './PalettePicker';
import type { EditMode } from './useSceneEditor';
import type { Show } from './useShow';

interface Props {
  show: Show;
  editor: SceneEditor;
  mode: EditMode;
  onModeChange: (m: EditMode) => void;
  onRename: (newName: string) => Promise<boolean>;
}

/** Short names for the layer list. */
const BLEND_SHORT: Partial<Record<BlendMode, string>> = { mask: 'Mask', 'mask-invert': 'Inverted mask' };
const BLEND_LABELS: Record<BlendMode, string> = { normal: 'Normal', add: 'Add', multiply: 'Multiply', screen: 'Screen', max: 'Brightest', mask: 'Mask: show below where bright', 'mask-invert': 'Mask: hide below where bright' };

/** Right-hand panel: the selected scene's layers and the selected layer's settings. */
export function EditorPanel({ show, editor, mode, onModeChange, onRename }: Props) {
  const scene = editor.scene;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Keep a valid layer selected: the top layer by default.
  useEffect(() => {
    if (!scene.layers.some((l) => l.id === selectedId)) setSelectedId(scene.layers.at(-1)?.id ?? null);
  }, [scene, selectedId]);

  const layout = show.layout;
  const groups = useMemo(() => groupOptions(layout), [layout]);
  const layer = scene.layers.find((l) => l.id === selectedId) ?? null;
  const onStage = show.status?.stage.scene === scene.name;

  if (!scene.name) return <aside className="editor glass" aria-label="Scene editor"><p className="empty">Pick a scene to edit it.</p></aside>;

  const live = mode === 'live';
  return (
    <aside className={`editor glass ${live ? 'is-live' : ''}`} aria-label={`Editing ${scene.name}`}>
      <div className="editor-sticky">
      <div className="editor-head">
        <div className="editor-title">
          <span className="eyebrow">Editing</span>
          <SceneTitle name={scene.name} onRename={onRename} />
        </div>
        <div className="history">
          <button className="icon-btn" onClick={() => editor.undo()} disabled={!editor.canUndo} aria-label="Undo" title="Undo (⌘Z)"><UndoIcon /></button>
          <button className="icon-btn" onClick={() => editor.redo()} disabled={!editor.canRedo} aria-label="Redo" title="Redo (⇧⌘Z)"><UndoIcon flip /></button>
        </div>
      </div>

      <div className="mode-row">
        <div className="segmented mode" role="radiogroup" aria-label="Edit mode">
          <button role="radio" aria-checked={!live} className={!live ? 'active' : ''} onClick={() => onModeChange('blind')}>Blind</button>
          <button role="radio" aria-checked={live} className={live ? 'active live' : ''} onClick={() => onModeChange('live')}>
            <span className="live-dot" aria-hidden /> Live
          </button>
        </div>
        <p className="mode-hint">
          {!live ? 'Edits are saved but stay off the porch until you press Go.'
            : onStage ? (show.status?.output.enabled ? 'Every edit goes to the porch now.' : 'Live, but streaming is off: the porch is on its WLED playlist.')
            : 'Live only affects the scene on stage. This one isn’t on stage.'}
        </p>
      </div>
      </div>

      <div className="section-head">
        <h3>Layers</h3>
        <span className="hint-inline">top covers bottom</span>
      </div>
      <ul className="layer-list" aria-label="Layers, top first">
        {[...scene.layers].reverse().map((l, i, arr) => (
          <li key={l.id}>
            <div className={`layer-row ${l.id === selectedId ? 'selected' : ''} ${l.enabled === false ? 'hidden-layer' : ''}`}>
              <button
                className="eye"
                aria-pressed={l.enabled !== false}
                aria-label={l.enabled === false ? `Show ${l.id}` : `Hide ${l.id}`}
                onClick={() => editor.edit(updateLayer(scene, l.id, { enabled: l.enabled === false }))}
              >
                <EyeIcon off={l.enabled === false} />
              </button>
              <button className="layer-main" onClick={() => setSelectedId(l.id)} aria-current={l.id === selectedId}>
                <span className="layer-name">{EFFECTS[l.effect]?.name ?? l.effect}</span>
                <span className="layer-sub">{l.paint !== undefined ? `Painted${(l.group ?? 'all') === 'all' ? '' : ` in ${groupLabel(groups, l.group!)}`}` : groupLabel(groups, l.group ?? 'all')}{l.blend && l.blend !== 'normal' ? ` · ${BLEND_SHORT[l.blend] ?? BLEND_LABELS[l.blend]}${l.maskScope === 'layer' ? ' (layer below)' : ''}` : ''}{(l.opacity ?? 1) < 1 ? ` · ${Math.round((l.opacity ?? 1) * 100)}%` : ''}</span>
              </button>
              <div className="reorder">
                <button className="icon-btn small" disabled={i === 0} onClick={() => editor.edit(moveLayer(scene, l.id, +1))} aria-label={`Move ${l.id} up`}><Chevron up /></button>
                <button className="icon-btn small" disabled={i === arr.length - 1} onClick={() => editor.edit(moveLayer(scene, l.id, -1))} aria-label={`Move ${l.id} down`}><Chevron /></button>
              </div>
            </div>
          </li>
        ))}
        {scene.layers.length === 0 && <li className="empty">No layers: the porch is dark in this scene.</li>}
      </ul>

      <div className="layer-actions">
        <button className="btn small" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>+ Add layer</button>
        <button className="btn small ghost" disabled={!layer} onClick={() => layer && editor.edit(duplicateLayer(scene, layer.id))}>Duplicate</button>
        <button className="btn small ghost danger-quiet" disabled={!layer} onClick={() => layer && editor.edit(removeLayer(scene, layer.id))}>Delete</button>
      </div>
      {adding && (
        <LayerPicker
          presets={show.presets}
          onClose={() => setAdding(false)}
          onPickEffect={(id) => { const next = addLayer(scene, id); editor.edit(next); setSelectedId(next.layers.at(-1)!.id); setAdding(false); }}
          onPickPreset={(p) => { const next = addLayerFromLook(scene, p); editor.edit(next); setSelectedId(next.layers.at(-1)!.id); setAdding(false); }}
          onDeletePreset={(name) => { api.deletePreset(name).then(show.refreshPresets).catch(show.reportError); }}
        />
      )}

      {layer && <LayerInspector key={layer.id} show={show} editor={editor} layer={layer} groups={groups} />}
    </aside>
  );
}

// ---------------------------------------------------------------------------------------------

function LayerInspector({ show, editor, layer, groups }: { show: Show; editor: SceneEditor; layer: LayerConfig; groups: GroupOption[] }) {
  const def = EFFECTS[layer.effect];
  const params = def ? resolveParams(def, layer.params) : {};
  const id = layer.id;
  const scene = () => editor.scene; // always edit the latest working copy
  const end = () => editor.endGesture();

  return (
    <div className="inspector">
      <div className="section-head"><h3>Layer</h3></div>
      <PresetBar show={show} layer={layer} onApply={(p) => editor.edit(applyLook(scene(), id, p))} />
      <Field label="Effect">
        <select value={layer.effect} onChange={(e) => editor.edit(updateLayer(scene(), id, { effect: e.target.value }))}>
          {Object.values(EFFECTS).map((fx) => <option key={fx.id} value={fx.id}>{fx.name}</option>)}
        </select>
      </Field>
      {def && <p className="effect-desc inline">{def.description}</p>}
      <Field label="Lights">
        <select value={layer.group ?? 'all'} onChange={(e) => editor.edit(updateLayer(scene(), id, { group: e.target.value }))}>
          {groups.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
        </select>
      </Field>
      {layer.paint !== undefined && (
        <div className="field painted-note">
          <span className="field-label">Painted on {paintedCount(layer)} lights</span>
          <button className="btn small ghost" title="Drop the painting and show this layer on all its lights"
            onClick={() => { const { paint: _paint, ...rest } = layer; editor.edit({ ...scene(), layers: scene().layers.map((l) => (l.id === id ? rest : l)) }); }}>Fill all lights</button>
        </div>
      )}
      <Field label="Blend">
        <select value={layer.blend ?? 'normal'} onChange={(e) => editor.edit(updateLayer(scene(), id, { blend: e.target.value as BlendMode }))}>
          {BLEND_MODES.map((b) => <option key={b} value={b}>{BLEND_LABELS[b]}</option>)}
        </select>
      </Field>
      {(layer.blend === 'mask' || layer.blend === 'mask-invert') && (
        <div className="field">
          <span className="field-label">Masks</span>
          <div className="segmented" role="radiogroup" aria-label="What this mask applies to">
            {([['below', 'Everything below'], ['layer', 'Only the layer below']] as const).map(([v, label]) => (
              <button key={v} role="radio" aria-checked={(layer.maskScope ?? 'below') === v} className={(layer.maskScope ?? 'below') === v ? 'active' : ''}
                onClick={() => editor.edit(updateLayer(scene(), id, { maskScope: v }))}>{label}</button>
            ))}
          </div>
        </div>
      )}
      <Slider
        label="Opacity" min={0} max={1} step={0.01} value={layer.opacity ?? 1} format={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => editor.edit(updateLayer(scene(), id, { opacity: v }), { merge: `${id}.opacity` })} onEnd={end}
      />

      {def && def.params.length > 0 && <div className="section-head"><h3>{def.name} settings</h3></div>}
      {def?.params.filter((p) => !('when' in p && p.when) || String(params[p.when.key] ?? '').startsWith(p.when.startsWith)).map((p) => (
        <ParamControl key={p.key} spec={p} value={params[p.key]} params={params} onEnd={end} show={show}
          onChange={(v, merge) => editor.edit(setParam(scene(), id, p.key, v), merge ? { merge: `${id}.${p.key}` } : {})}
          onPatch={(patch, merge) => editor.edit(setParams(scene(), id, { ...patch }), merge ? { merge: `${id}.paletteStops` } : {})} />
      ))}
    </div>
  );
}

export function ParamControl({ spec, value, params, onChange, onEnd, show, onPatch }: {
  spec: ParamSpec; value: unknown; params?: Record<string, unknown>; onChange: (v: unknown, merge: boolean) => void; onEnd: () => void;
  /** For the palette: saved palettes, and setting the palette with its colours (params `palette` and `paletteStops`) in one step. */
  show?: Show; onPatch?: (p: PalettePatch, merge: boolean) => void;
}) {
  switch (spec.type) {
    case 'number':
      return <Slider label={spec.label} min={spec.min} max={spec.max} step={spec.step ?? 0.01} value={value as number}
        format={(v) => formatNumber(v, spec.step)} onChange={(v) => onChange(v, true)} onEnd={onEnd} />;
    case 'color':
      return (
        <Field label={spec.label}>
          <span className="color-field">
            <input type="color" value={value as string} onChange={(e) => onChange(e.target.value, true)} onBlur={onEnd} aria-label={spec.label} title={spec.label} />
            <span className="hex">{(value as string).toUpperCase()}</span>
          </span>
        </Field>
      );
    case 'select':
      return (
        <Field label={spec.label}>
          <select value={value as string} onChange={(e) => onChange(e.target.value, false)}>
            {spec.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
      );
    case 'text':
      return (
        <Field label={spec.label}>
          <input className="text" type="text" value={value as string} maxLength={spec.maxLength ?? 64} spellCheck={false}
            placeholder="Empty shows the time" onChange={(e) => onChange(e.target.value, true)} onBlur={onEnd} />
        </Field>
      );
    case 'boolean':
      return (
        <div className="field toggle-field">
          <button className={`switch ${value ? 'on' : ''}`} role="switch" aria-checked={!!value} onClick={() => onChange(!value, false)}>
            <span className="track" aria-hidden><span className="thumb" /></span>
            <span className="switch-label">{spec.label}</span>
          </button>
        </div>
      );
    case 'palette':
      return (
        <PaletteControl label={spec.label} value={value as string} params={params ?? {}} saved={show?.palettes ?? []} onEnd={onEnd}
          onPatch={(p, merge) => (onPatch ? onPatch(p, merge) : onChange(p.palette, merge))}
          onSavedChange={show?.refreshPalettes ?? (async () => {})} reportError={show?.reportError ?? (() => {})} />
      );
    case 'stops':
      return null; // edited with the palette
    case 'vec3':
      return spec.key === 'center'
        ? <PositionControl label={spec.label} value={value as number[]} onChange={onChange} onEnd={onEnd} />
        : <DirectionControl label={spec.label} value={value as number[]} onChange={(v) => onChange(v, false)} />;
  }
}

/** Direction as eight compass arrows (in the plane of the house front) plus "towards the street". */
const DIRECTIONS: { label: string; v: [number, number, number]; glyph: string }[] = [
  { label: 'Up and left', v: [-1, 1, 0], glyph: '↖' }, { label: 'Up', v: [0, 1, 0], glyph: '↑' }, { label: 'Up and right', v: [1, 1, 0], glyph: '↗' },
  { label: 'Left', v: [-1, 0, 0], glyph: '←' }, { label: 'Towards the street', v: [0, 0, 1], glyph: 'towards' }, { label: 'Right', v: [1, 0, 0], glyph: '→' },
  { label: 'Down and left', v: [-1, -1, 0], glyph: '↙' }, { label: 'Down', v: [0, -1, 0], glyph: '↓' }, { label: 'Down and right', v: [1, -1, 0], glyph: '↘' },
];
const norm = (v: number[]) => { const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1; return v.map((x) => x / l); };
const sameDir = (a: number[], b: number[]) => { const x = norm(a), y = norm(b); return x.every((c, i) => Math.abs(c - y[i]!) < 1e-3); };

function DirectionControl({ label, value, onChange }: { label: string; value: number[]; onChange: (v: number[]) => void }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="compass" role="radiogroup" aria-label={label}>
        {DIRECTIONS.map((d) => (
          <button key={d.label} role="radio" aria-checked={sameDir(value, d.v)} aria-label={d.label} title={d.label}
            className={sameDir(value, d.v) ? 'active' : ''} onClick={() => onChange(d.v)}>{d.glyph === 'towards' ? <TowardsIcon /> : d.glyph}</button>
        ))}
      </div>
    </div>
  );
}

function PositionControl({ label, value, onChange, onEnd }: { label: string; value: number[]; onChange: (v: unknown, merge: boolean) => void; onEnd: () => void }) {
  const axes = [{ i: 0, name: 'Across (left → right)' }, { i: 1, name: 'Height (ground → top)' }, { i: 2, name: 'Depth (house → street)' }];
  return (
    <div className="field-group" aria-label={label}>
      <span className="field-label">{label}</span>
      {axes.map(({ i, name }) => (
        <Slider key={i} label={name} min={0} max={1} step={0.01} value={value[i] ?? 0} format={(v) => v.toFixed(2)} compact
          onChange={(v) => { const next = [...value]; next[i] = v; onChange(next, true); }} onEnd={onEnd} />
      ))}
    </div>
  );
}

/** Save the selected layer's look as a preset, or apply a saved one to it. */
function PresetBar({ show, layer, onApply }: { show: Show; layer: LayerConfig; onApply: (p: Preset) => void }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const n = name.trim();
    if (!n) { setNaming(false); return; }
    if (show.presets.some((p) => p.name === n) && !window.confirm(`Replace the preset “${n}”?`)) return;
    setBusy(true);
    try { await api.savePreset(n, lookOf(layer)); await show.refreshPresets(); setNaming(false); setName(''); } catch (e) { show.reportError(e); }
    setBusy(false);
  };
  if (naming) {
    return (
      <div className="preset-bar">
        <input className="title-input small" autoFocus value={name} maxLength={80} placeholder="Preset name" aria-label="Preset name"
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setNaming(false); }} />
        <button className="btn small" disabled={busy || !name.trim()} onClick={() => void save()}>Save</button>
        <button className="btn small ghost" onClick={() => setNaming(false)}>Cancel</button>
      </div>
    );
  }
  return (
    <div className="preset-bar">
      <button className="btn small" onClick={() => { setName(EFFECTS[layer.effect]?.name ?? ''); setNaming(true); }}>Save as preset</button>
      {show.presets.length > 0 && (
        <select className="preset-apply" value="" aria-label="Apply a preset to this layer"
          onChange={(e) => { const p = show.presets.find((x) => x.name === e.target.value); if (p) onApply(p); }}>
          <option value="" disabled>Apply preset…</option>
          {show.presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
      )}
    </div>
  );
}

/** The scene name; tap it to rename. Enter saves, Escape cancels. */
function SceneTitle({ name, onRename }: { name: string; onRename: (n: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => { setDraft(name); setEditing(false); }, [name]);
  const commit = async () => {
    const n = draft.trim();
    if (!n || n === name) { setEditing(false); setDraft(name); return; }
    if (!(await onRename(n))) setDraft(name);
    setEditing(false);
  };
  if (!editing) return <h2><button className="title-btn" onClick={() => setEditing(true)} title="Rename">{name}</button></h2>;
  return (
    <input
      className="title-input" autoFocus value={draft} maxLength={60} aria-label="Scene name"
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') { setDraft(name); setEditing(false); } }}
    />
  );
}

// ---- small building blocks ----------------------------------------------------------------------

/** A labelled control. The label is tied to the control by id, so its accessible name is just the label. */
function Field({ label, children }: { label: string; children: React.ReactElement<{ id?: string }> }) {
  const id = useId();
  const child = children.type === 'span' ? children : cloneElement(children, { id });
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      {child}
    </div>
  );
}

export function Slider({ label, min, max, step, value, format, onChange, onEnd, compact }: {
  label: string; min: number; max: number; step: number; value: number; format: (v: number) => string;
  onChange: (v: number) => void; onEnd: () => void; compact?: boolean;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <label className={`field slider ${compact ? 'compact' : ''}`}>
      <span className="field-label" aria-hidden>{label}<span className="field-value">{format(value)}</span></span>
      <input
        type="range" min={min} max={max} step={step} value={value} aria-label={label} aria-valuetext={format(value)}
        style={{ ['--fill' as string]: `${pct}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onEnd} onPointerCancel={onEnd} onKeyUp={onEnd} onBlur={onEnd}
      />
    </label>
  );
}

const formatNumber = (v: number, step = 0.01) => (step >= 1 ? String(Math.round(v)) : v.toFixed(step >= 0.1 ? 1 : 2));

interface GroupOption { value: string; label: string }

function groupOptions(layout: Show['layout']): GroupOption[] {
  if (!layout) return [{ value: 'all', label: 'All lights' }];
  const names = [...buildLayout(layout).groups.keys()];
  const runName = new Map(layout.runs.map((r) => [`run:${r.id}`, r.name ?? r.id]));
  return names.map((n) => ({
    value: n,
    label: n === 'all' ? 'All lights' : runName.has(n) ? `Run: ${shortRunName(runName.get(n)!)}` : `Group: ${n}`,
  }));
}

/** "Porch railing left + left stair rail (GPIO16)" → "Porch railing left + left stair rail". */
const shortRunName = (s: string) => s.replace(/\s*\(GPIO\d+\)\s*$/, '');

function groupLabel(groups: GroupOption[], value: string) {
  return groups.find((g) => g.value === value)?.label ?? value;
}

// ---- icons (inline, so they follow the text colour) ---------------------------------------------

export function UndoIcon({ flip }: { flip?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M7 5 3 9l4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.5 9H12a5 5 0 0 1 0 10h-2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function EyeIcon({ off }: { off?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden>
      <path d="M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10Z" fill="none" stroke="currentColor" strokeWidth="1.6" />
      {off ? <path d="M3 17 17 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /> : <circle cx="10" cy="10" r="2.6" fill="currentColor" />}
    </svg>
  );
}

/** "Towards the viewer": a target, as drawn on plans for an arrow pointing out of the page. */
function TowardsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="9" cy="9" r="2.4" fill="currentColor" />
    </svg>
  );
}

function Chevron({ up }: { up?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden style={up ? { transform: 'rotate(180deg)' } : undefined}>
      <path d="M3 5.5 7 9.5l4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
