/**
 * "Map lights": the phone screen for filming the lights from a few spots in the yard. Built for one
 * hand in the dark: the camera picture fills the screen, everything else sits in one sheet at the
 * bottom with a big Start button.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildLayout } from '@xmas/engine';
import { planMapping, solveMapping, type DecodeResult, type MappingPlan } from '@xmas/engine/mapping';
import { api } from '../api';
import type { Show } from '../useShow';
import { demoViews, openCamera, paintIdle, runView, simulatedSource, stopCamera, videoSource, type ViewRun } from './capture';
import { solverViews, useCameraChoice, useCaptureSettings, type MappingViews, type RunRole } from './review';
import { applyBaseControls, describeCamera, listBackCameras, lockCamera, lockSummary, MAX_RECORDING_BYTES, Recorder, unlockCamera, type BackCamera, type CameraChoice, type CameraInfo } from './cameraControl';

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'running'; startMs: number; endMs: number }
  | { kind: 'decoding'; uploading?: boolean }
  | { kind: 'done'; result: DecodeResult; placed: string | null; upload: string | null }
  | { kind: 'error'; message: string };

interface Props {
  show: Show;
  demo: boolean;
  views: MappingViews;
  roles: Record<string, RunRole>;
  onClose: () => void;
  onReview: () => void;
}

/** Rough latency from the lights changing to the camera frame's timestamp (Wi-Fi, WLED, camera). */
const LATENCY_GUESS_MS = 90;
const LEAD_MS = 1800;

