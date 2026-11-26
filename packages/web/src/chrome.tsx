import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EFFECTS, paletteColors, resolveParams, type SceneConfig } from '@xmas/engine';
import { api } from './api';
import { CameraViewIcon, ChevronDown, MoreIcon, PeekIcon, SearchIcon, ToolIcon } from './icons';
import { latestWins } from './latest';
import type { CameraPreset } from './Preview';
import { modeLight, type Page } from './routes';
import type { EditMode } from './useSceneEditor';
import type { Show } from './useShow';

// ---- the mode light and the page switch -----------------------------------------------------------

/** The light at the top left: its colour and name say which mode the app is in. */
export function ModeLight({ page, mode, compact }: { page: Page; mode: EditMode; compact?: boolean }) {
  const { tone, label } = modeLight(page, mode);
  return (
    <span className={`mode-light tone-${tone}`} role="status" aria-label={`Mode: ${label}`} title={`Mode: ${label}`} data-tone={tone}>
      <span className="mode-dot" aria-hidden />
      <span className={`mode-name ${compact ? 'visually-hidden' : ''}`}>{label}</span>
    </span>
  );
}

const PAGES: { page: Page; label: string; hint: string }[] = [
  { page: 'create', label: 'Create', hint: 'Design scenes' },
  { page: 'control', label: 'Control', hint: 'Run the porch' },
  { page: 'setup', label: 'Setup', hint: 'Strings, house, mapping, controllers, backups' },
];

/** Create · Control · Setup. On a phone it folds into a menu showing the current page. */
export function PageSwitch({ page, onPage, compact }: { page: Page; onPage: (p: Page) => void; compact?: boolean }) {
  if (compact) {
    return (
      <Popover label="Pages" className="page-menu" trigger={(p) => (
        <button className="page-menu-btn" {...p} aria-label={`Page: ${PAGES.find((x) => x.page === page)?.label}. Switch page`}>
          {PAGES.find((x) => x.page === page)?.label}<ChevronDown />
        </button>
      )}>
        {(close) => PAGES.map((p) => (
          <button key={p.page} role="menuitemradio" aria-checked={p.page === page} className={`menu-item ${p.page === page ? 'checked' : ''}`}
            onClick={() => { close(); onPage(p.page); }}>{p.label}<span className="menu-hint">{p.hint}</span></button>
        ))}
      </Popover>
    );
  }
  return (
    <nav className="page-switch" aria-label="Pages">
      {PAGES.map((p) => (
        <a key={p.page} href={`#/${p.page}`} aria-current={p.page === page ? 'page' : undefined} className={p.page === page ? 'active' : ''} title={p.hint}
          onClick={(e) => { e.preventDefault(); onPage(p.page); }}>{p.label}</a>
      ))}
    </nav>
  );
}

// ---- popovers (menus) -------------------------------------------------------------------------------

interface TriggerProps { 'aria-expanded': boolean; 'aria-haspopup': 'menu' | 'dialog'; 'aria-controls': string; onClick: () => void; ref: React.Ref<HTMLButtonElement> }

/**
 * A button that opens a small panel next to it (a menu, the camera views, the scene picker). It
 * closes on a tap outside, Escape (focus goes back to the button) or when an item calls `close`.
 */
