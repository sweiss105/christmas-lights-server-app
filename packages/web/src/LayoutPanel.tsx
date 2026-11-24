import { useState } from 'react';
import type { LayoutConfig, RunConfig, Vec3 } from '@xmas/engine';
import { api } from './api';
import { UndoIcon } from './EditorPanel';
import type { History } from './editor';
import { addRun, freeRanges, insertPoint, layoutError, removePoint, removeRun, reverseRun, runLength, setPoint, updateRun } from './layoutOps';
import { runColor } from './layoutColors';
import type { Show } from './useShow';

interface Props {
  show: Show;
  draft: History<LayoutConfig>;
  /** Back to editing scenes (unsaved layout changes are kept for next time). */
  onDone: () => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  drawing: boolean;
  onDrawingChange: (d: boolean) => void;
}

/** Right-hand panel in Layout mode: controllers, runs and the selected run's path. */
export function LayoutPanel({ show, draft, onDone, selected, onSelect, drawing, onDrawingChange }: Props) {
  const l = draft.value;
  const error = layoutError(l);
  const dirty = JSON.stringify(l) !== JSON.stringify(show.layout);
  const [saving, setSaving] = useState(false);
  const run = l.runs.find((r) => r.id === selected) ?? null;

  const save = async () => {
    setSaving(true);
    try { await api.saveLayout(l); await show.refresh(); } catch (e) { show.reportError(e); }
    setSaving(false);
  };

  return (
    <aside className="editor glass layout-panel" aria-label="Layout editor">
      <div className="editor-sticky">
        <div className="editor-head">
          <div className="editor-title">
            <span className="eyebrow">Layout</span>
            <h2>Strings on the house</h2>
          </div>
          <div className="history">
            <button className="icon-btn" onClick={() => draft.undo()} disabled={!draft.canUndo} aria-label="Undo" title="Undo (⌘Z)"><UndoIcon /></button>
            <button className="icon-btn" onClick={() => draft.redo()} disabled={!draft.canRedo} aria-label="Redo" title="Redo (⇧⌘Z)"><UndoIcon flip /></button>
            <button className="btn small done-btn" onClick={onDone} title={dirty ? 'Back to editing scenes; your unsaved layout changes are kept' : 'Back to editing scenes (Esc)'}>Done</button>
          </div>
        </div>
        <div className="mode-row">
          {error ? <p className="layout-error" role="alert">{error}</p>
            : <p className="mode-hint">{dirty ? 'Unsaved changes. Saving remaps the porch at once if streaming is on.' : 'Saved. Each run shows in its own colour, dim at its first pixel and bright at its last.'}</p>}
          <div className="row">
            <button className="btn small" disabled={!dirty || !!error || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save layout'}</button>
            <button className="btn small ghost" disabled={!dirty || saving} onClick={() => { if (show.layout) draft.reset(show.layout); }}>Discard</button>
          </div>
        </div>
      </div>

      <div className="section-head"><h3>Controllers</h3></div>
      {l.controllers.map((c) => (
        <div key={c.id} className="controller-row">
          <div className="controller-name">{c.name} <span className="muted">{c.host} · {c.pixelCount} px</span></div>
          <Coverage layout={l} controller={c.id} pixelCount={c.pixelCount} selected={selected} onSelect={onSelect} />
        </div>
      ))}

      <div className="section-head"><h3>Runs</h3><span className="hint-inline">wiring order</span></div>
      <ul className="layer-list">
        {l.runs.map((r, i) => (
          <li key={r.id}>
            <button className={`run-row ${r.id === selected ? 'selected' : ''}`} onClick={() => onSelect(r.id)}>
              <span className="run-swatch" style={{ background: runColor(i, 1) }} aria-hidden />
              <span className="layer-main static">
                <span className="layer-name">{r.name ?? r.id}</span>
                <span className="layer-sub">{r.controller} {r.start}–{r.start + r.count - 1} · {r.count} px · {runLength(r).toFixed(1)} m</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="layer-actions">
        {l.controllers.map((c) => (
          <button key={c.id} className="btn small" disabled={freeRanges(l, c.id).length === 0}
            onClick={() => { const next = addRun(l, c.id); draft.edit(next); onSelect(next.runs.at(-1)!.id); }}>
            + Run on {c.id}
          </button>
        ))}
      </div>

      {run && <RunInspector show={show} layout={l} run={run} draft={draft} drawing={drawing} onDrawingChange={onDrawingChange} onDeleted={() => onSelect(null)} />}
    </aside>
  );
}

function RunInspector({ show, layout: l, run, draft, drawing, onDrawingChange, onDeleted }: {
  show: Show; layout: LayoutConfig; run: RunConfig; draft: History<LayoutConfig>; drawing: boolean; onDrawingChange: (d: boolean) => void; onDeleted: () => void;
}) {
  const id = run.id;
  const len = runLength(run);
  const points = run.points ?? [];
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : fallback);
  return (
    <div className="inspector">
      <div className="section-head"><h3>Run</h3></div>
      <label className="field"><span className="field-label">Name</span>
        <input className="text" value={run.name ?? ''} onChange={(e) => draft.edit(updateRun(l, id, { name: e.target.value }), { merge: `${id}.name` })} onBlur={() => draft.endGesture()} />
      </label>
      <div className="field-row">
        <label className="field"><span className="field-label">Controller</span>
          <select value={run.controller} onChange={(e) => draft.edit(updateRun(l, id, { controller: e.target.value }))}>
            {l.controllers.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-label">First pixel</span>
          <input className="num wide" type="number" min={0} value={run.start} onChange={(e) => draft.edit(updateRun(l, id, { start: Math.max(0, Math.round(num(e.target.value, run.start))) }))} />
        </label>
        <label className="field"><span className="field-label">Pixels</span>
          <input className="num wide" type="number" min={1} value={run.count} onChange={(e) => draft.edit(updateRun(l, id, { count: Math.max(1, Math.round(num(e.target.value, run.count))) }))} />
        </label>
      </div>
      <p className="effect-desc inline">{len > 0 ? `${len.toFixed(2)} m long, ${(run.count / len).toFixed(0)} pixels per metre (${((len / run.count) * 100).toFixed(1)} cm apart).` : 'Give the run at least two points to spread its pixels out.'}</p>
      <div className="layer-actions">
        <button className={`btn small ${drawing ? 'drawing' : ''}`} aria-pressed={drawing} onClick={() => onDrawingChange(!drawing)}>{drawing ? 'Drawing: tap the house…' : 'Draw points'}</button>
        <button className="btn small ghost" onClick={() => draft.edit(reverseRun(l, id))} title="The first pixel is at the other end">Reverse</button>
        <IdentifyButton show={show} run={run} saved={!!show.layout?.runs.some((r) => r.id === id)} />
        <button className="btn small ghost danger-quiet" onClick={() => { if (window.confirm(`Delete the run “${run.name ?? id}”?`)) { draft.edit(removeRun(l, id)); onDeleted(); } }}>Delete</button>
      </div>

      <div className="section-head"><h3>Coil</h3><span className="hint-inline">lights wound round a rail</span></div>
      <label className="check coil-check">
        <input type="checkbox" checked={!!run.coil} onChange={(e) => draft.edit(updateRun(l, id, { coil: e.target.checked ? { radius: 0.04, pitch: 0.27 } : undefined }))} />
        The string spirals around the path
      </label>
      {run.coil && (
        <div className="field-row">
          <label className="field"><span className="field-label">Turn every (cm)</span>
            <input className="num wide" type="number" min={1} step={1} value={Math.round(run.coil.pitch * 100)} aria-label="Turn spacing in centimetres"
              onChange={(e) => { const v = num(e.target.value, run.coil!.pitch * 100); if (v > 0) draft.edit(updateRun(l, id, { coil: { ...run.coil!, pitch: v / 100 } }), { merge: `${id}.pitch` }); }} onBlur={() => draft.endGesture()} />
          </label>
          <label className="field"><span className="field-label">Rail size (cm)</span>
            <input className="num wide" type="number" min={1} max={100} step={1} value={Math.round(run.coil.radius * 200)} aria-label="Rail thickness in centimetres"
              onChange={(e) => { const v = num(e.target.value, run.coil!.radius * 200); if (v > 0 && v <= 100) draft.edit(updateRun(l, id, { coil: { ...run.coil!, radius: v / 200 } }), { merge: `${id}.radius` }); }} onBlur={() => draft.endGesture()} />
          </label>
        </div>
      )}

      <div className="section-head"><h3>Path points</h3><span className="hint-inline">metres: across · up · towards street</span></div>
      <ol className="points">
        {points.map((p, i) => (
          <li key={i} className={`point-row ${run.coil ? 'coiled' : ''}`}>
            <span className="point-idx">{i === 0 ? 'Start' : i === points.length - 1 ? 'End' : i + 1}</span>
            {[0, 1, 2].map((a) => (
              <input key={a} className="num" type="number" step={0.05} value={p[a]} aria-label={`Point ${i + 1} ${['across', 'up', 'towards street'][a]}`}
                onChange={(e) => { const q = [...p] as Vec3; q[a] = num(e.target.value, p[a]!); draft.edit(setPoint(l, id, i, q), { merge: `${id}.p${i}` }); }}
                onBlur={() => draft.endGesture()} />
            ))}
            {run.coil && (i < points.length - 1 ? (() => {
              const straight = run.coil.skip?.includes(i) ?? false;
              const skip = straight ? run.coil.skip!.filter((n) => n !== i) : [...(run.coil.skip ?? []), i].sort((a, b) => a - b);
              return <button className="icon-btn small" aria-pressed={!straight} aria-label={`Path to point ${i + 2}: ${straight ? 'straight' : 'coiled'}`}
                title={straight ? 'Straight to the next point (e.g. down a post). Click to coil.' : 'Coiled to the next point. Click to run straight.'}
                onClick={() => draft.edit(updateRun(l, id, { coil: { ...run.coil!, skip: skip.length ? skip : undefined } }))}><SegmentIcon straight={straight} /></button>;
            })() : <span />)}
            <button className="icon-btn small" aria-label={`Add a point after point ${i + 1}`} onClick={() => draft.edit(insertPoint(l, id, i))}>+</button>
            <button className="icon-btn small" aria-label={`Remove point ${i + 1}`} disabled={points.length < 2} onClick={() => draft.edit(removePoint(l, id, i))}>−</button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A bar of the controller's pixels showing which runs use which range. */
function Coverage({ layout: l, controller, pixelCount, selected, onSelect }: { layout: LayoutConfig; controller: string; pixelCount: number; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="coverage" role="img" aria-label={`Pixel use on ${controller}`}>
      {l.runs.map((r, i) => r.controller === controller && (
        <button key={r.id} className={`coverage-seg ${r.id === selected ? 'selected' : ''}`} title={`${r.name ?? r.id}: ${r.start}–${r.start + r.count - 1}`}
          style={{ left: `${(r.start / pixelCount) * 100}%`, width: `${(r.count / pixelCount) * 100}%`, background: runColor(i, 0.9) }}
          onClick={() => onSelect(r.id)} />
      ))}
    </div>
  );
}

/** Flash this run on the real porch for 5 seconds, to check which string is which. */
function IdentifyButton({ show, run, saved }: { show: Show; run: RunConfig; saved: boolean }) {
  const [flashing, setFlashing] = useState(false);
  const streaming = !!show.status?.output.enabled;
  const title = !saved ? 'Save the layout first: the porch only knows saved runs'
    : !streaming ? 'Turn streaming on to see the flash on the porch' : 'Flash this run white on the porch for 5 seconds';
  return (
    <button className="btn small ghost" disabled={!saved || !streaming || flashing} title={title}
      onClick={async () => {
        setFlashing(true);
        try { await api.identify(run.id, 5); await new Promise((r) => setTimeout(r, 5000)); } catch (e) { show.reportError(e); }
        setFlashing(false);
      }}>
      {flashing ? 'Flashing…' : 'Identify'}
    </button>
  );
}

/** A wavy line for a coiled stretch, a straight one for a straight stretch. */
function SegmentIcon({ straight }: { straight: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      {straight ? <path d="M3 9h12" /> : <path d="M2 9c1.5-4 3-4 4.5 0s3 4 4.5 0 3-4 4.5 0" />}
    </svg>
  );
}