export function MapScreen({ show, demo, views, roles, onClose, onReview }: Props) {
  const layout = show.layout!;
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const runRef = useRef<ViewRun | null>(null);
  const [camera, setCamera] = useState<'off' | 'on' | 'denied'>(demo ? 'on' : 'off');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [portrait, setPortrait] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [settings, setSettings] = useCaptureSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cam, setCam] = useCameraChoice();
  const [cameras, setCameras] = useState<BackCamera[]>([]);
  const [camInfo, setCamInfo] = useState<CameraInfo | null>(null);
  /** Brightness test running (lights held steady), until this time. */
  const [testUntil, setTestUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => performance.now());
  const streaming = show.status?.output.enabled ?? false;

  const built = useMemo(() => buildLayout(layout), [layout]);
  const plan = useMemo(() => planMapping(built, settings), [built, settings]);
  const demoSpots = useMemo(() => demoViews(layout, 960, 540), [layout]);
  const spotNo = views.views.length + 1;

  // Camera on while this screen is open (not in demo mode).
  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    const video = videoRef.current!;
    setCamera('off');
    openCamera(video, cam).then(async (s) => {
      if (cancelled) { stopCamera(s); return; }
      streamRef.current = s;
      const track = s.getVideoTracks()[0]!;
      const applied = await applyBaseControls(track, cam);
      if (cancelled) return;
      setCamInfo(describeCamera(track, applied));
      void listBackCameras().then((c) => { if (!cancelled) setCameras(c); });
      setCamera('on');
      const check = () => setPortrait(video.videoHeight > video.videoWidth);
      check();
      video.addEventListener('resize', check);
    }, (e: Error) => { if (!cancelled) { setCamera('denied'); setCameraError(e.name === 'NotAllowedError' ? 'Camera access was refused. Allow it for this site in Safari’s settings (aA → Website Settings → Camera), then reopen this screen.' : e.message); } });
    return () => { cancelled = true; stopCamera(streamRef.current); streamRef.current = null; runRef.current?.cancel(); };
  }, [demo, cam.deviceId, cam.fps, cam.zoomOut]); // eslint-disable-line react-hooks/exhaustive-deps

  // Brightness test: keep the held lights in step with the slider, and end it on time.
  useEffect(() => {
    if (testUntil === null || demo) return;
    const left = testUntil - performance.now();
    if (left <= 0) { setTestUntil(null); return; }
    const t = setTimeout(() => { void api.mappingPreview({ k: settings.k, level: settings.level, seconds: Math.ceil(left / 1000) }).catch(show.reportError); }, 150);
    const end = setTimeout(() => setTestUntil(null), left);
    return () => { clearTimeout(t); clearTimeout(end); };
  }, [testUntil, settings.k, settings.level, demo, show.reportError]);
  const stopTest = () => { setTestUntil(null); if (!demo) void api.mappingStop().catch(() => {}); };

  // Demo: a still simulated picture of the next spot.
  useEffect(() => {
    if (!demo || phase.kind !== 'idle' || !canvasRef.current) return;
    paintIdle(canvasRef.current, layout, plan, demoSpots[(spotNo - 1) % demoSpots.length]!);
  }, [demo, phase.kind, layout, plan, demoSpots, spotNo]);

  // Tick for the countdown and progress bar.
  useEffect(() => {
    if (phase.kind !== 'running') return;
    const id = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(id);
  }, [phase.kind]);

  // Is each spot's camera position solvable from the trusted strings? Quick to work out, so redo it as spots come in.
  const placement = useMemo(() => {
    const anchors = layout.runs.filter((r) => roles[r.id] !== 'measure').map((r) => r.id);
    const vs = solverViews(views.views, built.count);
    if (!vs.length) return new Map<string, { ok: boolean; text: string }>();
    try {
      const res = solveMapping({ layout, views: vs, anchorRuns: anchors, targetRuns: [] });
      return new Map(res.views.map((v) => [v.id, { ok: v.ok, text: v.ok ? `camera placed from ${v.inliers} trusted lights` : v.reason ?? 'not placed' }]));
    } catch { return new Map(); }
  }, [views.views, layout, roles, built.count]);

  const start = async () => {
    if (!demo && !streaming) return;
    setPhase({ kind: 'starting' });
    setTestUntil(null); // the sequence replaces the brightness test (its lights stay on until then, for the exposure lock)
    let wake: { release: () => Promise<void> } | null = null;
    try {
      wake = await (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request('screen').catch(() => null) ?? null;
      let p: MappingPlan, startMs: number, source;
      let recorder: Recorder | null = null;
      const track = streamRef.current?.getVideoTracks()[0] ?? null;
      if (!demo && track && cam.lock) {
        // Freeze exposure while the porch shows its normal look (the sequence then goes dark and flashes).
        const locked = await lockCamera(track, cam);
        setCamInfo(describeCamera(track, { ...(camInfo?.applied ?? {}), ...locked }));
      }
      if (demo) {
        p = plan;
        startMs = performance.now() + LEAD_MS;
        source = simulatedSource(layout, p, demoSpots[(spotNo - 1) % demoSpots.length]!, startMs, canvasRef.current);
      } else {
        await show.clock.sync(8);
        const res = await api.mappingStart({ ...settings, leadMs: LEAD_MS });
        p = res.plan;
        startMs = show.clock.toLocal(res.startsAt) * 1000 + LATENCY_GUESS_MS;
        source = videoSource(videoRef.current!);
        if (cam.record) recorder = new Recorder(source.width, source.height);
      }
      const run = runView(source, p, startMs, recorder);
      runRef.current = run;
      setNow(performance.now());
      setPhase({ kind: 'running', startMs, endMs: startMs + p.durationMs });
      const done = run.result.then((r) => r);
      // Switch the label to "reading" once the lights are done.
      const wait = setTimeout(() => setPhase((ph) => (ph.kind === 'running' ? { kind: 'decoding' } : ph)), startMs + p.durationMs - performance.now() + 300);
      const result = await done.finally(() => { if (track && cam.lock) void unlockCamera(track); });
      clearTimeout(wait);
      runRef.current = null;
      const label = `Spot ${spotNo}`;
      // Footage goes up even when decoding failed: that's when it's most useful.
      const sendFootage = async (viewId: string): Promise<string | null> => {
        if (!recorder) return null;
        const info = track ? describeCamera(track, camInfo?.applied ?? {}) : null;
        const blob = await recorder.finish({ label, viewId, startGuessMs: startMs, plan: { params: p.params, durationMs: p.durationMs }, decoder: { width: source.width, height: source.height }, stats: result.stats, camera: info, choice: cam, userAgent: navigator.userAgent });
        if (blob.size > MAX_RECORDING_BYTES) return `Footage too large to send (${Math.round(blob.size / 1e6)} MB)`;
        setPhase({ kind: 'decoding', uploading: true });
        try { const r = await api.uploadRecording(blob, { view: viewId, label, gz: recorder.compressed }); return `Footage sent (${(r.bytes / 1e6).toFixed(1)} MB, ${recorder.frames} frames)`; }
        catch (e) { return `Footage not sent: ${(e as Error).message}`; }
      };
      if (!result.ok) {
        const note = await sendFootage('failed');
        setPhase({ kind: 'error', message: `${result.error ?? 'No lights could be read.'}${note ? ` ${note}.` : ''}` });
        return;
      }
      const saved = await views.add({
        width: source.width, height: source.height, params: p.params,
        detections: result.detections.map((d) => ({ pixel: d.pixel, x: d.x, y: d.y, strength: d.strength, margin: d.margin })),
        stats: { ...result.stats },
        label,
      });
      const upload = await sendFootage(saved.id);
      setPhase({ kind: 'done', result, placed: saved.id, upload });
    } catch (e) {
      runRef.current = null;
      const msg = (e as Error).message;
      setPhase(msg === 'cancelled' ? { kind: 'idle' } : { kind: 'error', message: msg });
    } finally {
      void wake?.release().catch(() => {});
    }
  };

  const cancel = () => {
    runRef.current?.cancel();
    if (!demo) void api.mappingStop().catch(() => {});
  };

  const seconds = Math.round((plan.durationMs + LEAD_MS) / 1000);
  const busy = phase.kind === 'starting' || phase.kind === 'running' || phase.kind === 'decoding';

  return (
    <div className="map-screen" role="dialog" aria-label="Map lights">
      {demo ? <canvas ref={canvasRef} className="map-video" aria-label="Simulated camera picture" />
        : <video ref={videoRef} className="map-video" playsInline muted aria-label="Camera picture" />}
      {phase.kind === 'done' && <ResultPicture result={phase.result} />}

      <header className="map-top">
        <button className="icon-btn map-round" onClick={() => { cancel(); onClose(); }} aria-label="Close mapping" disabled={phase.kind === 'starting'}><BackIcon /></button>
        <div className="map-title">
          <span className="eyebrow">{demo ? 'Demo · simulated camera' : 'Map lights'}</span>
          <strong>{views.views.length === 0 ? 'No spots yet' : `${views.views.length} spot${views.views.length === 1 ? '' : 's'} filmed`}</strong>
        </div>
        <button className="btn small map-review-btn" disabled={busy || views.views.length === 0} onClick={() => { cancel(); onReview(); }}>Review</button>
      </header>

      {phase.kind === 'running' && <RunningBadge phase={phase} now={now} />}

      <section className="map-sheet glass" aria-label="Filming">
        {phase.kind === 'idle' && (<>
          <h2 className="map-head">Spot {spotNo}</h2>
          <p className="map-guide">{guidance(views.views.length)}</p>
          {portrait && camera === 'on' && !demo && <p className="map-note"><RotateIcon /> Turn the phone sideways for a wider view.</p>}
          {!demo && camera === 'denied' && <p className="map-warn" role="alert">{cameraError}</p>}
          {!demo && !streaming && (
            <div className="map-warn" role="alert">
              <span>Streaming is off, so the lights can’t flash their codes.</span>
              <button className="btn small" onClick={() => api.setOutput({ enabled: true }).then(show.refresh).catch(show.reportError)}>Turn streaming on</button>
            </div>
          )}
          <SpotList views={views} placement={placement} />
          {testUntil !== null ? (
            <div className="map-test" role="group" aria-label="Brightness test">
              <p className="map-guide">The lights to be measured are on. Each should look like a small, separate dot on the screen: not a big glowing blob, and not so dim you can hardly see it.</p>
              <label className="field slider compact">
                <span className="field-label">Light level <span className="field-value">{Math.round(settings.level * 100)}% of brightness</span></span>
                <input type="range" min={5} max={100} step={5} value={Math.round(settings.level * 100)} aria-label="Light level" style={{ ['--fill' as string]: `${settings.level * 100}%` }} onChange={(e) => setSettings({ level: Number(e.target.value) / 100 })} />
              </label>
              <div className="map-row two">
                <button className="btn" onClick={stopTest}>Done testing</button>
                <span className="hint-inline">Press Start straight after: the camera sets its exposure on these lights.</span>
              </div>
            </div>
          ) : (
            <button className="btn map-test-btn" disabled={!demo && (!streaming || camera !== 'on')} onClick={() => setTestUntil(performance.now() + 25_000)}>Test brightness</button>
          )}
          <button className="btn go map-start" disabled={(!demo && (!streaming || camera !== 'on'))} onClick={() => void start()}>
            <CameraIcon /> Start · about {seconds} s
          </button>
          <div className="map-row">
            <button className="btn small ghost" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((o) => !o)}>{settingsOpen ? 'Hide settings' : 'Settings'}</button>
            <span className="hint-inline">Every {plan.params.k}th light · {plan.params.passes} pass{plan.params.passes === 1 ? '' : 'es'} · {plan.params.holdMs} ms · {Math.round(plan.params.level * 100)}% level</span>
          </div>
          {settingsOpen && <Settings settings={settings} onChange={setSettings} plan={plan} />}
          {settingsOpen && !demo && <CameraSettings choice={cam} onChange={setCam} cameras={cameras} info={camInfo} />}
        </>)}

        {phase.kind === 'starting' && <p className="map-head" role="status">Getting the lights ready…</p>}

        {phase.kind === 'running' && (<>
          <h2 className="map-head" role="status">{now < phase.startMs ? 'Get ready…' : 'Hold still'}</h2>
          <p className="map-guide">{now < phase.startMs ? 'Point the camera at the lights and keep it steady. They’ll go dark, then flash.' : 'Keep the lights in the picture. Don’t move until this finishes.'}</p>
          <Progress value={Math.max(0, Math.min(1, (now - phase.startMs) / (phase.endMs - phase.startMs)))} label={now < phase.startMs ? `Starts in ${Math.ceil((phase.startMs - now) / 1000)} s` : `${Math.max(0, Math.ceil((phase.endMs - now) / 1000))} s left`} />
          <button className="btn map-cancel" onClick={cancel}>Cancel</button>
        </>)}

        {phase.kind === 'decoding' && (<>
          <h2 className="map-head" role="status">{phase.uploading ? 'Sending the footage…' : 'Reading the lights…'}</h2>
          <p className="map-guide">You can move now.</p>
          <Progress value={1} label={phase.uploading ? 'Uploading' : 'Decoding'} />
        </>)}

        {phase.kind === 'done' && (<>
          <h2 className="map-head">Found {phase.result.detections.length} lights</h2>
          <p className="map-guide">{placedText(placement.get(phase.placed ?? ''))}{guidance(views.views.length)}</p>
          {phase.upload && <p className="hint">{phase.upload}.</p>}
          <div className="map-row two">
            <button className="btn go" onClick={() => setPhase({ kind: 'idle' })}>Next spot</button>
            <button className="btn" onClick={onReview}>Review</button>
          </div>
        </>)}

        {phase.kind === 'error' && (<>
          <h2 className="map-head">That spot didn’t work</h2>
          <p className="map-warn" role="alert">{phase.message}</p>
          <p className="map-guide">Check the lights are in the picture and not too small, hold the phone steadier, and try again. A spot that fails isn’t saved.</p>
          <button className="btn go map-start" onClick={() => setPhase({ kind: 'idle' })}>Try again</button>
        </>)}
      </section>
    </div>
  );
}

