import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { EFFECTS, paletteColors, resolveParams, type LayoutConfig, type SceneConfig } from '@xmas/engine';
import { api } from './api';
import { History, uniqueName, type SceneEditor } from './editor';
import { appendPoint, setPoint } from './layoutOps';
import { LayoutPanel } from './LayoutPanel';
import { SelectPanel } from './SelectPanel';
import { SelectionOverlay, type SelectTool } from './SelectionOverlay';
import type { SelectMode, Selection } from './selection';
import { EditorPanel } from './EditorPanel';
import { BackupPanel } from './BackupPanel';
import { HousePanel } from './HousePanel';
import { PlaylistsView, ScheduleView } from './ShowPanels';
import { latestWins } from './latest';
import { Preview, type CameraPreset } from './Preview';
import { useSceneEditor, type EditMode } from './useSceneEditor';
import { useShow, type Show } from './useShow';

type View = 'preview' | 'stage';

/** Width of the house panel (matches .house-panel in styles.css); the 3D view shifts aside while it's open. */
const HOUSE_PANEL_W = 280;

export function App() {
  const show = useShow();
  const { layout, scenes, status, stage } = show;

  // The scene picked in the list. It is previewed (Blind) until Go puts it on the porch.
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>('preview');
  const [preset, setPreset] = useState<{ name: CameraPreset; nonce: number }>({ name: 'angle', nonce: 0 });
  const phone = usePhone();
  const [phoneTab, setPhoneTab] = useState<'scenes' | 'edit'>('scenes');
  const sideLeft = useInset('.scenes', 'left', !!layout && !!status && !phone);

  const stageName = status?.stage.scene ?? null;
  useEffect(() => { if (selected === null && status) setSelected(stageName ?? scenes[0]?.name ?? null); }, [selected, status, stageName, scenes]);

  const [mode, setMode] = useState<EditMode>('blind');
  const [houseOpen, setHouseOpen] = useState(false);
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [layoutMode, setLayoutMode] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selection, setSelection] = useState<Selection>(() => new Set());
  const [selectTool, setSelectTool] = useState<SelectTool>('box');
  const [selectModeKind, setSelectModeKind] = useState<SelectMode>('replace');
  const [brushSize, setBrushSize] = useState(24);
  const [projector, setProjector] = useState<{ fn: () => Float32Array } | null>(null);
  const onProjector = useCallback((p: (() => Float32Array) | null) => setProjector(p ? { fn: p } : null), []);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  /** Leave Select or Layout and show the scene editor again (the selection and any layout draft are kept). */
  const backToEditing = useCallback(() => { setSelectMode(false); setLayoutMode(false); setDrawing(false); }, []);
  // Esc does the same, unless it's meant for a text field or an open popup (they handle it themselves).
  useEffect(() => {
    if (!selectMode && !layoutMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [role="dialog"]')) return;
      if (drawing) { setDrawing(false); return; } // first Esc just stops drawing points
      backToEditing();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectMode, layoutMode, drawing, backToEditing]);
  const layoutDraft = useLayoutDraft(layout);
  const editor = useSceneEditor(show, selected, mode);
  const sideRight = useInset('.editor', 'right', !!layout && !!status && !phone);
  const sheetInset = useSheetInset(phone, !!layout && !!status);
  const leftInset = phone ? 0 : sideLeft;
  const rightInset = phone ? 0 : sideRight;
  useHistoryKeys(layoutMode ? layoutDraft : editor);

  const selectedScene = scenes.find((s) => s.name === selected) ?? null;
  // The preview shows the working copy, so edits appear instantly, before the save round trip.
  const working = editor.scene.name === selected ? editor.scene : selectedScene;
  const shownScene = view === 'stage' ? stage : working;

  const sceneActions = useSceneActions(show, editor, setSelected);

  if (!layout || !status) return <Loading show={show} />;

  return (
    <div className={`app ${mode === 'live' ? 'live-armed' : ''} ${phone ? `phone tab-${phoneTab}` : ''}`}>
      <Preview layout={layoutMode ? layoutDraft.value : layout} scene={shownScene} clock={show.clock} preset={preset} leftInset={leftInset} rightInset={rightInset + ((houseOpen || backupsOpen) && !phone ? HOUSE_PANEL_W + 12 : 0)} bottomInset={sheetInset} house={show.house}
        selection={selectMode ? selection : null} onProjector={selectMode ? onProjector : undefined}
        layoutEdit={layoutMode ? {
          selected: selectedRun, drawing,
          onAddPoint: (p) => { if (selectedRun) layoutDraft.edit(appendPoint(layoutDraft.value, selectedRun, p)); },
          onMovePoint: (i, p, done) => {
            if (!selectedRun) return;
            if (done) layoutDraft.endGesture();
            else layoutDraft.edit(setPoint(layoutDraft.value, selectedRun, i, p), { merge: `${selectedRun}.drag${i}` });
          },
        } : null} />

      {/* The selection layer covers the 3D view only: panels come after it, so they stay clickable. */}
      {selectMode && projector && (
        <SelectionOverlay tool={selectTool} mode={selectModeKind} brushSize={brushSize} project={projector.fn} layoutConfig={layout} selection={selection} onChange={setSelection} />
      )}

      <TopBar show={show} mode={mode} tools={
        <div className="tools" role="toolbar" aria-label="Tools">
          <button className={`viewbar-btn ${selectMode ? 'active' : ''}`} aria-pressed={selectMode}
            onClick={() => { setSelectMode((m) => !m); setLayoutMode(false); setDrawing(false); }}>Select</button>
          <button className={`viewbar-btn ${layoutMode ? 'active' : ''}`} aria-pressed={layoutMode}
            onClick={() => { setLayoutMode((m) => !m); setSelectMode(false); setDrawing(false); }}>Layout</button>
          <button className={`viewbar-btn ${houseOpen ? 'active' : ''}`} aria-pressed={houseOpen} onClick={() => { setHouseOpen((o) => !o); setBackupsOpen(false); }}>House</button>
          <button className={`viewbar-btn ${backupsOpen ? 'active' : ''}`} aria-pressed={backupsOpen} onClick={() => { setBackupsOpen((o) => !o); setHouseOpen(false); }}>Backups</button>
        </div>
      } />

      <ScenePanel show={show} mode={mode} selected={selected} actions={sceneActions} onSelect={(n) => { setSelected(n); setView('preview'); backToEditing(); }} />

      {selectMode
        ? <SelectPanel show={show} selection={selection} onSelection={setSelection} tool={selectTool} onTool={setSelectTool}
            mode={selectModeKind} onMode={setSelectModeKind} brushSize={brushSize} onBrushSize={setBrushSize} onDone={backToEditing} />
        : layoutMode
        ? <LayoutPanel show={show} draft={layoutDraft} onDone={backToEditing} selected={selectedRun} onSelect={(id) => { setSelectedRun(id); setDrawing(false); }} drawing={drawing} onDrawingChange={setDrawing} />
        : <EditorPanel show={show} editor={editor} mode={mode} onModeChange={setMode} onRename={(n) => sceneActions.rename(n)} />}

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
      {houseOpen && <HousePanel show={show} onClose={() => setHouseOpen(false)} />}
      {backupsOpen && <BackupPanel show={show} onClose={() => setBackupsOpen(false)} />}

      {selectMode
        ? <div className="caption layout" role="status">{selectTool === 'orbit' ? 'Select: Move tool, drag to turn the view' : `Select: ${selectTool === 'brush' ? 'paint over lights' : selectTool === 'lasso' ? 'draw around lights' : selectTool === 'string' ? 'tap a string to pick all its lights' : 'drag a box around lights'} · ${selection.size} selected`}</div>
        : layoutMode
        ? <div className="caption layout" role="status">{drawing ? 'Drawing: tap on the house to add points to the end of the run' : 'Layout: drag the white handles; green is the start of the run, red the end'}</div>
        : <ViewCaption view={view} show={show} selected={selected} />}
      <Health show={show} />
      {phone && (
        <div className="phone-tabs" role="toolbar" aria-label="Panels">
          <Segmented label="Panel" value={phoneTab} options={[{ value: 'scenes', label: 'Scenes' }, { value: 'edit', label: 'Edit' }]} onChange={(v) => setPhoneTab(v as 'scenes' | 'edit')} />
          <Segmented label="Show in preview" value={view} options={[{ value: 'preview', label: 'Preview' }, { value: 'stage', label: 'Stage' }]} onChange={(v) => setView(v as View)} />
        </div>
      )}
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

/** True on phone-sized screens, where the panels become a bottom sheet. */
function usePhone(): boolean {
  const query = '(max-width: 760px)';
  const [phone, setPhone] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setPhone(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return phone;
}

/** Height of the phone's bottom sheet plus its tab bar, so the 3D view centres above it. */
function useSheetInset(phone: boolean, ready: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!phone || !ready) { setInset(0); return; }
    const measure = () => {
      const tabs = document.querySelector('.phone-tabs')?.getBoundingClientRect();
      setInset(tabs ? window.innerHeight - tabs.top + 8 : 0);
    };
    measure();
    window.addEventListener('resize', measure);
    const t = setTimeout(measure, 50);
    return () => { window.removeEventListener('resize', measure); clearTimeout(t); };
  }, [phone, ready]);
  return inset;
}

