import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { buildLayout, type LayoutConfig } from '@xmas/engine';
import { api } from './api';
import { History, type SceneEditor } from './editor';
import { useDialog } from './Dialog';
import { useSceneFlow } from './sceneFlow';
import { appendPoint, setPoint } from './layoutOps';
import { LayoutPanel } from './LayoutPanel';
import { SelectPanel } from './SelectPanel';
import { PaintPanel, usePaint } from './PaintPanel';
import { PaintOverlay } from './PaintOverlay';
import { SelectionOverlay, type SelectTool } from './SelectionOverlay';
import type { SelectMode, Selection } from './selection';
import { EditorPanel } from './EditorPanel';
import { BackupPanel } from './BackupPanel';
import { HousePanel } from './HousePanel';
import { ControlPanel, type ControlTab } from './ControlPanel';
import { HomePanel, WledPanel } from './SetupPanels';
import { Preview, type CameraPreset } from './Preview';
import { useSceneEditor, type EditMode } from './useSceneEditor';
import { MapScreen } from './mapping/MapScreen';
import { MapReviewPanel, useMapReview } from './mapping/MapReviewPanel';
import { useMappingViews, useRunRoles } from './mapping/review';
import { useShow, type Show } from './useShow';
import { parseHash, routeHash, toolForKey, typingTarget, type CreateTool, type Page, type Route, type SetupTool } from './routes';
import {
  BlackoutButton, Brightness, CameraMenu, Health, HoldToPeek, ModeLight, MoreMenu, PageSwitch, ScenePicker, StagePill, StreamingSwitch,
} from './chrome';
import { FullScreenIcon, PanelIcon, RedoIcon, RevertIcon, StopIcon, ToolIcon, UndoIcon, type ToolIconName } from './icons';
import type { WorkingCopy } from './workingCopy';
import type { SceneFlow } from './sceneFlow';

interface RailTool<T extends string> { id: T; label: string; short: string; key?: string; icon: ToolIconName }

const CREATE_RAIL: { title: string; tools: RailTool<CreateTool>[] }[] = [
  { title: 'View', tools: [{ id: 'move', label: 'Move the view', short: 'Move', key: 'V', icon: 'move' }] },
  { title: 'Light', tools: [
    { id: 'select', label: 'Select lights', short: 'Select', key: 'M', icon: 'select' },
    { id: 'brush', label: 'Paint brush', short: 'Brush', key: 'B', icon: 'brush' },
    { id: 'erase', label: 'Eraser', short: 'Eraser', key: 'E', icon: 'erase' },
  ] },
];
const SETUP_RAIL: { title: string; tools: RailTool<SetupTool>[] }[] = [
  { title: 'Setup', tools: [
    { id: 'strings', label: 'Strings on the house', short: 'Strings', icon: 'strings' },
    { id: 'house', label: 'House model', short: 'House', icon: 'house' },
    { id: 'map', label: 'Map lights with the camera', short: 'Map', icon: 'map' },
    { id: 'wled', label: 'WLED controllers', short: 'WLED', icon: 'wled' },
    { id: 'backups', label: 'Backups', short: 'Backups', icon: 'backups' },
    { id: 'home', label: 'Home Assistant and location', short: 'Home', icon: 'home' },
  ] },
];