function placedText(p: { ok: boolean; text: string } | undefined): string {
  if (!p) return '';
  return p.ok ? `The ${p.text}. ` : `The camera couldn’t be placed (${p.text}); it can still help once more spots are in. `;
}

function guidance(spots: number): string {
  if (spots === 0) return 'Stand 8–15 m from the house where you can see the lights you want to map, and some porch lights. Use the 1× camera, hold the phone sideways and rest it on something steady.';
  if (spots === 1) return 'Now walk 3–5 m to one side and film the same lights again from there.';
  if (spots === 2) return 'Two spots done. One more from the other side makes the result much more reliable.';
  return 'That’s enough to work out positions. Add spots for lights that were hidden, or tap Review.';
}

function SpotList({ views, placement }: { views: MappingViews; placement: Map<string, { ok: boolean; text: string }> }) {
  if (!views.views.length) return null;
  return (
    <ul className="spot-list" aria-label="Spots filmed">
      {views.views.map((v, i) => {
        const p = placement.get(v.id);
        return (
          <li key={v.id} className="spot-chip">
            <span className={`dot ${p?.ok ? 'ok' : p ? 'warn' : ''}`} aria-hidden />
            <span className="spot-text"><strong>Spot {i + 1}</strong> · {v.detections.length} lights{p ? ` · ${p.ok ? 'placed' : 'not placed'}` : ''}</span>
            <button className="icon-btn small" aria-label={`Delete spot ${i + 1}`} onClick={() => { if (window.confirm(`Delete spot ${i + 1}?`)) void views.remove(v.id); }}><CloseIcon /></button>
          </li>
        );
      })}
    </ul>
  );
}

