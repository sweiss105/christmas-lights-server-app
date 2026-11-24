import { useMemo, useRef, useState } from 'react';
import { api, type House } from './api';
import { latestWins } from './latest';
import type { Show } from './useShow';

/** Upload the house scan and line it up with the lights. Changes save as you drag. */
export function HousePanel({ show, onClose }: { show: Show; onClose: () => void }) {
  const house = show.house;
  const file = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const save = useMemo(() => latestWins((h: Partial<House>) => api.setHouse(h), show.reportError), [show.reportError]);
  if (!house) return null;

  const update = (patch: Partial<House>) => {
    const next = { ...house, ...patch };
    show.setHouseLocal(next);
    save({ position: next.position, rotation: next.rotation, scale: next.scale, opacity: next.opacity });
  };
  const upload = async (f: File) => {
    setUploading(true);
    try { show.setHouseLocal({ ...house, ...(await api.uploadHouseModel(f)) }); } catch (e) { show.reportError(e); }
    setUploading(false);
  };
  const axis = (i: number, v: number) => { const p = [...house.position] as House['position']; p[i] = v; update({ position: p }); };

  return (
    <div className="house-panel glass" role="dialog" aria-label="House model">
      <div className="panel-head">
        <h2>House model</h2>
        <button className="btn small ghost" onClick={onClose}>Done</button>
      </div>
      <div className="house-body">
        {house.model
          ? <p className="hint">Scan loaded ({house.model.bytes >= 1e6 ? `${(house.model.bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(house.model.bytes / 1e3))} KB`}). Line it up so the lights sit on the porch railings.</p>
          : <p className="hint">Upload a .glb exported from Scaniverse or Polycam. It appears behind the lights in the preview.</p>}
        <input ref={file} type="file" accept=".glb,model/gltf-binary" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
        <div className="row">
          <button className="btn small" disabled={uploading} onClick={() => file.current?.click()}>{uploading ? 'Uploading…' : house.model ? 'Replace scan…' : 'Upload scan…'}</button>
          {house.model && (
            <button className="btn small ghost danger-quiet" onClick={() => {
              if (!window.confirm('Remove the house scan?')) return;
              api.deleteHouseModel().then(() => { const { model: _m, ...rest } = house; show.setHouseLocal(rest); }).catch(show.reportError);
            }}>Remove</button>
          )}
        </div>
        {house.model && (
          <>
            <Num label="Across (m)" value={house.position[0]} min={-30} max={30} step={0.05} onChange={(v) => axis(0, v)} />
            <Num label="Up (m)" value={house.position[1]} min={-10} max={10} step={0.05} onChange={(v) => axis(1, v)} />
            <Num label="Towards street (m)" value={house.position[2]} min={-30} max={30} step={0.05} onChange={(v) => axis(2, v)} />
            <Num label="Turn (°)" value={house.rotation} min={0} max={359} step={1} onChange={(v) => update({ rotation: v })} />
            <Num label="Scale" value={house.scale} min={0.5} max={2} step={0.005} onChange={(v) => update({ scale: v })} />
            <Num label="Opacity" value={house.opacity} min={0.1} max={1} step={0.05} onChange={(v) => update({ opacity: v })} />
          </>
        )}
      </div>
    </div>
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
