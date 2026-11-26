import { useEffect, useState } from 'react';
import { DEMO, DEMO_TIP } from './demo/flag';
import { api, type Playlist, type Schedule } from './api';
import type { Show } from './useShow';

// ---- playlists ----------------------------------------------------------------------------------

/** Playlists: scenes played in turn, looping. Runs on the server, so it keeps going with the app closed. */
export function PlaylistsView({ show }: { show: Show }) {
  const [lists, setLists] = useState<Playlist[] | null>(null);
  const [editing, setEditing] = useState<Playlist | null>(null);
  const load = () => api.playlists().then(setLists).catch(show.reportError);
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const playing = show.status?.playlist ?? null;
  const sceneNames = show.scenes.map((s) => s.name);

  if (editing) return <PlaylistEditor show={show} initial={editing} sceneNames={sceneNames} onDone={() => { setEditing(null); void load(); }} />;

  return (
    <div className="show-view">
      {playing && (
        <div className="now-playing" role="status">
          <span className="dot ok" aria-hidden />
          <span>Playing <b>{playing.name}</b>: {playing.scene}{playing.nextAt ? ` · next in ${until(playing.nextAt)}` : ''}</span>
          <button className="btn small ghost" onClick={() => api.stopPlaylist().then(show.refresh).catch(show.reportError)}>Stop</button>
        </div>
      )}
      <ul className="scene-list">
        {(lists ?? []).map((p) => (
          <li key={p.name}>
            <div className="playlist-row">
              <button className="scene-row" onClick={() => setEditing(structuredClone(p))}>
                <span className="scene-name">{p.name}</span>
                <span className="muted">{p.entries.length} scenes · {duration(p.entries.reduce((a, e) => a + e.seconds, 0))}{p.loop ? ' · loops' : ''}{p.shuffle ? ' · shuffled' : ''}</span>
              </button>
              <button className="btn small" disabled={playing?.name === p.name}
                onClick={() => api.playPlaylist(p.name).then(show.refresh).catch(show.reportError)}>{playing?.name === p.name ? 'Playing' : 'Play'}</button>
            </div>
          </li>
        ))}
        {lists?.length === 0 && <li className="empty">No playlists yet. A playlist plays scenes in turn, e.g. Warm white for 10 minutes, then Candy cane for 5.</li>}
      </ul>
      <div className="go-area">
        <button className="btn small" disabled={!sceneNames.length || DEMO} title={DEMO ? DEMO_TIP : undefined}
          onClick={() => setEditing({ name: uniqueName('Evening', (lists ?? []).map((l) => l.name)), entries: [{ scene: sceneNames[0]!, seconds: 600 }], loop: true })}>+ New playlist</button>
        <p className="hint">{DEMO ? 'In the demo a playlist plays in this tab only.' : 'Playlists run on the server, so they keep going with the app closed.'} Go on a scene stops the playlist.</p>
      </div>
    </div>
  );
}