function Settings({ settings, onChange, plan }: { settings: { k: number; passes: number; holdMs: number; level: number }; onChange: (s: Partial<{ k: number; passes: number; holdMs: number; level: number }>) => void; plan: MappingPlan }) {
  const seg = <T extends number>(label: string, value: T, options: T[], fmt: (v: T) => string, set: (v: T) => void) => (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map((o) => <button key={o} role="radio" aria-checked={o === value} className={o === value ? 'active' : ''} onClick={() => set(o)}>{fmt(o)}</button>)}
      </div>
    </div>
  );
  return (
    <div className="map-settings">
      {seg('Light every', settings.k, [10, 14, 20, 30], (v) => `${v}th`, (k) => onChange({ k }))}
      {seg('Passes per spot', settings.passes, [1, 2, 3, 4], (v) => `${v}`, (passes) => onChange({ passes }))}
      {seg('Hold each pattern', settings.holdMs, [250, 400, 500, 750], (v) => `${v} ms`, (holdMs) => onChange({ holdMs }))}
      <label className="field slider compact">
        <span className="field-label">Light level <span className="field-value">{Math.round(settings.level * 100)}% of brightness</span></span>
        <input type="range" min={10} max={100} step={5} value={Math.round(settings.level * 100)} style={{ ['--fill' as string]: `${settings.level * 100}%` }} onChange={(e) => onChange({ level: Number(e.target.value) / 100 })} />
      </label>
      <p className="hint">Each spot lights every {plan.params.k}th light of every string, {plan.params.passes} time{plan.params.passes === 1 ? '' : 's'} with different lights, so {plan.passes.reduce((a, p) => a + p.pixels.length, 0)} of {plan.pixelCount} lights get measured; the ones between are filled in along the wire. Fewer, slower patterns help on a weak Wi-Fi link.</p>
    </div>
  );
}