export function App() {
  const show = useShow();
  const { layout, scenes, status, stage } = show;
  const [route, navigate] = useRoute();
  const page = route.page;
  const phone = usePhone();
  const panel = usePanelShown();

  // The scene in the working copy (Create edits it; Control's Edit opens one).
  const [selected, setSelected] = useState<string | null>(null);
  const stageName = status?.stage.scene ?? null;
  useEffect(() => { if (selected === null && status) setSelected(stageName ?? scenes[0]?.name ?? null); }, [selected, status, stageName, scenes]);

  const [mode, setMode] = useState<EditMode>('blind');
  const [tool, setTool] = useState<CreateTool>('move');
  const [controlTab, setControlTab] = useState<ControlTab>('scenes');
  const [preset, setPreset] = useState<{ name: CameraPreset; nonce: number }>({ name: 'angle', nonce: 0 });
  const pickCamera = (v: CameraPreset) => setPreset((p) => ({ name: v, nonce: p.nonce + 1 }));
  const [peek, setPeek] = useState(false);
  const paint = usePaint();
  const [selection, setSelection] = useState<Selection>(() => new Set());
  const [selectTool, setSelectTool] = useState<SelectTool>('box');
  const [selectModeKind, setSelectModeKind] = useState<SelectMode>('replace');
  const [brushSize, setBrushSize] = useState(24);
  const [projector, setProjector] = useState<{ fn: () => Float32Array } | null>(null);
  const onProjector = useCallback((p: (() => Float32Array) | null) => setProjector(p ? { fn: p } : null), []);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const dialog = useDialog();
  const work = useSceneEditor(show, selected, mode, setSelected);
  const editor = work.wc;
  const flow = useSceneFlow(show, work, dialog.ask, setSelected);

  const creating = page === 'create';
  const setupTool = route.setupTool;
  const painting = creating && (tool === 'brush' || tool === 'erase');
  const selecting = creating && tool === 'select';
  const layoutMode = page === 'setup' && setupTool === 'strings' && !route.capture;
  const reviewing = page === 'setup' && setupTool === 'map' && !route.capture;
  /** The rail shows Brush or Eraser lit, following the paint panel's own tool switch. */
  const railTool: CreateTool = painting ? (paint.tool === 'erase' ? 'erase' : 'brush') : tool;

  /**
   * Change Create's tool. Brush and Eraser start a new blank canvas (asking first about unsaved
   * edits), unless the working copy already is a new scene that has never been stored.
   */
  const pickTool = async (want: CreateTool) => {
    const isPaint = (t: CreateTool) => t === 'brush' || t === 'erase';
    if (isPaint(want) && !isPaint(tool) && !editor.neverStored) { if (!(await flow.startNew('Painting'))) return; }
    if (want === 'brush') paint.setTool('paint');
    if (want === 'erase') paint.setTool('erase');
    setDrawing(false);
    setTool(want);
  };
  const pickToolRef = useRef(pickTool);
  pickToolRef.current = pickTool;

  // Shortcuts on Create: V M B E pick tools, Esc goes back to Move, Space held shows the porch (Blind).
  useEffect(() => {
    if (!creating) return;
    const dialogOpen = () => !!document.querySelector('[role="dialog"][aria-modal="true"]');
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || dialogOpen()) return;
      const t = e.target as HTMLElement | null;
      if (typingTarget(t)) return;
      if (e.key === 'Escape') { if (tool !== 'move') void pickToolRef.current('move'); return; }
      if (e.key === ' ' && mode === 'blind') {
        // Space on a focused button presses it; anywhere else it's "hold to see the porch".
        if (t?.closest('button, a, select, [role="radio"], [role="switch"], input')) return;
        e.preventDefault();
        if (!e.repeat) setPeek(true);
        return;
      }
      const want = toolForKey(e.key);
      if (want && !e.repeat) { e.preventDefault(); void pickToolRef.current(want); }
    };
    const onUp = (e: KeyboardEvent) => { if (e.key === ' ') setPeek(false); };
    const onBlur = () => setPeek(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onUp); window.removeEventListener('blur', onBlur); };
  }, [creating, tool, mode]);
  useEffect(() => { if (!creating || mode === 'live') setPeek(false); }, [creating, mode]);
  // Esc stops drawing points in Strings.
  useEffect(() => {
    if (!layoutMode || !drawing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !typingTarget(e.target as HTMLElement)) setDrawing(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [layoutMode, drawing]);
  // [ and ] make the brush smaller and bigger while painting.
  const { brush: paintBrush, setBrush: setPaintBrush } = paint;
  useEffect(() => {
    if (!painting) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== '[' && e.key !== ']') || e.metaKey || e.ctrlKey) return;
      if ((e.target as HTMLElement | null)?.closest('input:not([type="range"]), textarea, select')) return;
      setPaintBrush({ ...paintBrush, size: Math.max(6, Math.min(160, Math.round(paintBrush.size * (e.key === ']' ? 1.2 : 1 / 1.2)))) });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [painting, paintBrush, setPaintBrush]);

  const layoutDraft = useLayoutDraft(layout);
  const shownLayout = useLastValidLayout(layoutMode ? layoutDraft.value : layout);
  useHistoryKeys(creating ? editor : layoutMode ? layoutDraft : null);

  // Space the panels and bars take from the 3D view, so it centres in what's left.
  const ready = !!layout && !!status && !route.capture;
  const relayout = `${page}.${tool}.${setupTool}.${panel.shown}.${phone}.${controlTab}`;
  const railInset = useInset('.rail', 'left', ready && !phone && page !== 'watch', relayout);
  const panelInset = useInset('.editor', 'right', ready && !phone && page !== 'watch', relayout);
  const topInset = useInset(phone ? '.topbar, .phone-mode, .porch-card' : '.topbar', 'top', ready && page !== 'watch', relayout);
  const bottomInset = useInset(phone ? '.editor, .rail, .view-tools, .panel-show' : '.view-tools, .health', 'bottom', ready && page !== 'watch', relayout);

  // Camera mapping: the filming screen (#map, or #map-demo with a simulated camera).
  const [mapDemo] = useState(() => route.demo);
  const layoutPixels = useMemo(() => (layout ? buildLayout(layout).count : 0), [layout]);
  const [runRoles, setRunRole] = useRunRoles();
  const mapViews = useMappingViews(mapDemo, layoutPixels, show.reportError);
  const mapReview = useMapReview(show, mapViews, runRoles, reviewing);
  const openFilming = async () => { if (await flow.leave()) navigate({ ...route, page: 'setup', setupTool: 'map', capture: true, demo: mapDemo }); };
  const toSetup = (t: SetupTool) => { setDrawing(false); navigate({ ...route, page: 'setup', setupTool: t, capture: false }, true); };
  const toPage = (p: Page) => navigate({ ...route, page: p, capture: false });

  const editScene = async (name: string) => { if (!(await flow.open(name))) return; setTool('move'); toPage('create'); };
  const newScene = async () => { await flow.create(); if (!editor.neverStored) return; setTool('move'); toPage('create'); };
  const fullScreen = () => {
    document.documentElement.requestFullscreen?.().catch(() => { /* not allowed here: the page still fills the window */ });
    toPage('watch');
  };
  useEffect(() => { if (page !== 'watch' && document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); }, [page]);

  if (show.needsToken) return <TokenGate />;
  if (!layout || !status || !shownLayout) return <Loading show={show} />;
  // Filming: only the camera screen (no 3D view rendering behind it, which would cost battery and frames).
  if (route.capture) {
    return (
      <div className="app">
        <MapScreen show={show} demo={mapDemo} views={mapViews} roles={runRoles} onClose={() => toSetup('map')} onReview={() => toSetup('map')} />
        {show.error && <div className="toast" role="alert"><span>{show.error}</span><button className="btn ghost small" onClick={show.clearError}>Dismiss</button></div>}
      </div>
    );
  }

  const selectedScene = scenes.find((s) => s.name === selected) ?? null;
  // Create shows the working copy (edits appear at once, before any save); held Peek, and the other pages, show the stage.
  const working = editor.scene.name === selected ? editor.scene : selectedScene;
  const shownScene = creating && !peek ? working : stage;
  const previewLayout = reviewing && mapReview.showMapped && mapReview.candidate ? mapReview.candidate : shownLayout;
  const hidePanel = panel.shown ? () => panel.set(false) : undefined;

  if (page === 'watch') return <WatchPage show={show} preset={preset} onCamera={pickCamera} onExit={() => toPage('control')} layout={shownLayout} />;

  const appClass = ['app', `page-${page}`, mode === 'live' && creating ? 'live-armed' : '', phone ? 'phone' : 'desk', panel.shown ? '' : 'panel-hidden'].filter(Boolean).join(' ');

  return (
    <div className={appClass} style={{ ['--inset-l' as string]: `${railInset}px`, ['--inset-r' as string]: `${panelInset}px` }}>
      <Preview layout={previewLayout} scene={shownScene} diagnostic={reviewing} markers={reviewing ? mapReview.markers : null} clock={show.clock} preset={preset}
        leftInset={railInset} rightInset={panelInset} topInset={topInset} bottomInset={bottomInset} house={show.house}
        selection={selecting && !peek ? selection : null} onProjector={(selecting || painting) ? onProjector : undefined}
        layoutEdit={layoutMode ? {
          selected: selectedRun, drawing,
          onAddPoint: (p) => { if (selectedRun) layoutDraft.edit(appendPoint(layoutDraft.value, selectedRun, p)); },
          onMovePoint: (i, p, done) => {
            if (!selectedRun) return;
            if (done) layoutDraft.endGesture();
            else layoutDraft.edit(setPoint(layoutDraft.value, selectedRun, i, p), { merge: `${selectedRun}.drag${i}` });
          },
        } : null} />

      {/* The drawing layers cover the 3D view only: panels come after them, so they stay clickable. */}
      {selecting && !peek && projector && (
        <SelectionOverlay tool={selectTool} mode={selectModeKind} brushSize={brushSize} project={projector.fn} layoutConfig={layout} selection={selection} onChange={setSelection} />
      )}
      {painting && !peek && projector && editor.scene.name && (
        <PaintOverlay tool={paint.tool} brush={paint.brush} look={paint.look} tint={paint.source === 'color' ? paint.color : null} project={projector.fn} editor={editor} count={layoutPixels} />
      )}

      <header className="topbar glass">
        <ModeLight page={page} mode={mode} compact={phone} />
        <PageSwitch page={page} onPage={toPage} compact={phone} />
        {creating
          ? <CreateBar show={show} editor={editor} flow={flow} mode={mode} onMode={setMode} selected={selected} phone={phone} onFullScreen={fullScreen} onBackups={() => toSetup('backups')} />
          : <ShowBar show={show} phone={phone} onFullScreen={fullScreen} onBackups={() => toSetup('backups')} />}
      </header>

      {creating && <Rail label="Tools" sections={CREATE_RAIL} value={railTool} onPick={(t) => void pickTool(t)} />}
      {page === 'setup' && <Rail label="Setup tools" sections={SETUP_RAIL} value={setupTool} onPick={toSetup} />}

      {panel.shown && (
        creating ? (
          selecting
            ? <SelectPanel show={show} selection={selection} onSelection={setSelection} tool={selectTool} onTool={setSelectTool}
                mode={selectModeKind} onMode={setSelectModeKind} brushSize={brushSize} onBrushSize={setBrushSize} onHide={hidePanel} />
            : painting
            ? <PaintPanel show={show} editor={editor} paint={paint} mode={mode} onHide={hidePanel} />
            : <EditorPanel show={show} editor={editor} flow={flow} mode={mode} onHide={hidePanel} />
        ) : page === 'control' ? (
          <ControlPanel show={show} flow={flow} editor={editor} ask={dialog.ask} tab={controlTab} onTab={setControlTab}
            onEdit={(n) => void editScene(n)} onNew={() => void newScene()} onHide={hidePanel} />
        ) : setupTool === 'strings' ? (
          <LayoutPanel show={show} draft={layoutDraft} onHide={hidePanel} selected={selectedRun} onSelect={(id) => { setSelectedRun(id); setDrawing(false); }} drawing={drawing} onDrawingChange={setDrawing} />
        ) : setupTool === 'house' ? <HousePanel show={show} onHide={hidePanel} />
          : setupTool === 'map' ? <MapReviewPanel show={show} review={mapReview} views={mapViews} roles={runRoles} setRole={setRunRole} layoutDraft={layoutDraft} onCamera={() => void openFilming()} onHide={hidePanel} />
          : setupTool === 'wled' ? <WledPanel show={show} onHide={hidePanel} />
          : setupTool === 'backups' ? <BackupPanel show={show} onHide={hidePanel} />
          : <HomePanel show={show} onHide={hidePanel} onSchedule={() => { setControlTab('schedule'); toPage('control'); }} />
      )}
      {!panel.shown && (
        <button className="panel-show glass" aria-label="Show the panel" title="Show the panel" onClick={() => panel.set(true)}><PanelIcon shown={false} /></button>
      )}

      {page === 'control' && <PorchCard show={show} onFullScreen={fullScreen} />}
      {creating && phone && <PhoneModeRow show={show} editor={editor} flow={flow} mode={mode} onMode={setMode} selected={selected} />}

      <div className="view-tools glass" role="toolbar" aria-label="3D view">
        {creating && mode === 'blind' && <HoldToPeek peeking={peek} onPeek={setPeek} />}
        <CameraMenu value={preset.name} onPick={pickCamera} />
      </div>

      {peek
        ? <div className="caption peek-label" role="status">Showing the porch while you hold</div>
        : <Caption page={page} show={show} selected={selected} editor={editor} mode={mode} tool={tool} paintTool={paint.tool} hasLook={!!paint.look}
            selectTool={selectTool} selectionSize={selection.size} setupTool={setupTool} drawing={drawing} showMapped={mapReview.showMapped} />}
      {!phone && <Health show={show} />}
      {!show.connected && <div className="banner warn" role="status">Lost connection to the lights server. Retrying…</div>}
      {show.error && (
        <div className="toast" role="alert">
          <span>{show.error}</span>
          <button className="btn ghost small" onClick={show.clearError}>Dismiss</button>
        </div>
      )}
      {dialog.element}
    </div>
  );
}

