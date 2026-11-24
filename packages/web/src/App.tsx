import { useEffect, useMemo, useRef, useState } from 'react';
import { EFFECTS, resolveParams, type SceneConfig } from '@xmas/engine';
import { api } from './api';
import { latestWins } from './latest';
import { Preview, type CameraPreset } from './Preview';
import { useShow, type Show } from './useShow';

type View = 'preview' | 'stage';

export function App() {
  const show = useShow();
  const { layout, scenes, status, stage } = show;

  // The scene picked in the list. It is previewed (Blind) until Go puts it on the porch.
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>('preview');
  const [preset, setPreset] = useState<{ name: CameraPreset; nonce: number }>({ name: 'angle', nonce: 0 });
  const leftInset = useLeftInset(!!layout && !!status);

  const stageName = status?.stage.scene ?? null;
  useEffect(() => { if (selected === null && status) setSelected(stageName ?? scenes[0]?.name ?? null); }, [selected, status, stageName, scenes]);

  const selectedScene = scenes.find((s) => s.name === selected) ?? null;
  const shownScene = view === 'stage' ? stage : selectedScene;

  if (!layout || !status) return <Loading show={show} />;

  return (
    <div className="app">
      <Preview layout={layout} scene={shownScene} clock={show.clock} preset={preset} leftInset={leftInset} />

      <TopBar show={show} />

      <ScenePanel show={show} selected={selected} onSelect={(n) => { setSelected(n); setView('preview'); }} />

      <div className="viewbar glass" role="toolbar" aria-label="Preview">
        <Segmented
          label="Show in preview"
          value={view}
          options={[{ value: 'preview', label: 'Preview', hint: selected ?? '' }, { value: 'stage', label: 'Stage', hint: stageName ?? 'Blackout' }]}
          onChange={(v) => setView(v as View)}
        />
        <span className="divider" aria-hidden />
        <Segmented
          label="Camera"
          value={preset.name}
          options={[{ value: 'front', label: 'Front' }, { value: 'close', label: 'Close' }, { value: 'angle', label: 'Angle' }, { value: 'top', label: 'Top' }]}
          onChange={(v) => setPreset((p) => ({ name: v as CameraPreset, nonce: p.nonce + 1 }))}
          reselect
        />
      </div>

      <ViewCaption view={view} show={show} selected={selected} />
      <Health show={show} />
      {!show.connected && <div className="banner warn" role="status">Lost connection to the lights server. Retrying…</div>}
      {show.error && (
        <div className="toast" role="alert">
          <span>{show.error}</span>
          <button className="btn ghost small" onClick={show.clearError}>Dismiss</button>
        </div>
      )}
    </div>
  );
}

/** Width of the scene panel plus its margins, tracked through resizes. */
function useLeftInset(ready: boolean) {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!ready) return;
    const measure = () => {
      const panel = document.querySelector('.scenes');
      setInset(panel ? panel.getBoundingClientRect().right + 12 : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    const panel = document.querySelector('.scenes');
    if (panel) ro.observe(panel);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [ready]);
  return inset;
}