/** Camera, frame rate, locking and recording. */
function CameraSettings({ choice, onChange, cameras, info }: { choice: CameraChoice; onChange: (c: Partial<CameraChoice>) => void; cameras: BackCamera[]; info: CameraInfo | null }) {
  const s = info?.settings as { width?: number; height?: number; frameRate?: number; zoom?: number } | undefined;
  const zoomCap = info?.capabilities.zoom as { min?: number } | undefined;
  return (
    <div className="map-settings">
      {cameras.length > 1 && (
        <label className="field">
          <span className="field-label">Camera</span>
          <select value={choice.deviceId} onChange={(e) => onChange({ deviceId: e.target.value })}>
            <option value="">Default back camera</option>
            {cameras.map((c) => <option key={c.deviceId} value={c.deviceId}>{c.label}</option>)}
          </select>
        </label>
      )}
      {zoomCap?.min !== undefined && zoomCap.min < 1 && (
        <label className="check"><input type="checkbox" checked={choice.zoomOut} onChange={(e) => onChange({ zoomOut: e.target.checked })} /> Wide view ({zoomCap.min}× zoom)</label>
      )}
      <div className="field">
        <span className="field-label">Frame rate</span>
        <div className="segmented" role="radiogroup" aria-label="Frame rate">
          {([30, 60] as const).map((f) => <button key={f} role="radio" aria-checked={choice.fps === f} className={choice.fps === f ? 'active' : ''} onClick={() => onChange({ fps: f })}>{f} fps</button>)}
        </div>
      </div>
      <label className="check"><input type="checkbox" checked={choice.lock} onChange={(e) => onChange({ lock: e.target.checked })} /> Lock exposure, colour and focus while filming</label>
      {choice.lock && (
        <div className="field">
          <span className="field-label">Darken while filming</span>
          <div className="segmented" role="radiogroup" aria-label="Darken while filming">
            {[0, -1, -2].map((v) => <button key={v} role="radio" aria-checked={choice.ev === v} className={choice.ev === v ? 'active' : ''} onClick={() => onChange({ ev: v })}>{v === 0 ? 'None' : `${v} EV`}</button>)}
          </div>
        </div>
      )}
      <label className="check"><input type="checkbox" checked={choice.record} onChange={(e) => onChange({ record: e.target.checked })} /> Send a small copy of the footage (for fixing problems)</label>
      {info && (
        <p className="hint">
          {info.label || 'Camera'}{s?.width ? ` · ${s.width}×${s.height}` : ''}{s?.frameRate ? ` · ${Math.round(s.frameRate)} fps` : ''}{s?.zoom ? ` · zoom ${s.zoom}` : ''}
          {Object.keys(info.applied).length ? ` · ${lockSummary(info.applied)}` : ''}
        </p>
      )}
    </div>
  );
}