// ---- top bars ---------------------------------------------------------------------------------------

interface CreateBarProps {
  show: Show; editor: WorkingCopy; flow: SceneFlow; mode: EditMode; onMode: (m: EditMode) => void; selected: string | null;
  phone: boolean; onFullScreen: () => void; onBackups: () => void;
}

/** Create's top bar: the scene being edited and saving it, Blind/Live and Go, what's on stage, Blackout and ⋯. */
function CreateBar({ show, editor, flow, mode, onMode, selected, phone, onFullScreen, onBackups }: CreateBarProps) {
  const dirty = editor.dirty;
  const name = editor.scene.name;
  const revertDisabled = !dirty || (editor.neverStored && editor.scene.layers.length === 0);
  const sceneGroup = (
    <div className="scene-group">
      <ScenePicker show={show} name={name} unsaved={dirty} onOpen={(n) => void flow.open(n)} />
      {dirty && <span className="unsaved-mark" title={editor.neverStored ? 'This new scene isn’t saved yet' : 'Changes not saved yet'}><span className="unsaved-dot" aria-hidden />{editor.neverStored ? 'Not saved' : 'Unsaved'}</span>}
      <button className="btn small primary" disabled={!dirty} onClick={() => void flow.save()} title={editor.neverStored ? 'Store this new scene (asks for a name)' : 'Store the changes over the saved scene'}>Save</button>
      {!phone && <>
        <button className="btn small ghost" disabled={!dirty} onClick={() => void flow.saveAsNew()} title="Store a copy under a new name; the saved scene stays as it was">Save as new…</button>
        <button className="icon-btn bar-icon" aria-label="Revert" disabled={revertDisabled} onClick={() => void flow.revert()}
          title={editor.neverStored ? 'Clear it back to a blank scene' : 'Revert: throw the changes away and go back to the saved scene'}><RevertIcon /></button>
        <button className="icon-btn bar-icon" onClick={() => editor.undo()} disabled={!editor.canUndo} aria-label="Undo" title="Undo (⌘Z)"><UndoIcon /></button>
        <button className="icon-btn bar-icon" onClick={() => editor.redo()} disabled={!editor.canRedo} aria-label="Redo" title="Redo (⇧⌘Z)"><RedoIcon /></button>
      </>}
    </div>
  );
  return (
    <>
      {sceneGroup}
      {!phone && <>
        <div className="spacer" />
        <ModeSwitch mode={mode} onMode={onMode} />
        <GoButton show={show} editor={editor} flow={flow} selected={selected} />
        <div className="spacer" />
        <StagePill show={show} />
        <BlackoutButton show={show} />
      </>}
      <MoreMenu>
        {(close) => (
          <>
            {phone && (
              <div className="more-row">
                <button className="btn small ghost" disabled={!dirty} onClick={() => { close(); void flow.saveAsNew(); }}>Save as new…</button>
                <button className="btn small ghost" disabled={revertDisabled} onClick={() => { close(); void flow.revert(); }}>Revert</button>
              </div>
            )}
            <Brightness show={show} />
            <StreamingSwitch show={show} />
            {phone && <div className="more-row"><StagePill show={show} /><BlackoutButton show={show} /></div>}
            <button className="menu-item" onClick={() => { close(); onFullScreen(); }}><FullScreenIcon /> Full-screen display</button>
            <button className="menu-item" onClick={() => { close(); onBackups(); }}>Backups…</button>
          </>
        )}
      </MoreMenu>
    </>
  );
}

