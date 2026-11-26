import { useState } from 'react';
import { DEMO } from './demo/flag';
import { api } from './api';
import { filterScenes, Popover, SceneSearch, Swatch } from './chrome';
import type { Ask } from './Dialog';
import { MoreIcon, PencilIcon } from './icons';
import { PanelHead } from './PanelHead';
import type { SceneFlow } from './sceneFlow';
import { PlaylistsView, ScheduleView } from './ShowPanels';
import type { Show } from './useShow';
import type { WorkingCopy } from './workingCopy';
import { nameProblem } from './workingCopy';

export type ControlTab = 'scenes' | 'playlists' | 'schedule';

interface Props {
  show: Show;
  flow: SceneFlow;
  editor: WorkingCopy;
  ask: Ask;
  tab: ControlTab;
  onTab: (t: ControlTab) => void;
  /** Open a scene in Create. */
  onEdit: (name: string) => void;
  /** A new, blank scene in Create. */
  onNew: () => void;
  onHide?: () => void;
}

/** Control's panel: the scenes to Go, the playlists and the nightly schedule. */
/** The library's tabs. The public demo has no nightly schedule. */
const LIBRARY_TABS = ([['scenes', 'Scenes'], ['playlists', 'Playlists'], ['schedule', 'Schedule']] as const).filter(([v]) => !DEMO || v !== 'schedule');

export function ControlPanel({ show, flow, editor, ask, tab, onTab, onEdit, onNew, onHide }: Props) {
  return (
    <aside className="editor glass control-panel" aria-label="Scenes, playlists and schedule">
      <PanelHead onHide={onHide}>
        <div className="segmented panel-tabs" role="tablist" aria-label="Library">
          {LIBRARY_TABS.map(([v, label]) => (
            <button key={v} role="tab" aria-selected={tab === v} className={tab === v ? 'active' : ''} onClick={() => onTab(v)}>{label}</button>
          ))}
        </div>
      </PanelHead>
      {tab === 'playlists' && <PlaylistsView show={show} />}
      {tab === 'schedule' && !DEMO && <ScheduleView show={show} />}
      {tab === 'scenes' && <SceneLibrary show={show} flow={flow} editor={editor} ask={ask} onEdit={onEdit} onNew={onNew} />}
    </aside>
  );
}

function SceneLibrary({ show, flow, editor, ask, onEdit, onNew }: Omit<Props, 'tab' | 'onTab' | 'onHide'>) {
  const status = show.status!;
  const stage = status.stage;
  const [q, setQ] = useState('');
  const [going, setGoing] = useState<string | null>(null);
  const rows = filterScenes(show.scenes, q);
  const onPorch = (n: string) => n === stage.scene || n === stage.preview;
  const unsaved = editor.dirty ? editor.name : null;

  const go = async (name: string) => {
    if (!(await flow.confirmGo(name))) return;
    setGoing(name);
    try { await api.go(name); await show.refresh(); } catch (e) { show.reportError(e); }
    setGoing(null);
  };
  const rename = async (name: string) => {
    const others = show.scenes.map((s) => s.name).filter((n) => n !== name);
    const r = await ask({
      title: 'Rename scene', message: 'Playlists and the schedule follow the new name.',
      input: { label: 'Name', value: name, check: (v) => (v.trim() === name ? null : nameProblem(v, others)) },
      buttons: [{ id: 'rename', label: 'Rename', kind: 'primary' }, { id: 'cancel', label: 'Cancel', kind: 'ghost' }], cancel: 'cancel',
    });
    if (r.choice === 'rename' && r.value !== name) await flow.renameScene(name, r.value);
  };

  return (
    <div className="show-view">
      <div className="scene-tools">
        <SceneSearch value={q} onChange={setQ} count={show.scenes.length} />
        <button className="btn small" onClick={onNew} title="Start a new, blank scene in Create">+ New</button>
      </div>
      <ul className="scene-list" aria-label="Scenes">
        {rows.map((s) => {
          const live = s.name === stage.preview;
          const on = s.name === stage.scene;
          const tag = live ? 'Live edit' : on ? (stage.dirty ? 'Edited on stage' : status.output.enabled ? 'On the porch now' : 'On stage') : null;
          return (
            <li key={s.name} className={`library-row ${on || live ? 'on-porch' : ''}`}>
              <Swatch scene={s.name === unsaved ? editor.scene : s} />
              <span className="library-name">
                <span className="scene-name">{s.name}</span>
                {(tag || s.name === unsaved) && (
                  <span className={`library-tag ${live || stage.dirty ? 'warn' : 'ok'}`}>
                    {tag}{tag && s.name === unsaved ? ' · ' : ''}{s.name === unsaved ? 'unsaved edits in Create' : ''}
                  </span>
                )}
              </span>
              <button className="icon-btn row-icon" aria-label={`Edit ${s.name}`} title="Edit in Create" onClick={() => onEdit(s.name)}><PencilIcon /></button>
              <Popover label={`${s.name}: more`} align="right" className="row-menu" trigger={(p) => (
                <button className="icon-btn row-icon" aria-label={`More for ${s.name}`} title="Duplicate, rename, delete" {...p}><MoreIcon size={16} /></button>
              )}>
                {(close) => (
                  <>
                    <button role="menuitem" className="menu-item" onClick={() => { close(); void flow.duplicateScene(s.name); }}>Duplicate</button>
                    <button role="menuitem" className="menu-item" onClick={() => { close(); void rename(s.name); }}>Rename…</button>
                    <button role="menuitem" className="menu-item danger" disabled={onPorch(s.name)} title={onPorch(s.name) ? 'The scene on stage can’t be deleted' : undefined}
                      onClick={() => { close(); void flow.remove(s.name); }}>Delete…</button>
                  </>
                )}
              </Popover>
              <button className="btn small go-btn" aria-label={`Go ${s.name}`} disabled={going !== null || (on && !stage.dirty && !stage.preview)}
                title={on && !stage.dirty ? 'On stage now' : `Put ${s.name} on the porch`} onClick={() => void go(s.name)}>{going === s.name ? '…' : 'Go'}</button>
            </li>
          );
        })}
        {rows.length === 0 && <li className="empty">No scene matches “{q}”.</li>}
      </ul>
      <div className="go-area">
        {!status.output.enabled && <p className="hint">Streaming is off, so the porch keeps its WLED playlist until you turn streaming on.</p>}
        <label className="fade-row">
          <span>Fade for Go</span>
          <select value={String(status.output.transition ?? 1)} aria-label="Crossfade time for Go"
            onChange={(e) => api.setOutput({ transition: Number(e.target.value) }).then(show.refresh).catch(show.reportError)}>
            {[0, 0.5, 1, 2, 3, 5].map((v) => <option key={v} value={String(v)}>{v === 0 ? 'Cut' : `${v} s`}</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}