/** How much of the window's width a side panel covers (plus margin), tracked through resizes. */
function useInset(selector: string, side: 'left' | 'right', ready: boolean) {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!ready) return;
    const measure = () => {
      const r = document.querySelector(selector)?.getBoundingClientRect();
      setInset(!r || r.width === 0 ? 0 : side === 'left' ? r.right + 12 : window.innerWidth - r.left + 12);
    };
    measure();
    const ro = new ResizeObserver(measure);
    const panel = document.querySelector(selector);
    if (panel) ro.observe(panel);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [selector, side, ready]);
  return inset;
}

/** The layout being edited, kept in step with the server's until it's changed here. */
function useLayoutDraft(saved: LayoutConfig | null): History<LayoutConfig> {
  const draft = useMemo(() => new History<LayoutConfig>({ controllers: [], runs: [] }), []);
  useSyncExternalStore((fn) => draft.subscribe(fn), () => draft.version);
  const last = useRef<string>('');
  useEffect(() => {
    if (!saved) return;
    const key = JSON.stringify(saved);
    // Take the server's layout when it changes (after a save), unless there are unsaved edits.
    const untouched = JSON.stringify(draft.value) === last.current || !draft.value.controllers.length;
    if (key !== last.current && untouched) draft.reset(saved);
    last.current = key;
  }, [saved, draft]);
  return draft;
}