/** Control's and Setup's top bar: brightness, streaming, Blackout and ⋯. */
function ShowBar({ show, phone, onFullScreen, onBackups }: { show: Show; phone: boolean; onFullScreen: () => void; onBackups: () => void }) {
  return (
    <>
      {!phone && <StagePill show={show} />}
      <div className="spacer" />
      {!phone && <>
        <Brightness show={show} />
        <StreamingSwitch show={show} />
      </>}
      <BlackoutButton show={show} />
      <MoreMenu>
        {(close) => (
          <>
            {phone && <><StagePill show={show} /><Brightness show={show} /><StreamingSwitch show={show} /></>}
            <button className="menu-item" onClick={() => { close(); onFullScreen(); }}><FullScreenIcon /> Full-screen display</button>
            <button className="menu-item" onClick={() => { close(); onBackups(); }}>Backups…</button>
          </>
        )}
      </MoreMenu>
    </>
  );
}

function ModeSwitch({ mode, onMode }: { mode: EditMode; onMode: (m: EditMode) => void }) {
  const live = mode === 'live';
  return (
    <div className="segmented mode" role="radiogroup" aria-label="Edit mode">
      <button role="radio" aria-checked={!live} className={!live ? 'active blind' : ''} onClick={() => onMode('blind')}
        title="Blind: edits stay in this browser until you save. The porch doesn’t change.">Blind</button>
      <button role="radio" aria-checked={live} className={live ? 'active live' : ''} onClick={() => onMode('live')}
        title="Live: the porch shows the scene you’re editing as you edit it. Nothing is stored until you save.">Live</button>
    </div>
  );
}

