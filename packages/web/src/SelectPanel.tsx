import { useMemo, useState } from 'react';
import { buildLayout, type LayoutConfig } from '@xmas/engine';
import { api } from './api';
import { aboveHeight, combine, endsOfRuns, everyNth, invert, selectAll, sideOf, type SelectMode, type Selection } from './selection';
import type { SelectTool } from './SelectionOverlay';
import type { Show } from './useShow';

interface Props {
  show: Show;
  selection: Selection;
  onSelection: (s: Selection) => void;
  tool: SelectTool;
  onTool: (t: SelectTool) => void;
  mode: SelectMode;
  onMode: (m: SelectMode) => void;
  brushSize: number;
  onBrushSize: (n: number) => void;
}

const TOOLS: [SelectTool, string, string][] = [
  ['orbit', 'Move', 'Drag to turn the view'], ['box', 'Box', 'Drag a rectangle'], ['lasso', 'Lasso', 'Draw around lights'], ['brush', 'Brush', 'Paint over lights'],
];
const MODES: [SelectMode, string][] = [['replace', 'New'], ['add', 'Add'], ['subtract', 'Remove']];

/** Select lights with box, lasso, brush or rules, and save selections as (optionally soft-edged) groups. */
export function SelectPanel({ show, selection, onSelection, tool, onTool, mode, onMode, brushSize, onBrushSize }: Props) {
  const config = show.layout!;
  const layout = useMemo(() => buildLayout(config), [config]);
  const [nth, setNth] = useState(3);
  const [ends, setEnds] = useState(20);
  const [height, setHeight] = useState(1);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const apply = (picked: Selection) => onSelection(combine(selection, picked, mode));

  // Saved groups (excluding the run:… and "all" groups the engine makes itself).
  const groups = Object.entries(config.groups ?? {});
  const saveGroups = async (next: LayoutConfig['groups']) => {
    setBusy(true);
    try { await api.saveLayout({ ...config, groups: next }); await show.refresh(); } catch (e) { show.reportError(e); }
    setBusy(false);
  };
  /** Delete a group: first point every layer using it at all lights (Blind saves), so no scene breaks. */
  const deleteGroup = async (g: string) => {
    setBusy(true);
    try {
      for (const sc of show.scenes) {
        if (!sc.layers.some((l) => l.group === g)) continue;
        await api.saveScene({ ...sc, layers: sc.layers.map((l) => (l.group === g ? { ...l, group: 'all' } : l)) }, false);
      }
      const { [g]: _gone, ...rest } = config.groups ?? {};
      await api.saveLayout({ ...config, groups: rest });
      await show.refresh();
    } catch (e) { show.reportError(e); }
    setBusy(false);
  };
  const members = (g: string) => { const m = layout.groups.get(g); const s = new Set<number>(); if (m) m.forEach((v, i) => { if (v && !(layout.groupWeights.get(g)?.[i]! < 1)) s.add(i); }); return s; };
  const sorted = () => [...selection].sort((a, b) => a - b);

  return (
    <aside className="editor glass select-panel" aria-label="Select lights">
      <div className="editor-sticky">
        <div className="editor-head">
          <div className="editor-title">
            <span className="eyebrow">Select lights</span>
            <h2>{selection.size} selected</h2>
          </div>
        </div>
        <div className="mode-row">
          <div className="segmented tools-seg" role="radiogroup" aria-label="Selection tool">
            {TOOLS.map(([t, label, hint]) => <button key={t} role="radio" aria-checked={tool === t} className={tool === t ? 'active' : ''} title={hint} onClick={() => onTool(t)}>{label}</button>)}
          </div>
          <div className="segmented tools-seg" role="radiogroup" aria-label="Selection mode" style={{ marginTop: 6 }}>
            {MODES.map(([m, label]) => <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'active' : ''} onClick={() => onMode(m)}>{label}</button>)}
          </div>
          <p className="mode-hint">{tool === 'orbit' ? 'Pick Box, Lasso or Brush to select; Move turns the view.' : 'Shift adds, Option/Alt removes, whatever the mode.'}</p>
        </div>
      </div>

      {tool === 'brush' && (
        <label className="field slider">
          <span className="field-label" aria-hidden>Brush size<span className="field-value">{brushSize}px</span></span>
          <input type="range" min={6} max={120} step={1} value={brushSize} aria-label="Brush size" style={{ ['--fill' as string]: `${((brushSize - 6) / 114) * 100}%` }} onChange={(e) => onBrushSize(Number(e.target.value))} />
        </label>
      )}

      <div className="layer-actions">
        <button className="btn small" onClick={() => onSelection(selectAll(layout))}>All</button>
        <button className="btn small ghost" onClick={() => onSelection(new Set())}>None</button>
        <button className="btn small ghost" onClick={() => onSelection(invert(layout, selection))}>Invert</button>
      </div>

      <div className="section-head"><h3>Rules</h3><span className="hint-inline">{MODES.find(([m]) => m === mode)![1]} selection</span></div>
      <div className="rule-row">
        <span>Every</span><input className="num" type="number" min={2} value={nth} onChange={(e) => setNth(Math.max(2, Number(e.target.value)))} aria-label="Every Nth light" /><span>th of the selection</span>
        <button className="btn small" disabled={!selection.size} onClick={() => onSelection(everyNth(layout, selection, nth))}>Apply</button>
      </div>
      <div className="rule-row">
        <input className="num" type="number" min={1} value={ends} onChange={(e) => setEnds(Math.max(1, Number(e.target.value)))} aria-label="Number of lights" /><span>lights at the</span>
        <button className="btn small ghost" onClick={() => apply(endsOfRuns(layout, ends, 'first'))}>Start</button>
        <button className="btn small ghost" onClick={() => apply(endsOfRuns(layout, ends, 'last'))}>End</button>
      </div>
      <div className="rule-row">
        <span>Height</span><input className="num" type="number" step={0.1} value={height} onChange={(e) => setHeight(Number(e.target.value))} aria-label="Height in metres" /><span>m</span>
        <button className="btn small ghost" onClick={() => apply(aboveHeight(layout, height, 'above'))}>Above</button>
        <button className="btn small ghost" onClick={() => apply(aboveHeight(layout, height, 'below'))}>Below</button>
      </div>
      <div className="rule-row">
        <span>House half</span>
        <button className="btn small ghost" onClick={() => apply(sideOf(layout, 'left'))}>Left</button>
        <button className="btn small ghost" onClick={() => apply(sideOf(layout, 'right'))}>Right</button>
      </div>

      <div className="section-head"><h3>Groups</h3><span className="hint-inline">use in a layer's Lights</span></div>
      <div className="rule-row">
        <input className="text" placeholder="New group name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="New group name" />
        <button className="btn small" disabled={busy || !selection.size || !name.trim() || name.trim() === 'all' || name.trim().startsWith('run:')}
          onClick={() => { const n = name.trim(); if (config.groups?.[n] && !window.confirm(`Replace the group “${n}”?`)) return; void saveGroups({ ...(config.groups ?? {}), [n]: { pixels: sorted() } }).then(() => setName('')); }}>Save</button>
      </div>
      <ul className="group-list">
        {groups.map(([g, cfg]) => (
          <li key={g} className="group-item">
            <div className="group-top">
              <button className="group-name" title="Select this group's lights" onClick={() => onSelection(members(g))}>{g}</button>
              <span className="muted">{[...(layout.groups.get(g) ?? [])].filter(Boolean).length} lights</span>
              <button className="btn small ghost" disabled={busy || !selection.size} title="Replace this group's lights with the selection"
                onClick={() => void saveGroups({ ...config.groups, [g]: { ...cfg, runs: undefined, pixels: sorted() } })}>Update</button>
              <button className="icon-btn small" aria-label={`Delete group ${g}`} disabled={busy}
                onClick={() => { if (window.confirm(`Delete the group “${g}”? Layers using it switch to all lights.`)) void deleteGroup(g); }}>×</button>
            </div>
            <label className="field slider compact">
              <span className="field-label" aria-hidden>Soft edge<span className="field-value">{(cfg.feather ?? 0).toFixed(2)} m</span></span>
              <input type="range" min={0} max={3} step={0.05} defaultValue={cfg.feather ?? 0} aria-label={`Soft edge for ${g}`} style={{ ['--fill' as string]: `${((cfg.feather ?? 0) / 3) * 100}%` }}
                onPointerUp={(e) => void saveGroups({ ...config.groups, [g]: { ...cfg, feather: Number((e.target as HTMLInputElement).value) } })}
                onKeyUp={(e) => void saveGroups({ ...config.groups, [g]: { ...cfg, feather: Number((e.target as HTMLInputElement).value) } })} />
            </label>
          </li>
        ))}
        {groups.length === 0 && <li className="empty">No groups yet. Select lights, name the group and Save.</li>}
      </ul>
    </aside>
  );
}
