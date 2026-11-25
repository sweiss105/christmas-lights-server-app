/**
 * Mapping results, Blind-style: the 3D view shows where the lights were measured (rings) and the
 * layout as it would be with the new positions, but nothing changes until Save. Saving makes a
 * backup first, then saves the layout like the Layout editor does, so Undo there takes it back.
 */
import { useMemo, useState } from 'react';
import { buildLayout, type LayoutConfig } from '@xmas/engine';
import { solveMapping, type SolveResult } from '@xmas/engine/mapping';
import { api } from '../api';
import type { History } from '../editor';
import { runColor } from '../layoutColors';
import type { Show } from '../useShow';
import { CameraIcon, CloseIcon } from './MapScreen';
import { applyPositions, measuredMarkers, solverViews, useHouseRaycast, type MappingViews, type RunRole } from './review';

export interface MapReview {
  result: SolveResult | null;
  error: string | null;
  /** The layout with the chosen runs' measured positions. */
  candidate: LayoutConfig | null;
  markers: ReturnType<typeof measuredMarkers>;
  chosen: Set<string>;
  toggle: (runId: string) => void;
  showMapped: boolean;
  setShowMapped: (v: boolean) => void;
  houseLoaded: boolean;
}

export function useMapReview(show: Show, views: MappingViews, roles: Record<string, RunRole>, active: boolean): MapReview {
  const layout = show.layout;
  const raycast = useHouseRaycast(show.house, active);
  const [unchosen, setUnchosen] = useState<Set<string>>(() => new Set());
  const [showMapped, setShowMapped] = useState(true);
  const { result, error } = useMemo(() => {
    if (!active || !layout) return { result: null, error: null };
    const pixels = buildLayout(layout).count;
    const vs = solverViews(views.views, pixels);
    const anchorRuns = layout.runs.filter((r) => roles[r.id] !== 'measure').map((r) => r.id);
    const targetRuns = layout.runs.filter((r) => roles[r.id] === 'measure').map((r) => r.id);
    if (!vs.length) return { result: null, error: views.views.length ? 'The spots were filmed with a different layout; film them again.' : 'No spots filmed yet.' };
    try { return { result: solveMapping({ layout, views: vs, anchorRuns, targetRuns, raycast: raycast ?? undefined }), error: null }; }
    catch (e) { return { result: null, error: (e as Error).message }; }
  }, [active, layout, views.views, roles, raycast]);
  const chosen = useMemo(() => new Set((result?.runs ?? []).filter((r) => r.positions && !unchosen.has(r.runId)).map((r) => r.runId)), [result, unchosen]);
  const candidate = useMemo(() => (layout && result ? applyPositions(layout, result.runs, chosen) : null), [layout, result, chosen]);
  const markers = useMemo(() => measuredMarkers(result), [result]);
  const toggle = (id: string) => setUnchosen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return { result, error, candidate, markers, chosen, toggle, showMapped, setShowMapped, houseLoaded: !!raycast };
}

interface Props {
  show: Show;
  review: MapReview;
  views: MappingViews;
  roles: Record<string, RunRole>;
  setRole: (id: string, r: RunRole) => void;
  layoutDraft: History<LayoutConfig>;
  onCamera: () => void;
  onDone: () => void;
}

const cm = (m: number | null | undefined) => (m === null || m === undefined || !Number.isFinite(m) ? '–' : m < 0.1 ? `${(m * 100).toFixed(1)} cm` : m < 10 ? `${Math.round(m * 100)} cm` : `${m.toFixed(1)} m`);