/** Go: put the scene being edited (its stored version) on the porch. */
function GoButton({ show, editor, flow, selected }: { show: Show; editor: WorkingCopy; flow: SceneFlow; selected: string | null }) {
  const [going, setGoing] = useState(false);
  const st = show.status!.stage;
  const isOnStage = selected !== null && selected === st.scene && !st.dirty && !st.preview;
  const newSelected = editor.neverStored && selected === editor.name;
  const go = async () => {
    if (!selected || !(await flow.confirmGo(selected))) return;
    setGoing(true);
    try { await api.go(selected); await show.refresh(); } catch (e) { show.reportError(e); }
    setGoing(false);
  };
  return (
    <button className="btn go-small" aria-label={selected ? `Go ${selected}` : 'Go'} disabled={!selected || going || isOnStage || newSelected}
      title={newSelected ? 'Save this scene first: Go plays stored scenes' : isOnStage ? 'On stage now' : `Put ${selected} on the porch`} onClick={() => void go()}>
      {going ? '…' : 'Go'}
    </button>
  );
}

/** On a phone: Blind/Live, Go, Undo and Redo sit on the 3D view under the top bar. */
function PhoneModeRow({ show, editor, flow, mode, onMode, selected }: { show: Show; editor: WorkingCopy; flow: SceneFlow; mode: EditMode; onMode: (m: EditMode) => void; selected: string | null }) {
  return (
    <div className="phone-mode">
      <ModeSwitch mode={mode} onMode={onMode} />
      <GoButton show={show} editor={editor} flow={flow} selected={selected} />
      <div className="spacer" />
      <button className="icon-btn bar-icon glass" onClick={() => editor.undo()} disabled={!editor.canUndo} aria-label="Undo"><UndoIcon /></button>
      <button className="icon-btn bar-icon glass" onClick={() => editor.redo()} disabled={!editor.canRedo} aria-label="Redo"><RedoIcon /></button>
    </div>
  );
}