export function Popover({ label, trigger, children, className = '', up, align = 'left', kind = 'menu' }: {
  label: string; trigger: (p: TriggerProps) => React.ReactNode; children: (close: () => void) => React.ReactNode;
  className?: string; up?: boolean; align?: 'left' | 'right'; kind?: 'menu' | 'dialog';
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({ visibility: 'hidden' });
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!wrap.current?.contains(t) && !pop.current?.contains(t)) setOpen(false);
    };
    const shut = () => setOpen(false);
    document.addEventListener('pointerdown', away);
    window.addEventListener('resize', shut);
    // Focus the first thing in the panel, so the keyboard works straight away.
    requestAnimationFrame(() => pop.current?.querySelector<HTMLElement>('input, [aria-checked="true"], button:not(:disabled)')?.focus());
    return () => { document.removeEventListener('pointerdown', away); window.removeEventListener('resize', shut); };
  }, [open]);
  // Placed on the page (not inside the panel, whose scrolling would clip it), next to its button and inside the window.
  useLayoutEffect(() => {
    if (!open) { setPos({ visibility: 'hidden' }); return; }
    const r = btn.current?.getBoundingClientRect() ?? wrap.current!.getBoundingClientRect();
    const w = pop.current?.offsetWidth ?? 240;
    const h = pop.current?.offsetHeight ?? 200;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = align === 'right' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    const below = vh - r.bottom - 8, above = r.top - 8;
    const goUp = up ? above >= Math.min(h, 200) || above > below : below < Math.min(h, 200) && above > below;
    const maxHeight = Math.max(120, (goUp ? above : below) - 6);
    setPos(goUp ? { left, bottom: vh - r.top + 6, maxHeight } : { left, top: r.bottom + 6, maxHeight });
  }, [open, up, align]);
  const close = () => { setOpen(false); btn.current?.focus(); };
  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); close(); } };
  return (
    <div className={`popover-wrap ${className}`} ref={wrap} onKeyDown={onKey}>
      {trigger({ 'aria-expanded': open, 'aria-haspopup': kind, 'aria-controls': id, onClick: () => setOpen((o) => !o), ref: btn })}
      {open && createPortal(
        <div ref={pop} id={id} className={`popover glass ${className}-pop`} role={kind} aria-label={label} style={pos} onKeyDown={onKey}>
          {children(close)}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ---- the top bar's controls -----------------------------------------------------------------------

export function StagePill({ show }: { show: Show }) {
  const { stage, output } = show.status!;
  let tone = 'ok', text = `On stage: ${stage.scene}`;
  if (!output.enabled) { tone = 'muted'; text = 'Streaming off · WLED playlist'; }
  else if (stage.preview) { tone = 'warn'; text = `On stage: ${stage.preview} · unsaved edits`; }
  else if (stage.scene === null) { tone = 'muted'; text = 'On stage: Blackout'; }
  else if (stage.dirty) { tone = 'warn'; text = `On stage: ${stage.scene} · edited, not sent`; }
  else if (show.status!.playlist) text = `Playlist ${show.status!.playlist.name}: ${stage.scene}`;
  return <div className={`pill ${tone}`} role="status" title={text}><span className="dot" aria-hidden />{text}</div>;
}

export function Brightness({ show }: { show: Show }) {
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

export function StreamingSwitch({ show }: { show: Show }) {
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

export function BlackoutButton({ show }: { show: Show }) {
  const status = show.status!;
  return (
    <button
      className="btn small blackout"
      disabled={!status.output.enabled || status.stage.scene === null}
      onClick={() => api.blackout().then(show.refresh).catch(show.reportError)}
      title="Turn every pixel off while streaming"
    >
      Blackout
    </button>
  );
}

/** The ⋯ menu at the right of the top bar. */
export function MoreMenu({ children, label = 'More' }: { children: (close: () => void) => React.ReactNode; label?: string }) {
  return (
    <Popover label={label} kind="dialog" align="right" className="more-menu" trigger={(p) => (
      <button className="icon-btn ghost-icon" aria-label={label} title={label} {...p}><MoreIcon /></button>
    )}>
      {(close) => <div className="more-body">{children(close)}</div>}
    </Popover>
  );
}

// ---- on the 3D view -----------------------------------------------------------------------------

export const CAMERA_VIEWS: { value: CameraPreset; label: string; hint: string }[] = [
  { value: 'house', label: 'House', hint: 'The whole house and yard' },
  { value: 'front', label: 'Front', hint: 'The front of the house, straight on' },
  { value: 'close', label: 'Close', hint: 'Close up on the lights' },
  { value: 'angle', label: 'Angle', hint: 'From the front left' },
  { value: 'top', label: 'Top', hint: 'From above' },
];

/** The five camera views in one menu. Picking the current view again puts the camera back on it. */
export function CameraMenu({ value, onPick, up = true }: { value: CameraPreset; onPick: (v: CameraPreset) => void; up?: boolean }) {
  const current = CAMERA_VIEWS.find((v) => v.value === value)!;
  return (
    <Popover label="Camera views" up={up} className="camera-menu" trigger={(p) => (
      <button className="view-btn" aria-label={`Camera view: ${current.label}`} title="Camera view" {...p}>
        <CameraViewIcon />{current.label}<ChevronDown />
      </button>
    )}>
      {(close) => CAMERA_VIEWS.map((v) => (
        <button key={v.value} role="menuitemradio" aria-checked={v.value === value} className={`menu-item ${v.value === value ? 'checked' : ''}`}
          onClick={() => { onPick(v.value); close(); }}>{v.label}<span className="menu-hint">{v.hint}</span></button>
      ))}
    </Popover>
  );
}

/**
 * Hold to see the porch: while held (pointer, touch or keyboard), the 3D view shows what's live
 * instead of the scene being edited.
 */
export function HoldToPeek({ peeking, onPeek }: { peeking: boolean; onPeek: (on: boolean) => void }) {
  const off = () => onPeek(false);
  return (
    <button
      className={`view-btn peek-btn ${peeking ? 'on' : ''}`}
      aria-pressed={peeking}
      title="Hold to see what's on the porch now (Space on a keyboard, with the Move tool)"
      onPointerDown={(e) => { e.preventDefault(); (e.target as Element).setPointerCapture?.(e.pointerId); onPeek(true); }}
      onPointerUp={off} onPointerCancel={off} onLostPointerCapture={off}
      onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); onPeek(true); } }}
      onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') off(); }}
      onBlur={off}
      onContextMenu={(e) => e.preventDefault()}
    >
      <PeekIcon />Hold to see the porch
    </button>
  );
}

/**
 * The round hold-to-move button for touch screens (Space does this on a keyboard): while it's held the
 * view moves like the Move tool (drag with another finger); letting go goes back to Select, Brush or Eraser.
 */
export function HoldToMove({ holding, onHold, back }: { holding: boolean; onHold: (on: boolean) => void; back: string }) {
  const off = () => onHold(false);
  return (
    <button
      className={`hold-move glass ${holding ? 'on' : ''}`}
      aria-pressed={holding}
      aria-label="Hold to move the view"
      title={`Hold to move the view; let go for the ${back} (Space on a keyboard)`}
      onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId); onHold(true); }}
      onPointerUp={off} onPointerCancel={off} onLostPointerCapture={off}
      onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); e.stopPropagation(); onHold(true); } }}
      onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') off(); }}
      onBlur={off}
      onContextMenu={(e) => e.preventDefault()}
    >
      <ToolIcon name="move" />
    </button>
  );
}