/** ⌘Z / Ctrl+Z undo, ⇧⌘Z / Ctrl+Y redo, unless typing in a text field. */
function useHistoryKeys(editor: History<unknown> | SceneEditor) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); editor.undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); editor.redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor]);
}

export interface SceneActions {
  create: () => Promise<void>;
  duplicate: () => Promise<void>;
  remove: (name: string) => Promise<void>;
  rename: (newName: string) => Promise<boolean>;
}

/** New, duplicate, rename and delete. All are Blind saves: none of them changes the porch. */
function useSceneActions(show: Show, editor: SceneEditor, select: (n: string | null) => void): SceneActions {
  const names = () => show.scenes.map((s) => s.name);
  const saveNew = async (scene: SceneConfig) => {
    const saved = await api.saveScene(scene, false);
    show.markSceneSaved(saved);
    select(saved.name);
  };
  return {
    create: () => saveNew({
      name: uniqueName('New scene', names()),
      layers: [{ id: 'solid', effect: 'solid', params: { color: '#ffb46b' } }],
    }).catch(show.reportError),
    duplicate: async () => {
      const src = editor.scene;
      if (!src.name) return;
      await saveNew({ ...structuredClone(src), name: uniqueName(src.name, names()) }).catch(show.reportError);
    },
    remove: async (name) => {
      if (show.status?.stage.scene === name) { show.reportError(new Error(`“${name}” is on stage. Go to another scene first, then delete it.`)); return; }
      if (!window.confirm(`Delete the scene “${name}”? This can’t be undone.`)) return;
      try {
        await api.deleteScene(name);
        await show.refresh();
        select(null);
      } catch (e) { show.reportError(e); }
    },
    rename: async (newName) => {
      const old = editor.scene;
      if (names().includes(newName)) { show.reportError(new Error(`There's already a scene called “${newName}”.`)); return false; }
      if (show.status?.stage.scene === old.name) { show.reportError(new Error('This scene is on stage. Go to another scene first, then rename it.')); return false; }
      try {
        await api.saveScene({ ...old, name: newName }, false);
        await api.deleteScene(old.name);
        await show.refresh();
        select(newName);
        return true;
      } catch (e) { show.reportError(e); return false; }
    },
  };
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

function TopBar({ show, mode, tools }: { show: Show; mode: EditMode; tools: React.ReactNode }) {
  const status = show.status!;
  const streaming = status.output.enabled;
  return (
    <header className="topbar glass">
      <div className="brand">
        <span className="brand-mark" aria-hidden />
        <h1>Porch Lights</h1>
      </div>
      {mode === 'live' && <span className="live-badge" role="status" title="Live is armed: edits to the scene on stage go to the porch immediately">LIVE</span>}
      <StagePill show={show} />
      <div className="spacer" />
      {tools}
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
  else if (show.status!.playlist) text = `Playlist ${show.status!.playlist.name}: ${stage.scene}`;
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

function ScenePanel({ show, mode, selected, actions, onSelect }: { show: Show; mode: EditMode; selected: string | null; actions: SceneActions; onSelect: (name: string) => void }) {
  const status = show.status!;
  const stageName = status.stage.scene;
  const [going, setGoing] = useState(false);
  const [tab, setTab] = useState<'scenes' | 'playlists' | 'schedule'>('scenes');
  const isOnStage = selected !== null && selected === stageName && !status.stage.dirty;

  const go = async () => {
    if (!selected) return;
    setGoing(true);
    try { await api.go(selected); await show.refresh(); } catch (e) { show.reportError(e); }
    setGoing(false);
  };

  return (
    <aside className="scenes glass" aria-label="Scenes, playlists and schedule">
      <div className="panel-head">
        <div className="segmented panel-tabs" role="tablist" aria-label="Panel">
          {([['scenes', 'Scenes'], ['playlists', 'Playlists'], ['schedule', 'Schedule']] as const).map(([v, label]) => (
            <button key={v} role="tab" aria-selected={tab === v} className={tab === v ? 'active' : ''} onClick={() => setTab(v)}>{label}</button>
          ))}
        </div>
      </div>
      {tab === 'playlists' && <PlaylistsView show={show} />}
      {tab === 'schedule' && <ScheduleView show={show} />}
      {tab === 'scenes' && (<>
      <div className="scene-tools">
        <button className="btn small" onClick={() => void actions.create()}>+ New</button>
        <button className="btn small ghost" disabled={!selected} onClick={() => void actions.duplicate()}>Duplicate</button>
        <button className="btn small ghost danger-quiet" disabled={!selected || selected === stageName} title={selected === stageName ? 'The scene on stage can’t be deleted' : undefined}
          onClick={() => selected && void actions.remove(selected)}>Delete</button>
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
        <label className="fade-row">
          <span>Fade</span>
          <select value={String(status.output.transition ?? 1)} aria-label="Crossfade time for Go"
            onChange={(e) => api.setOutput({ transition: Number(e.target.value) }).then(show.refresh).catch(show.reportError)}>
            {[0, 0.5, 1, 2, 3, 5].map((v) => <option key={v} value={String(v)}>{v === 0 ? 'Cut' : `${v} s`}</option>)}
          </select>
        </label>
        <button className="btn go" disabled={!selected || going || isOnStage} onClick={go}>
          {going ? 'Sending…' : isOnStage ? 'On stage' : <>Go <span className="go-target">{selected}</span></>}
        </button>
      </div>
      </>)}
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
    // Palette-based effects (most WLED ones): show the palette's colours.
    const pal = def?.params.find((p) => p.type === 'palette');
    if (pal && typeof params[pal.key] === 'string') for (const c of paletteColors(params[pal.key] as string, params, 5)) if (!colors.includes(c)) colors.push(c);
  }
  const stops = colors.length ? colors.slice(0, 6) : ['#2a3142'];
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