// ---- the tool rail ----------------------------------------------------------------------------------

/** Tools with section headers, down the left side (a strip along the bottom on a phone). */
function Rail<T extends string>({ label, sections, value, onPick }: { label: string; sections: { title: string; tools: RailTool<T>[] }[]; value: T; onPick: (t: T) => void }) {
  return (
    <nav className="rail glass" aria-label={label}>
      {sections.map((sec) => (
        <div key={sec.title} className="rail-section" role="group" aria-label={sec.title}>
          <span className="rail-title" aria-hidden>{sec.title}</span>
          {sec.tools.map((t) => (
            <button key={t.id} className={`rail-btn ${t.id === value ? 'active' : ''}`} aria-pressed={t.id === value} aria-label={t.short}
              title={`${t.label}${t.key ? ` (${t.key})` : ''}`} onClick={() => onPick(t.id)}>
              <ToolIcon name={t.icon} />
              <span className="rail-short" aria-hidden>{t.short}</span>
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

// ---- on the 3D view --------------------------------------------------------------------------------

/** Control: what's on the porch now, the playlist's next change, and the full-screen display. */
function PorchCard({ show, onFullScreen }: { show: Show; onFullScreen: () => void }) {
  const s = show.status!;
  const pl = s.playlist;
  const now = useNow(!!pl?.nextAt);
  const on = s.stage.preview ?? s.stage.scene;
  return (
    <section className="porch-card glass" aria-label="On the porch">
      <span className="eyebrow">{s.output.enabled ? 'Live on the porch' : 'Streaming off: the porch runs its WLED playlist'}</span>
      <strong className="porch-scene">{on ?? 'Blackout'}{s.stage.preview ? ' (unsaved edits)' : ''}</strong>
      {pl && (
        <span className="porch-playlist">
          Playlist {pl.name}{pl.nextAt ? ` · next in ${clockTime(pl.nextAt - now)}` : ''}
        </span>
      )}
      <div className="porch-actions">
        {pl && <button className="btn small" onClick={() => api.stopPlaylist().then(show.refresh).catch(show.reportError)}><StopIcon /> Stop playlist</button>}
        <button className="btn small ghost porch-full" onClick={onFullScreen}><FullScreenIcon /> Full-screen display</button>
      </div>
    </section>
  );
}

/** A full-screen live view of the porch, for a tablet or a TV: no editing controls. */
function WatchPage({ show, layout, preset, onCamera, onExit }: { show: Show; layout: LayoutConfig; preset: { name: CameraPreset; nonce: number }; onCamera: (v: CameraPreset) => void; onExit: () => void }) {
  const s = show.status!;
  const on = s.stage.preview ?? s.stage.scene;
  const [idle, setIdle] = useState(false);
  // The controls fade out after a few seconds without a touch or a move, so only the porch shows.
  useEffect(() => {
    let t = setTimeout(() => setIdle(true), 4000);
    const wake = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 4000); };
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => { clearTimeout(t); window.removeEventListener('pointermove', wake); window.removeEventListener('pointerdown', wake); window.removeEventListener('keydown', wake); };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onExit(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);
  return (
    <div className={`app page-watch ${idle ? 'idle' : ''}`}>
      <Preview layout={layout} scene={show.stage} clock={show.clock} preset={preset} house={show.house} />
      <div className="watch-card glass" role="status">
        <ModeLight page="watch" mode="blind" compact />
        <span className="watch-scene">{s.output.enabled ? on ?? 'Blackout' : 'Streaming off'}</span>
        {s.playlist && <span className="muted">Playlist {s.playlist.name}</span>}
      </div>
      <div className="watch-tools">
        <div className="view-tools glass"><CameraMenu value={preset.name} onPick={onCamera} /></div>
        <button className="btn small glass" onClick={onExit}>Exit</button>
      </div>
      {!show.connected && <div className="banner warn" role="status">Lost connection to the lights server. Retrying…</div>}
    </div>
  );
}

function Caption({ page, show, selected, editor, mode, tool, paintTool, hasLook, selectTool, selectionSize, setupTool, drawing, showMapped }: {
  page: Page; show: Show; selected: string | null; editor: WorkingCopy; mode: EditMode; tool: CreateTool; paintTool: string; hasLook: boolean;
  selectTool: SelectTool; selectionSize: number; setupTool: SetupTool; drawing: boolean; showMapped: boolean;
}) {
  const status = show.status!;
  let text: string | null = null;
  let cls = '';
  if (page === 'create') {
    const onPorch = selected !== null && selected === (status.stage.preview ?? status.stage.scene);
    const live = mode === 'live';
    const porch = live ? (status.output.enabled ? ' · showing on the porch' : ' · streaming is off') : '';
    if (tool === 'select') text = selectTool === 'orbit' ? 'Select: Move tool, drag to turn the view' : `Select: ${selectTool === 'brush' ? 'paint over lights' : selectTool === 'lasso' ? 'draw around lights' : selectTool === 'string' ? 'tap a string to pick all its lights' : 'drag a box around lights'} · ${selectionSize} selected`;
    else if (tool === 'brush' || tool === 'erase') text = `${paintTool === 'orbit' ? 'Paint: Move tool, drag to turn the view' : paintTool === 'erase' ? 'Eraser: drag over lights to wipe paint off' : hasLook ? 'Brush: drag over the lights' : 'Brush: choose an effect first'}${porch}`;
    else if (selected) text = live ? `Live: ${selected}${porch}` : `Blind: ${selected}${editor.dirty && editor.name === selected ? ' · unsaved changes' : ''}${onPorch ? '' : ' (not on the porch)'}`;
    cls = 'layout';
  } else if (page === 'setup') {
    if (setupTool === 'strings') text = drawing ? 'Drawing: tap on the house to add points to the end of the run' : 'Strings: drag the white handles; green is the start of the run, red the end';
    else if (setupTool === 'map') text = `Mapping results: ${showMapped ? 'with the measured positions (not saved yet)' : 'the layout as saved'}`;
    cls = 'layout';
  }
  if (!text) return null;
  return <div className={`caption ${cls}`} role="status">{text}</div>;
}

// ---- hooks ------------------------------------------------------------------------------------------

/** The page in the address (#/create, #/control, #/setup/…, #/watch), kept in step with Back and Forward. */
function useRoute(): [Route, (r: Route, replace?: boolean) => void] {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', on);
    window.addEventListener('popstate', on);
    return () => { window.removeEventListener('hashchange', on); window.removeEventListener('popstate', on); };
  }, []);
  const go = useCallback((r: Route, replace = false) => {
    const hash = routeHash(r);
    if (location.hash !== hash) {
      const url = `${location.pathname}${location.search}${hash}`;
      if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url);
    }
    setRoute(r);
  }, []);
  return [route, go];
}

/** True on phone-sized screens, where the panel becomes a bottom sheet and the rail a strip. */
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

/** Whether the right-hand panel is shown, remembered on this device. */
function usePanelShown() {
  const KEY = 'xmas.panel';
  const [shown, setShown] = useState<boolean>(() => {
    try { return localStorage.getItem(KEY) !== 'hidden'; } catch { return true; }
  });
  const set = (v: boolean) => {
    setShown(v);
    try { localStorage.setItem(KEY, v ? 'shown' : 'hidden'); } catch { /* private mode */ }
  };
  return { shown, set };
}

/**
 * How much of the window the elements matching `selector` cover from one edge (plus a margin),
 * tracked through resizes. `key` re-measures when the layout changes (another page, tool or panel).
 */
function useInset(selector: string, side: 'left' | 'right' | 'top' | 'bottom', ready: boolean, key: string) {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!ready) { setInset(0); return; }
    const measure = () => {
      let v = 0;
      for (const el of document.querySelectorAll(selector)) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        v = Math.max(v, side === 'left' ? r.right + 12 : side === 'right' ? window.innerWidth - r.left + 12
          : side === 'top' ? r.bottom + 8 : window.innerHeight - r.top + 8);
      }
      setInset(Math.round(v));
    };
    measure();
    const raf = requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    for (const el of document.querySelectorAll(selector)) ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [selector, side, ready, key]);
  return inset;
}

/** The time now, ticking each second while `on` (for countdowns). */
function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

const clockTime = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

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

/**
 * The layout for the 3D view. While numbers are being typed in Strings the draft is often invalid
 * for a moment (a count past the end of the controller, two runs overlapping); the view then keeps
 * the last layout that worked instead of failing. The Strings panel shows what's wrong.
 */
function useLastValidLayout(layout: LayoutConfig | null): LayoutConfig | null {
  const last = useRef<LayoutConfig | null>(null);
  return useMemo(() => {
    if (!layout) return last.current;
    try { buildLayout(layout); last.current = layout; } catch { /* keep the last good one */ }
    return last.current;
  }, [layout]);
}

/** ⌘Z / Ctrl+Z undo, ⇧⌘Z / Ctrl+Y redo, unless typing in a text field. Null: nothing to undo on this page. */
function useHistoryKeys(editor: History<unknown> | SceneEditor | null) {
  useEffect(() => {
    if (!editor) return;
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

/** Shown when the server wants its API token: ask once, then the browser remembers (a cookie). */
function TokenGate() {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { await api.login(token.trim()); location.reload(); }
    catch { setError('That token was not accepted.'); setBusy(false); }
  };
  return (
    <form className="loading" onSubmit={submit}>
      <p>This lights server asks for its access token (XMAS_API_TOKEN on the server).</p>
      <div className="row">
        <input className="text" type="password" autoFocus autoComplete="current-password" aria-label="Access token" value={token} onChange={(e) => setToken(e.target.value)} />
        <button className="btn" disabled={busy || !token.trim()}>Sign in</button>
      </div>
      {error && <p className="hint" role="alert">{error}</p>}
    </form>
  );
}

function Loading({ show }: { show: Show }) {
  return (
    <div className="loading">
      <div className="loading-dot" aria-hidden />
      <p>{show.error ? `Can't reach the lights server: ${show.error}` : 'Connecting to the lights…'}</p>
    </div>
  );
}