// ---- the health line ------------------------------------------------------------------------------

export function Health({ show }: { show: Show }) {
  const s = show.status!.stream;
  const ha = show.status!.homeassistant;
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
      {ha?.enabled && (
        <span className="health-item muted" title={ha.connected ? 'Connected to Home Assistant over MQTT' : 'Cannot reach the MQTT broker; retrying'}>
          <span className={`dot ${ha.connected ? 'ok' : 'bad'}`} aria-hidden />
          Home Assistant {ha.connected ? 'linked' : 'offline'}
        </span>
      )}
    </footer>
  );
}

// ---- scenes ---------------------------------------------------------------------------------------

/** A small strip of the colours a scene uses, so scenes can be told apart at a glance. */
export function Swatch({ scene }: { scene: SceneConfig }) {
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

/** Scenes whose names contain every word typed, in their stored order. */
export function filterScenes<T extends { name: string }>(scenes: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? scenes.filter((s) => words.every((w) => s.name.toLowerCase().includes(w))) : scenes;
}

/** A search box for the scene lists. */
export function SceneSearch({ value, onChange, count }: { value: string; onChange: (v: string) => void; count: number }) {
  return (
    <label className="scene-search">
      <SearchIcon />
      <input type="search" className="search" placeholder={`Search ${count} scenes`} aria-label="Search scenes" value={value}
        onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** The scene being edited, as a button that opens a searchable list of scenes to switch to. */
export function ScenePicker({ show, name, unsaved, onOpen, onNew }: { show: Show; name: string; unsaved: boolean; onOpen: (n: string) => void; onNew: () => void }) {
  const [q, setQ] = useState('');
  const rows = filterScenes(show.scenes, q);
  return (
    <Popover label="Scenes" kind="dialog" className="scene-picker" trigger={(p) => (
      <button className="scene-picker-btn" title="Pick a scene to edit" aria-label={`Editing ${name || 'nothing'}${unsaved ? ', unsaved changes' : ''}. Pick a scene to edit`} {...p}>
        <span className="scene-picker-name">{name || 'Pick a scene'}</span><ChevronDown />
      </button>
    )}>
      {(close) => (
        <>
          <div className="scene-tools picker-tools">
            <SceneSearch value={q} onChange={setQ} count={show.scenes.length} />
            <button className="btn small" onClick={() => { close(); setQ(''); onNew(); }} title="Start a new, blank scene">+ New</button>
          </div>
          <ul className="picker-scenes">
            {rows.map((s) => (
              <li key={s.name}>
                <button className={`scene-row ${s.name === name ? 'selected' : ''}`} aria-current={s.name === name}
                  onClick={() => { close(); setQ(''); onOpen(s.name); }}>
                  <Swatch scene={s} /><span className="scene-name">{s.name}</span>
                </button>
              </li>
            ))}
            {rows.length === 0 && <li className="empty">No scene matches “{q}”.</li>}
          </ul>
        </>
      )}
    </Popover>
  );
}