export function MapReviewPanel({ show, review, views, roles, setRole, layoutDraft, onCamera, onDone }: Props) {
  const layout = show.layout!;
  const pixels = useMemo(() => buildLayout(layout).count, [layout]);
  const { result, chosen } = review;
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const measuring = layout.runs.filter((r) => roles[r.id] === 'measure');
  const runResult = (id: string) => result?.runs.find((r) => r.runId === id);

  const accept = async () => {
    if (!review.candidate || !chosen.size) return;
    const names = layout.runs.filter((r) => chosen.has(r.id)).map((r) => r.name || r.id).join(', ');
    if (!window.confirm(`Save measured positions for ${names}? A backup is made first, and Undo in the Layout editor takes it back.`)) return;
    setSaving(true);
    try {
      const { file } = await api.backupNow('before-mapping');
      // Through the layout editor's history, so Undo there restores the old positions.
      layoutDraft.reset(layout);
      layoutDraft.edit(review.candidate);
      await api.saveLayout(review.candidate);
      await show.refresh();
      setSaved(`Saved. Backup: ${file}. To take it back, open Layout, press Undo, then Save layout.`);
    } catch (e) { show.reportError(e); }
    setSaving(false);
  };

  return (
    <aside className="editor glass map-review" aria-label="Mapping results">
      <div className="editor-sticky">
        <div className="editor-head">
          <div className="editor-title">
            <span className="eyebrow">Map lights</span>
            <h2>Results</h2>
          </div>
          <div className="history">
            <button className="btn small ghost" onClick={onCamera}><CameraIcon /> Film</button>
            <button className="btn small done-btn" onClick={onDone}>Done</button>
          </div>
        </div>
        <div className="mode-row">
          <div className="segmented mode" role="radiogroup" aria-label="Show in 3D">
            <button role="radio" aria-checked={!review.showMapped} className={!review.showMapped ? 'active' : ''} onClick={() => review.setShowMapped(false)}>Now</button>
            <button role="radio" aria-checked={review.showMapped} className={review.showMapped ? 'active' : ''} onClick={() => review.setShowMapped(true)}>With measured</button>
          </div>
          <p className="mode-hint">{saved ?? 'Nothing changes on the porch until you save. Rings mark measured lights: white from two or more spots, amber from one spot only (less certain).'}</p>
        </div>
      </div>

      <div className="section-head"><h3>Spots</h3><span className="hint-inline">{views.views.length} filmed</span></div>
      {review.error && <p className="hint map-pad">{review.error}</p>}
      {result && views.views.some((v) => v.layoutPixels !== pixels) && (
        <p className="hint map-pad" role="status">Spots marked “older layout” were filmed before the number of lights changed, so they’re left out. Film those again, or delete them.</p>
      )}
      <ul className="part-list">
        {views.views.map((v, i) => {
          const s = result?.views.find((x) => x.id === v.id);
          return (
            <li key={v.id} className="backup-item">
              <span className={`dot ${s?.ok ? 'ok' : 'warn'}`} aria-hidden />
              <div className="backup-label">
                <span className="part-name">Spot {i + 1} · {v.detections.length} lights</span>
                <span className="hint-inline">{!s ? (v.layoutPixels !== pixels ? 'older layout: not used' : 'not used') : s.ok ? `placed from ${s.inliers} trusted lights · ${s.rmsPx.toFixed(1)} px · ${Math.round(s.fovDeg ?? 0)}° view` : s.reason}</span>
              </div>
              <button className="icon-btn small" aria-label={`Delete spot ${i + 1}`} onClick={() => { if (window.confirm(`Delete spot ${i + 1}?`)) void views.remove(v.id); }}><CloseIcon /></button>
            </li>
          );
        })}
      </ul>
      {result?.anchorCheck && <p className="hint map-pad">Check: trusted lights measured again land {cm(result.anchorCheck.median)} from where the layout has them (90% within {cm(result.anchorCheck.p90)}, {result.anchorCheck.count} lights).</p>}

      <div className="section-head"><h3>Strings</h3><span className="hint-inline">Trusted ones place the camera</span></div>
      {layout.runs.map((r, i) => {
        const role = roles[r.id] ?? 'trusted';
        const rr = runResult(r.id);
        return (
          <div key={r.id} className="map-run">
            <div className="map-run-top">
              <span className="run-swatch" style={{ background: runColor(i, 1) }} aria-hidden />
              <span className="part-name">{r.name || r.id}</span>
              <div className="segmented small-seg" role="radiogroup" aria-label={`${r.name || r.id}: role`}>
                <button role="radio" aria-checked={role === 'trusted'} className={role === 'trusted' ? 'active' : ''} onClick={() => setRole(r.id, 'trusted')}>Trusted</button>
                <button role="radio" aria-checked={role === 'measure'} className={role === 'measure' ? 'active' : ''} onClick={() => setRole(r.id, 'measure')}>Measure</button>
              </div>
            </div>
            {role === 'measure' && (rr?.positions ? (
              <label className="check map-run-result">
                <input type="checkbox" checked={chosen.has(r.id)} onChange={() => review.toggle(r.id)} />
                <span>{rr.measured} of {rr.count} measured{rr.oneView ? `, ${rr.oneView} from one spot` : ''}, {rr.filled} filled in · {cm(rr.spacing)} apart · moves {cm(rr.moved)}{rr.rejected ? ` · ${rr.rejected} dropped` : ''}</span>
              </label>
            ) : <p className="hint-inline map-run-result">{result ? 'Not enough of its lights were seen from two placed spots.' : 'Film some spots first.'}</p>)}
          </div>
        );
      })}
      {!measuring.length && <p className="hint map-pad">Mark the strings to measure (new strings, or one porch string to check the other).</p>}

      <div className="go-area map-pad">
        <button className="btn go" disabled={!chosen.size || saving} onClick={() => void accept()}>
          {saving ? 'Saving…' : chosen.size ? `Save positions for ${chosen.size} string${chosen.size === 1 ? '' : 's'}` : 'Nothing to save yet'}
        </button>
      </div>
    </aside>
  );
}
