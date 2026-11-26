import { useMemo, useRef, useState } from 'react';
import { api, type House, type HousePart } from './api';
import { EyeIcon } from './EditorPanel';
import { latestWins } from './latest';
import type { Show } from './useShow';
import { PanelHead } from './PanelHead';

const size = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

/**
 * Upload house scans and line them up. Each part (e.g. two halves scanned separately) is first
 * placed against the others; "Whole house" then lines everything up with the lights.
 */
export function HousePanel({ show, onHide }: { show: Show; onHide?: () => void }) {
  const house = show.house;
  const file = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [target, setTarget] = useState<'house' | string>('house');
  const lastGlow = useRef(1); // strength to come back to when the glow is switched back on
  const saveHouse = useMemo(() => latestWins((h: Partial<House>) => api.setHouse(h), show.reportError), [show.reportError]);
  const savePart = useMemo(() => latestWins(({ id, ...p }: Partial<HousePart> & { id: string }) => api.setHousePart(id, p), show.reportError), [show.reportError]);
  if (!house) return null;

  const part = house.parts.find((p) => p.id === target) ?? null;
  const updateHouse = (patch: Partial<House>) => {
    const next = { ...house, ...patch };
    show.setHouseLocal(next);
    saveHouse({ position: next.position, rotation: next.rotation, scale: next.scale, opacity: next.opacity, glow: next.glow });
  };
  const updatePart = (id: string, patch: Partial<HousePart>) => {
    const parts = house.parts.map((p) => (p.id === id ? { ...p, ...patch } : p));
    show.setHouseLocal({ ...house, parts });
    const p = parts.find((x) => x.id === id)!;
    savePart({ id, position: p.position, rotation: p.rotation, scale: p.scale, visible: p.visible, name: p.name });
  };
  const upload = async (files: FileList) => {
    setUploading(true);
    let added = house.parts;
    try {
      for (const f of Array.from(files)) {
        const p = await api.uploadHousePart(f, f.name.replace(/\.glb$/i, ''));
        added = [...added, p];
        show.setHouseLocal({ ...house, parts: added });
      }
    } catch (e) { show.reportError(e); }
    setUploading(false);
  };

  // Controls for whichever is selected: the whole house, or one part relative to the others.
  const t = part ?? house;
  const set = (patch: Partial<House & HousePart>) => (part ? updatePart(part.id, patch) : updateHouse(patch));
  const axis = (i: number, v: number) => { const p = [...t.position] as House['position']; p[i] = v; set({ position: p }); };

  return (
    <aside className="editor glass house-panel" aria-label="House model">
      <PanelHead eyebrow="House" title="House model" onHide={onHide} />
      <div className="house-body">
        <p className="hint">
          {house.parts.length
            ? 'Place each scan against the others, then use Whole house to line everything up with the lights.'
            : 'Upload .glb scans (Polycam, Scaniverse). Several scans of one house are fine: upload them all.'}
        </p>
        <input ref={file} type="file" accept=".glb,model/gltf-binary" multiple hidden
          onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = ''; }} />
        <div className="row">
          <button className="btn small" disabled={uploading} onClick={() => file.current?.click()}>{uploading ? 'Uploading…' : 'Upload scans…'}</button>
        </div>

        {house.parts.length > 0 && (
          <ul className="part-list" role="listbox" aria-label="What to move">
            <li>
              <button role="option" aria-selected={target === 'house'} className={`part-row ${target === 'house' ? 'selected' : ''}`} onClick={() => setTarget('house')}>
                <span className="part-name">Whole house</span><span className="muted">lines up with the lights</span>
              </button>
            </li>
            {house.parts.map((p) => (
              <li key={p.id} className="part-item">
                <button role="option" aria-selected={target === p.id} className={`part-row ${target === p.id ? 'selected' : ''}`} onClick={() => setTarget(p.id)}>
                  <span className="part-name">{p.name}</span><span className="muted">{size(p.bytes)}</span>
                </button>
                <button className="icon-btn small" aria-pressed={p.visible} title={p.visible ? 'Hide' : 'Show'} aria-label={`${p.visible ? 'Hide' : 'Show'} ${p.name}`}
                  onClick={() => updatePart(p.id, { visible: !p.visible })}><EyeIcon off={!p.visible} /></button>
              </li>
            ))}
          </ul>
        )}

        {house.parts.length > 0 && (
          <>
            <div className="section-head"><h3>{part ? `Move “${part.name}”` : 'Whole house'}</h3></div>
            <Num label="Across (m)" value={t.position[0]} min={-30} max={30} step={0.05} onChange={(v) => axis(0, v)} />
            <Num label="Up (m)" value={t.position[1]} min={-10} max={10} step={0.05} onChange={(v) => axis(1, v)} />
            <Num label="Towards street (m)" value={t.position[2]} min={-30} max={30} step={0.05} onChange={(v) => axis(2, v)} />
            <Num label="Turn (°)" value={t.rotation} min={0} max={359} step={0.5} onChange={(v) => set({ rotation: v })} />
            <Num label="Scale" value={t.scale} min={0.5} max={2} step={0.002} onChange={(v) => set({ scale: v })} />
            {!part && <Num label="Opacity" value={house.opacity} min={0.1} max={1} step={0.05} onChange={(v) => updateHouse({ opacity: v })} />}
            {!part && <GlowControls value={house.glow ?? 1} last={lastGlow} onChange={(v) => updateHouse({ glow: v })} />}
            {part && (
              <div className="row">
                <button className="btn small ghost danger-quiet" onClick={() => {
                  if (!window.confirm(`Remove the scan “${part.name}”?`)) return;
                  api.deleteHousePart(part.id).then(() => { show.setHouseLocal({ ...house, parts: house.parts.filter((x) => x.id !== part.id) }); setTarget('house'); }).catch(show.reportError);
                }}>Remove this scan</button>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * The lights' coloured spill on the house in the preview (built models only; photo scans have
 * their daylight baked in). 0 is off.
 */
function GlowControls({ value, last, onChange }: { value: number; last: { current: number }; onChange: (v: number) => void }) {
  const on = value > 0;
  if (on) last.current = value;
  return (
    <>
      <div className="field toggle-field">
        <button className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} onClick={() => onChange(on ? 0 : last.current || 1)}>
          <span className="track" aria-hidden><span className="thumb" /></span>
          <span className="switch-label">Light glow on the house</span>
        </button>
      </div>
      {on && <Num label="Glow strength" value={value} min={0.1} max={3} step={0.05} onChange={(v) => onChange(Math.max(0.1, v))} />}
    </>
  );
}

/** Slider plus a number box for exact values. */
function Num({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  const pct = ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100;
  return (
    <div className="field slider num-field">
      <span className="field-label" aria-hidden>{label}
        <input className="num" type="number" value={Number(value.toFixed(3))} step={step} aria-label={`${label} value`}
          onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(v); }} />
      </span>
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label} style={{ ['--fill' as string]: `${pct}%` }}
        onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}