function Loading({ show }: { show: Show }) {
  return (
    <div className="loading">
      <div className="loading-dot" aria-hidden />
      <p>{show.error ? `Can't reach the lights server: ${show.error}` : 'Connecting to the lights…'}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function TopBar({ show }: { show: Show }) {
  const status = show.status!;
  const streaming = status.output.enabled;
  return (
    <header className="topbar glass">
      <div className="brand">
        <span className="brand-mark" aria-hidden />
        <h1>Porch Lights</h1>
      </div>
      <StagePill show={show} />
      <div className="spacer" />
      <Brightness show={show} />
      <StreamingSwitch show={show} />
      <button
        className="btn danger-quiet"
        disabled={!streaming || status.stage.scene === null}
        onClick={() => api.blackout().then(show.refresh).catch(show.reportError)}
        title="Turn every pixel off while streaming"
      >
        Blackout
      </button>
    </header>
  );
}

function StagePill({ show }: { show: Show }) {
  const { stage, output } = show.status!;
  let tone = 'ok', text = `On stage: ${stage.scene}`;
  if (!output.enabled) { tone = 'muted'; text = 'Streaming off · WLED playlist'; }
  else if (stage.scene === null) { tone = 'muted'; text = 'On stage: Blackout'; }
  else if (stage.dirty) { tone = 'warn'; text = `On stage: ${stage.scene} · edited, not sent`; }
  return <div className={`pill ${tone}`} role="status"><span className="dot" aria-hidden />{text}</div>;
}

function Brightness({ show }: { show: Show }) {
  const server = Math.round(show.status!.output.brightness * 100);
  const [value, setValue] = useState(server);
  const dragging = useRef(false);
  useEffect(() => { if (!dragging.current) setValue(server); }, [server]);
  const send = useMemo(() => latestWins((pct: number) => api.setOutput({ brightness: pct / 100 }), show.reportError), [show.reportError]);
  return (
    <label className="brightness" title="Master brightness on the porch">
      <span className="label">Brightness</span>
      <input
        type="range" min={0} max={100} step={1} value={value}
        aria-valuetext={`${value} percent`}
        style={{ ['--fill' as string]: `${value}%` }}
        onPointerDown={() => { dragging.current = true; }}
        onPointerUp={() => { dragging.current = false; }}
        onPointerCancel={() => { dragging.current = false; }}
        onBlur={() => { dragging.current = false; }}
        onChange={(e) => { const v = Number(e.target.value); setValue(v); send(v); }}
      />
      <span className="value">{value}%</span>
    </label>
  );
}

function StreamingSwitch({ show }: { show: Show }) {
  const on = show.status!.output.enabled;
  const [pending, setPending] = useState(false);
  const toggle = async () => {
    setPending(true);
    try { await api.setOutput({ enabled: !on }); await show.refresh(); } catch (e) { show.reportError(e); }
    setPending(false);
  };
  return (
    <button
      className={`switch ${on ? 'on' : ''}`}
      role="switch"
      aria-checked={on}
      disabled={pending}
      onClick={toggle}
      title={on ? 'The server is driving the porch. Turn off to hand the porch back to its WLED playlist.' : 'The porch is running its WLED playlist. Turn on to drive it from here.'}
    >
      <span className="track" aria-hidden><span className="thumb" /></span>
      <span className="switch-label">Streaming</span>
    </button>
  );
}

// ---------------------------------------------------------------------------------------------

function ScenePanel({ show, selected, onSelect }: { show: Show; selected: string | null; onSelect: (name: string) => void }) {
  const status = show.status!;
  const stageName = status.stage.scene;
  const [going, setGoing] = useState(false);
  const isOnStage = selected !== null && selected === stageName && !status.stage.dirty;

  const go = async () => {
    if (!selected) return;
    setGoing(true);
    try { await api.go(selected); await show.refresh(); } catch (e) { show.reportError(e); }
    setGoing(false);
  };

  return (
    <aside className="scenes glass" aria-label="Scenes">
      <div className="panel-head">
        <h2>Scenes</h2>
        <span className="mode-tag" title="Picking a scene previews it here first. Go sends it to the porch.">Blind</span>
      </div>
      <ul className="scene-list" role="listbox" aria-label="Scenes" aria-activedescendant={selected ? `scene-${selected}` : undefined}>
        {show.scenes.map((s) => (
          <li key={s.name}>
            <button
              id={`scene-${s.name}`}
              role="option"
              aria-selected={s.name === selected}
              className={`scene-row ${s.name === selected ? 'selected' : ''}`}
              onClick={() => onSelect(s.name)}
            >
              <Swatch scene={s} />
              <span className="scene-name">{s.name}</span>
              {s.name === stageName && <span className={`tag ${status.stage.dirty ? 'warn' : 'ok'}`}>{status.stage.dirty ? 'Edited' : 'On stage'}</span>}
            </button>
          </li>
        ))}
      </ul>
      <div className="go-area">
        {!status.output.enabled && <p className="hint">Streaming is off, so the porch keeps its WLED playlist until you turn streaming on.</p>}
        <button className="btn go" disabled={!selected || going || isOnStage} onClick={go}>
          {going ? 'Sending…' : isOnStage ? 'On stage' : <>Go <span className="go-target">{selected}</span></>}
        </button>
      </div>
    </aside>
  );
}

/** A small strip of the colours a scene uses, so scenes can be told apart at a glance. */
function Swatch({ scene }: { scene: SceneConfig }) {
  const colors: string[] = [];
  for (const l of scene.layers) {
    const def = EFFECTS[l.effect];
    const params = def ? resolveParams(def, l.params) : l.params ?? {};
    for (const k of ['color', 'colorA', 'colorB', 'background']) {
      const v = params[k];
      if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) && v.toLowerCase() !== '#000000' && !colors.includes(v)) colors.push(v);
    }
    if (l.effect === 'rainbow') colors.push('#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2');
  }
  const stops = colors.length ? colors.slice(0, 5) : ['#2a3142'];
  const bg = stops.length === 1 ? stops[0] : `linear-gradient(90deg, ${stops.join(', ')})`;
  return <span className="swatch" style={{ background: bg }} aria-hidden />;
}

// ---------------------------------------------------------------------------------------------

function ViewCaption({ view, show, selected }: { view: View; show: Show; selected: string | null }) {
  const status = show.status!;
  let text: string;
  if (view === 'stage') {
    text = status.output.enabled ? `Stage: what the porch is showing (${status.stage.scene ?? 'Blackout'})` : 'Stage: streaming is off, the real porch is on its WLED playlist';
  } else {
    text = `Preview: ${selected ?? 'nothing selected'}${selected && selected !== status.stage.scene ? ' (not on the porch)' : ''}`;
  }
  return <div className={`caption ${view}`} role="status">{text}</div>;
}

function Health({ show }: { show: Show }) {
  const s = show.status!.stream;
  return (
    <footer className="health glass" aria-label="Controller health">
      {s.controllers.map((c) => (
        <span key={c.id} className="health-item" title={c.lastError ?? c.warning ?? `${c.info?.name ?? c.id} at ${c.host}`}>
          <span className={`dot ${c.online ? (c.sendErrors ? 'warn' : 'ok') : 'bad'}`} aria-hidden />
          {c.id} {c.online ? 'online' : 'offline'}
        </span>
      ))}
      <span className="health-item muted">{s.running ? `${s.fps} fps` : 'not streaming'}</span>
      {s.running && <span className="health-item muted">{s.controllers.reduce((a, c) => a + c.sendErrors, 0)} errors</span>}
    </footer>
  );
}

function Segmented<T extends string>({ label, value, options, onChange, reselect }: {
  label: string; value: T; options: { value: T; label: string; hint?: string }[]; onChange: (v: T) => void; reselect?: boolean;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'active' : ''}
          title={o.hint}
          onClick={() => { if (o.value !== value || reselect) onChange(o.value); }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
