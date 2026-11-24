import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Show } from './useShow';

interface BackupInfo { file: string; bytes: number; modified: number }

const label = (file: string) => {
  const daily = /^daily-(\d{4}-\d{2}-\d{2})\.json$/.exec(file);
  if (daily) return `Daily backup, ${new Date(`${daily[1]}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`;
  if (file.startsWith('before-restore-')) return 'Saved before a restore';
  return file;
};

/** Download all scenes, presets, playlists, layout and settings as one file, restore one, or roll back to a daily backup. */
export function BackupPanel({ show, onClose }: { show: Show; onClose: () => void }) {
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const load = () => api.backups().then(setBackups).catch(show.reportError);
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const afterRestore = async () => { await show.refresh(); await show.refreshPresets(); await load(); };
  const restoreFile = async (f: File) => {
    if (!window.confirm(`Replace all scenes, presets, playlists, layout and settings with “${f.name}”? Your current setup is saved as a backup first.`)) return;
    setBusy(true);
    try { await api.restore(JSON.parse(await f.text())); await afterRestore(); } catch (e) { show.reportError(e instanceof SyntaxError ? new Error('That file is not a lights backup.') : e); }
    setBusy(false);
  };
  const restoreServer = async (b: BackupInfo) => {
    if (!window.confirm(`Go back to “${label(b.file)}”? Your current setup is saved as a backup first.`)) return;
    setBusy(true);
    try { await api.restoreBackup(b.file); await afterRestore(); } catch (e) { show.reportError(e); }
    setBusy(false);
  };

  return (
    <div className="house-panel glass backup-panel" role="dialog" aria-label="Backups">
      <div className="panel-head">
        <h2>Backups</h2>
        <button className="btn small ghost" onClick={onClose}>Done</button>
      </div>
      <div className="house-body">
        <p className="hint">One file holds your scenes, presets, playlists, schedule, layout and settings (house scans are kept separately on the server).</p>
        <div className="row wrap">
          <a className="btn small link-btn" href="/api/backup" download>Download backup</a>
          <button className="btn small ghost" disabled={busy} onClick={() => file.current?.click()}>Restore from file…</button>
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void restoreFile(f); e.target.value = ''; }} />
        </div>
        <div className="section-head"><h3>On the server</h3><span className="hint-inline">daily, last 14 kept</span></div>
        <ul className="part-list">
          {(backups ?? []).map((b) => (
            <li key={b.file} className="backup-item">
              <span className="backup-label"><span className="part-name">{label(b.file)}</span><span className="muted">{Math.max(1, Math.round(b.bytes / 1000))} KB</span></span>
              <a className="btn small ghost link-btn" href={`/api/backups/${encodeURIComponent(b.file)}`} download aria-label={`Download ${label(b.file)}`}>↓</a>
              <button className="btn small ghost" disabled={busy} onClick={() => void restoreServer(b)}>Restore</button>
            </li>
          ))}
          {backups?.length === 0 && <li className="empty">The first daily backup is made within a minute of the server starting.</li>}
        </ul>
      </div>
    </div>
  );
}