function RunningBadge({ phase, now }: { phase: { startMs: number }; now: number }) {
  return <div className={`map-rec ${now >= phase.startMs ? 'on' : ''}`} role="status"><span className="dot" aria-hidden />{now >= phase.startMs ? 'Filming' : 'Ready'}</div>;
}

function Progress({ value, label }: { value: number; label: string }) {
  return (
    <div className="map-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-valuetext={label}>
      <div className="bar"><span style={{ width: `${value * 100}%` }} /></div>
      <span className="label">{label}</span>
    </div>
  );
}

/** The spot's picture (from the decoder) with a dot on every light it read. */
function ResultPicture({ result }: { result: DecodeResult }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current, th = result.thumbnail;
    if (!c || !th) return;
    const scale = 3;
    c.width = th.width * scale; c.height = th.height * scale;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(th.width, th.height);
    for (let i = 0, j = 0; i < th.data.length; i++, j += 4) { const v = th.data[i]! * 0.55; img.data[j] = v; img.data[j + 1] = v; img.data[j + 2] = v * 1.1; img.data[j + 3] = 255; }
    const tmp = document.createElement('canvas');
    tmp.width = th.width; tmp.height = th.height;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, 0, 0, c.width, c.height);
    const k = scale / th.scale; // decoder pixels → canvas pixels
    ctx.fillStyle = 'rgba(61, 220, 132, 0.95)';
    for (const d of result.detections) { ctx.beginPath(); ctx.arc(d.x * k, d.y * k, 3.2, 0, Math.PI * 2); ctx.fill(); }
  }, [result]);
  return <canvas ref={ref} className="map-video map-result" aria-label={`Picture with ${result.detections.length} lights marked`} />;
}

const BackIcon = () => <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.5 4 6.5 10l6 6" /></svg>;
export const CloseIcon = () => <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" /></svg>;
export const CameraIcon = () => <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M2.5 6.5h3l1.5-2h6l1.5 2h3v9h-15z" /><circle cx="10" cy="11" r="3" /></svg>;
const RotateIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="4.5" y="2" width="7" height="12" rx="1.5" /><path d="M1.5 9.5a6.5 6.5 0 0 0 3 4M14.5 6.5a6.5 6.5 0 0 0-3-4" /></svg>;