function PlaylistEditor({ show, initial, sceneNames, onDone }: { show: Show; initial: Playlist; sceneNames: string[]; onDone: () => void }) {
  const [p, setP] = useState(initial);
  const [saving, setSaving] = useState(false);
  const setEntry = (i: number, patch: Partial<Playlist['entries'][number]>) => setP({ ...p, entries: p.entries.map((e, j) => (j === i ? { ...e, ...patch } : e)) });
  const globalFade = show.status?.output.transition ?? 1;
  const fades = new Set(p.entries.map((e) => e.fade));
  const mixedFades = fades.size > 1;
  const sameFade = mixedFades ? undefined : p.entries[0]?.fade;
  const move = (i: number, d: number) => { const e = [...p.entries]; const [x] = e.splice(i, 1); e.splice(i + d, 0, x!); setP({ ...p, entries: e }); };
  const save = async () => {
    setSaving(true);
    try { await api.savePlaylist(p); if (p.name !== initial.name) await api.deletePlaylist(initial.name).catch(() => {}); onDone(); } catch (e) { show.reportError(e); }
    setSaving(false);
  };
  return (
    <div className="show-view playlist-editor">
      <label className="field"><span className="field-label">Name</span>
        <input className="text" value={p.name} maxLength={60} onChange={(e) => setP({ ...p, name: e.target.value })} />
      </label>
      <div className="entry-row entry-head" aria-hidden="true">
        <span>Scene</span><span>Minutes</span><span title="Seconds to fade into this scene. Blank uses the app's fade.">Fade s</span>
      </div>
      <ol className="entries">
        {p.entries.map((e, i) => (
          <li key={i} className="entry-row">
            <select value={e.scene} aria-label={`Scene ${i + 1}`} onChange={(ev) => setEntry(i, { scene: ev.target.value })}>
              {sceneNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <input className="num" type="number" min={1} step={1} value={Math.round(e.seconds / 60 * 10) / 10} aria-label={`Minutes for scene ${i + 1}`}
              onChange={(ev) => setEntry(i, { seconds: Math.max(1, Math.round(Number(ev.target.value) * 60)) })} />
            <input className="num" type="number" min={0} max={60} step={0.1} inputMode="decimal" value={e.fade ?? ''} placeholder={String(globalFade)}
              aria-label={`Seconds to fade into scene ${i + 1}`} title="Seconds to fade into this scene. Blank uses the app's fade."
              onChange={(ev) => setEntry(i, { fade: parseFade(ev.target.value) })} />
            <button className="icon-btn small" disabled={i === 0} aria-label="Move up" onClick={() => move(i, -1)}>↑</button>
            <button className="icon-btn small" disabled={p.entries.length < 2} aria-label="Remove" onClick={() => setP({ ...p, entries: p.entries.filter((_, j) => j !== i) })}>−</button>
          </li>
        ))}
      </ol>
      <div className="row">
        <button className="btn small" onClick={() => setP({ ...p, entries: [...p.entries, { scene: sceneNames[0]!, seconds: 300 }] })}>+ Add scene</button>
        <label className="check"><input type="checkbox" checked={p.loop} onChange={(e) => setP({ ...p, loop: e.target.checked })} /> Loop</label>
        <label className="check" title="Play the scenes in a random order, a new one each time round"><input type="checkbox" checked={!!p.shuffle} onChange={(e) => setP({ ...p, shuffle: e.target.checked })} /> Shuffle</label>
        <label className="check fade-all" title="Set the fade for every scene. Blank uses the app's fade.">Fade all
          <input className="num" type="number" min={0} max={60} step={0.1} inputMode="decimal" aria-label="Seconds to fade into every scene"
            value={sameFade ?? ''} placeholder={sameFade === undefined && mixedFades ? 'mixed' : String(globalFade)}
            onChange={(ev) => { const fade = parseFade(ev.target.value); setP({ ...p, entries: p.entries.map((e) => ({ ...e, fade })) }); }} /> s
        </label>
      </div>
      <div className="row">
        <button className="btn small" disabled={DEMO || saving || !p.name.trim()} title={DEMO ? DEMO_TIP : undefined} onClick={() => void save()}>{saving ? 'Saving…' : 'Save playlist'}</button>
        <button className="btn small ghost" onClick={onDone}>Cancel</button>
        {initial.name && <button className="btn small ghost danger-quiet" disabled={DEMO} title={DEMO ? DEMO_TIP : undefined} onClick={() => {
          if (window.confirm(`Delete the playlist “${initial.name}”?`)) api.deletePlaylist(initial.name).then(onDone).catch(show.reportError);
        }}>Delete</button>}
      </div>
    </div>
  );
}

/** A fade typed in the editor: blank means "use the app's fade"; otherwise seconds, kept to 0..60. */
function parseFade(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? Math.min(60, Math.max(0, n)) : undefined;
}

// ---- schedule -----------------------------------------------------------------------------------

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Nightly on/off: the show starts by itself at sunset (or a set time) and hands the porch back to WLED at bedtime. */
export function ScheduleView({ show }: { show: Show }) {
  const [s, setS] = useState<Schedule | null>(null);
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);
  const status = show.status?.schedule ?? null;
  const scenes = show.scenes.map((x) => x.name);
  const [playlists, setPlaylists] = useState<string[]>([]);
  useEffect(() => {
    api.playlists().then((l) => setPlaylists(l.map((x) => x.name))).catch(() => {});
    api.schedule().then((x) => setS('timezone' in x ? x : {
      enabled: false, timezone: browserZone(), on: { kind: 'sunset', offsetMinutes: 0 }, off: { kind: 'time', time: '23:00' },
      run: { kind: 'scene', name: scenes[0] ?? '' },
    })).catch(show.reportError);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return <div className="show-view"><p className="hint">Loading…</p></div>;

  const save = async (next: Schedule) => {
    setSaving(true);
    try { await api.saveSchedule(next); setS(next); await show.refresh(); } catch (e) { show.reportError(e); }
    setSaving(false);
  };
  const locate = () => {
    setLocating(true);
    navigator.geolocation?.getCurrentPosition(
      (pos) => { setS({ ...s, latitude: Math.round(pos.coords.latitude * 100) / 100, longitude: Math.round(pos.coords.longitude * 100) / 100 }); setLocating(false); },
      () => { show.reportError(new Error('Location unavailable: type your latitude and longitude instead (two decimals is plenty).')); setLocating(false); },
    );
  };
  // The saved schedule's times, in its own zone. (Not the zone in the text box, which is only
  // half-typed while it's being edited, and an unknown zone makes Intl throw.)
  const fmt = (ms: number) => {
    const opts = { weekday: 'short', hour: 'numeric', minute: '2-digit' } as const;
    try { return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: status?.timezone ?? s.timezone }).format(new Date(ms)); }
    catch { return new Intl.DateTimeFormat(undefined, opts).format(new Date(ms)); }
  };
  const needsSun = s.on.kind === 'sunset' || s.off.kind === 'sunrise';

  return (
    <div className="show-view schedule">
      <label className="check big"><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> Run the show every night</label>
      {status?.enabled && (
        <p className="hint" role="status">{status.active ? `On now, until ${fmt(status.nextOff)}.` : `Next: on ${fmt(status.nextOn)}, off ${fmt(status.nextOff)}.`}</p>
      )}

      <div className="field"><span className="field-label">Lights on</span>
        <div className="row tight">
          <select value={s.on.kind} onChange={(e) => setS({ ...s, on: e.target.value === 'sunset' ? { kind: 'sunset', offsetMinutes: 0 } : { kind: 'time', time: '16:30' } })}>
            <option value="sunset">At sunset</option><option value="time">At a time</option>
          </select>
          {s.on.kind === 'time'
            ? <input className="text" type="time" value={s.on.time} onChange={(e) => setS({ ...s, on: { kind: 'time', time: e.target.value } })} />
            : <><input className="num" type="number" step={5} value={s.on.offsetMinutes ?? 0} aria-label="Minutes after sunset"
              onChange={(e) => setS({ ...s, on: { kind: 'sunset', offsetMinutes: Number(e.target.value) } })} /><span className="muted">min after</span></>}
        </div>
      </div>
      <div className="field"><span className="field-label">Lights off</span>
        <div className="row tight">
          <select value={s.off.kind} onChange={(e) => setS({ ...s, off: e.target.value === 'sunrise' ? { kind: 'sunrise', offsetMinutes: 0 } : { kind: 'time', time: '23:00' } })}>
            <option value="time">At a time</option><option value="sunrise">At sunrise</option>
          </select>
          {s.off.kind === 'time' && <input className="text" type="time" value={s.off.time} onChange={(e) => setS({ ...s, off: { kind: 'time', time: e.target.value } })} />}
        </div>
      </div>
      <div className="field"><span className="field-label">Play</span>
        <select value={`${s.run.kind}:${s.run.name}`} onChange={(e) => { const [kind, ...n] = e.target.value.split(':'); setS({ ...s, run: { kind: kind as 'scene' | 'playlist', name: n.join(':') } }); }}>
          {playlists.length > 0 && <optgroup label="Playlists">{playlists.map((n) => <option key={n} value={`playlist:${n}`}>{n}</option>)}</optgroup>}
          <optgroup label="Scenes">{scenes.map((n) => <option key={n} value={`scene:${n}`}>{n}</option>)}</optgroup>
        </select>
      </div>
      <div className="field"><span className="field-label">Time zone</span>
        <input className="text" value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })} />
      </div>
      {needsSun && (
        <div className="field"><span className="field-label">Location (for sunset)</span>
          <div className="row tight">
            <input className="num wide" type="number" step={0.01} placeholder="Latitude" aria-label="Latitude" value={s.latitude ?? ''} onChange={(e) => setS({ ...s, latitude: e.target.value === '' ? undefined : Number(e.target.value) })} />
            <input className="num wide" type="number" step={0.01} placeholder="Longitude" aria-label="Longitude" value={s.longitude ?? ''} onChange={(e) => setS({ ...s, longitude: e.target.value === '' ? undefined : Number(e.target.value) })} />
            <button className="btn small ghost" disabled={locating} onClick={locate}>{locating ? '…' : 'Use mine'}</button>
          </div>
        </div>
      )}
      <div className="go-area">
        <button className="btn small" disabled={saving} onClick={() => void save(s)}>{saving ? 'Saving…' : 'Save schedule'}</button>
        <p className="hint">At the on time the server starts streaming and plays your choice; at the off time it hands the porch back to its WLED playlist. Changes you make during the evening are left alone.</p>
      </div>
    </div>
  );
}

// ---- helpers ------------------------------------------------------------------------------------

function duration(sec: number): string {
  if (sec < 60) return `${sec} s`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const until = (ms: number) => duration(Math.max(0, Math.round((ms - Date.now()) / 1000)));
function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}
