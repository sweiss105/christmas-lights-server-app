import { useEffect, useState } from 'react';
import { api, type ScheduleStatus } from './api';
import { PanelHead } from './PanelHead';
import type { Show } from './useShow';

type Found = Awaited<ReturnType<typeof api.discoverControllers>>;

/** Setup › WLED: the controllers the app drives, how they're doing, and finding others on the network. */
export function WledPanel({ show, onHide }: { show: Show; onHide?: () => void }) {
  const layout = show.layout!;
  const health = show.status!.stream.controllers;
  const [found, setFound] = useState<Found | null>(null);
  const [looking, setLooking] = useState(false);
  const find = async () => {
    setLooking(true);
    try { setFound(await api.discoverControllers()); } catch (e) { show.reportError(e); }
    setLooking(false);
  };
  const known = new Set(layout.controllers.map((c) => c.host));
  return (
    <aside className="editor glass setup-panel" aria-label="WLED controllers">
      <PanelHead eyebrow="WLED" title="Controllers" onHide={onHide} />
      <p className="hint panel-pad">The WLED controllers the app drives. Strings are wired to them in Strings.</p>
      <ul className="part-list">
        {layout.controllers.map((c) => {
          const h = health.find((x) => x.id === c.id);
          return (
            <li key={c.id} className="backup-item">
              <span className={`dot ${h ? (h.online ? (h.sendErrors ? 'warn' : 'ok') : 'bad') : ''}`} aria-hidden />
              <span className="backup-label">
                <span className="part-name">{c.name ?? c.id}</span>
                <span className="muted">{c.host} · {c.pixelCount} pixels · {h ? (h.online ? 'online' : 'offline') : 'not streaming'}{h?.info ? ` · WLED ${h.info.version}` : ''}</span>
                {(h?.lastError || h?.warning) && <span className="muted warn-text">{h.lastError ?? h.warning}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="section-head"><h3>On the network</h3></div>
      <div className="row panel-pad">
        <button className="btn small" disabled={looking} onClick={() => void find()}>{looking ? 'Looking…' : 'Find controllers'}</button>
      </div>
      {found && (
        <ul className="part-list">
          {found.map((f) => (
            <li key={f.host} className="backup-item">
              <span className="backup-label">
                <span className="part-name">{f.info?.name ?? f.mdnsName}</span>
                <span className="muted">{f.host}{f.info ? ` · ${f.info.ledCount} LEDs · WLED ${f.info.version}` : ''}{known.has(f.host) ? ' · in use' : ''}{f.error ? ` · ${f.error}` : ''}</span>
              </span>
            </li>
          ))}
          {found.length === 0 && <li className="empty">No WLED controllers answered. They need to be on the same network as the server.</li>}
        </ul>
      )}
    </aside>
  );
}

/** Setup › Home: the Home Assistant link, and where and when the schedule thinks it is. */
export function HomePanel({ show, onSchedule, onHide }: { show: Show; onSchedule: () => void; onHide?: () => void }) {
  const ha = show.status!.homeassistant;
  const [schedule, setSchedule] = useState<ScheduleStatus | { enabled: false } | null>(null);
  useEffect(() => { api.schedule().then(setSchedule).catch(show.reportError); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const s = schedule && 'timezone' in schedule ? schedule : null;
  return (
    <aside className="editor glass setup-panel" aria-label="Home and connections">
      <PanelHead eyebrow="Home" title="Home and connections" onHide={onHide} />
      <div className="section-head"><h3>Home Assistant</h3></div>
      <div className="status-line panel-pad">
        <span className={`dot ${ha?.enabled ? (ha.connected ? 'ok' : 'bad') : ''}`} aria-hidden />
        <span>{!ha?.enabled ? 'Not set up' : ha.connected ? 'Linked over MQTT' : 'Can’t reach the MQTT broker; retrying'}</span>
      </div>
      <p className="hint panel-pad">{ha?.enabled
        ? 'Home Assistant sees the lights as a light with an effect list (scenes) and can turn them on and off.'
        : 'To link Home Assistant, set XMAS_MQTT_URL on the server (the MQTT broker Home Assistant uses) and restart it.'}</p>
      <div className="section-head"><h3>Location and time zone</h3></div>
      {schedule === null ? <p className="hint panel-pad">Loading…</p> : (
        <>
          <dl className="facts panel-pad">
            <dt>Time zone</dt><dd>{s?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}{s ? '' : ' (this browser’s)'}</dd>
            <dt>Location</dt><dd>{s?.latitude !== undefined && s?.longitude !== undefined ? `${s.latitude}, ${s.longitude}` : 'Not set'}</dd>
          </dl>
          <p className="hint panel-pad">Sunset and sunrise for the nightly schedule are worked out for this place and time zone. They are set with the schedule.</p>
          <div className="row panel-pad"><button className="btn small" onClick={onSchedule}>Open the schedule</button></div>
        </>
      )}
    </aside>
  );
}
