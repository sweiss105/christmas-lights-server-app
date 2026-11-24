/**
 * Filming one view: frames from the phone camera (or the simulator in demo mode) go straight to the
 * decode worker as they arrive, so nothing but a few seconds of frames is ever held.
 */
import { buildLayout, type LayoutConfig, type Vec3 } from '@xmas/engine';
import { simulateFrames, slotMasks, type DecodeResult, type MappingPlan, type SimView } from '@xmas/engine/mapping';
import { DecodeWorker } from './workerProtocol';

/** Long side of the picture the decoder works on (the video is scaled down to this). */
export const PROCESS_SIZE = 1280;

export type FrameData = { rgba: ArrayBuffer } | { lum: ArrayBuffer };

export interface FrameSource {
  readonly width: number;
  readonly height: number;
  /** Deliver frames (t in ms on the performance.now() clock) until the returned stop function is called. */
  start(onFrame: (t: number, data: FrameData) => void): () => void;
}

type VideoFrameMeta = { presentationTime?: number; captureTime?: number; expectedDisplayTime?: number };
type RVFC = (cb: (now: number, meta: VideoFrameMeta) => void) => number;

/** The back camera, as large as the phone offers (1080p is plenty). */
export async function openCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser can’t use the camera here (it needs HTTPS and a recent Safari or Chrome).');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  return stream;
}

export function stopCamera(stream: MediaStream | null) { stream?.getTracks().forEach((t) => t.stop()); }

/** Frames from a playing <video>, scaled so the long side is PROCESS_SIZE. */
export function videoSource(video: HTMLVideoElement): FrameSource {
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const s = Math.min(1, PROCESS_SIZE / Math.max(vw, vh));
  const width = Math.round(vw * s), height = Math.round(vh * s);
  return {
    width, height,
    start(onFrame) {
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      let stopped = false;
      let last = -1;
      const grab = (t: number) => {
        if (stopped) return;
        ctx.drawImage(video, 0, 0, width, height);
        onFrame(t, { rgba: ctx.getImageData(0, 0, width, height).data.buffer as ArrayBuffer });
      };
      const rvfc = (video as unknown as { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback?.bind(video);
      if (rvfc) {
        // One callback per new camera frame. Its timestamps are steadier than "now".
        const onVideo = (now: number, meta: VideoFrameMeta) => {
          if (stopped) return;
          const cand = [meta.captureTime, meta.presentationTime].find((v) => v !== undefined && Number.isFinite(v) && v > now - 1000 && v <= now + 50);
          grab(cand ?? now);
          rvfc(onVideo);
        };
        rvfc(onVideo);
      } else {
        // Older browsers: poll, keeping only new pictures.
        const tick = () => {
          if (stopped) return;
          if (video.currentTime !== last) { last = video.currentTime; grab(performance.now()); }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }
      return () => { stopped = true; };
    },
  };
}

/** Demo spots: in front of the lights, left, middle and right, like the night-test plan. */
export function demoViews(layout: LayoutConfig, width: number, height: number): SimView[] {
  const l = buildLayout(layout);
  const { min, max } = l.bounds;
  const c: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const span = Math.max(4, max[0] - min[0]);
  const back = span * 1.15 + 3;
  return [-0.45, 0.05, 0.5].map((side) => ({
    eye: [c[0] + side * span, c[1] - 0.6, max[2] + back] as Vec3, target: c, hfovDeg: 67, width, height,
  }));
}

/**
 * Simulated camera for demo mode: renders the sequence as the phone would see it, in real time,
 * and paints each frame onto `canvas` as the "camera picture".
 */
export function simulatedSource(layout: LayoutConfig, plan: MappingPlan, view: SimView, startMs: number, canvas: HTMLCanvasElement | null): FrameSource {
  const built = buildLayout(layout);
  const masks = slotMasks(built, plan);
  return {
    width: view.width, height: view.height,
    start(onFrame) {
      const gen = simulateFrames({
        positions: built.positions, masks, holdMs: plan.params.holdMs, view, startMs: startMs + 70,
        fromMs: performance.now(), toMs: startMs + plan.durationMs + 2000, seed: Math.floor(startMs) % 1000, shakePx: 0.3,
      });
      const ctx = canvas?.getContext('2d');
      const img = ctx ? ctx.createImageData(view.width, view.height) : null;
      if (canvas) { canvas.width = view.width; canvas.height = view.height; }
      let pending = gen.next();
      const timer = setInterval(() => {
        let latest: Uint8Array | null = null;
        while (!pending.done && pending.value.t <= performance.now()) {
          const f = pending.value;
          latest = f.lum;
          onFrame(f.t, { lum: f.lum.slice().buffer });
          pending = gen.next();
        }
        if (latest && ctx && img) {
          for (let i = 0, j = 0; i < latest.length; i++, j += 4) { const v = latest[i]!; img.data[j] = v; img.data[j + 1] = v; img.data[j + 2] = Math.min(255, v * 1.08); img.data[j + 3] = 255; }
          ctx.putImageData(img, 0, 0);
        }
      }, 15);
      return () => clearInterval(timer);
    },
  };
}

/** Paints a still picture of a demo view (before any sequence) so the screen isn't blank. */
export function paintIdle(canvas: HTMLCanvasElement, layout: LayoutConfig, plan: MappingPlan, view: SimView) {
  const gen = simulateFrames({ positions: buildLayout(layout).positions, masks: [], holdMs: plan.params.holdMs, view, startMs: 1e12, fromMs: 0, toMs: 1, seed: 1 });
  const f = gen.next();
  if (f.done) return;
  canvas.width = view.width; canvas.height = view.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(view.width, view.height);
  for (let i = 0, j = 0; i < f.value.lum.length; i++, j += 4) { const v = f.value.lum[i]!; img.data[j] = v; img.data[j + 1] = v; img.data[j + 2] = v * 1.08; img.data[j + 3] = 255; }
  ctx.putImageData(img, 0, 0);
}

export interface ViewRun {
  /** Resolves once the sequence is over and decoded. */
  result: Promise<DecodeResult>;
  cancel: () => void;
}

/** Film and decode one view: feed frames from shortly before the expected start until just after the end. */
export function runView(source: FrameSource, plan: MappingPlan, startGuessMs: number): ViewRun {
  const worker = new DecodeWorker(plan, { width: source.width, height: source.height, startGuessMs });
  const from = startGuessMs - 1200, until = startGuessMs + plan.durationMs + 900;
  let cancelled = false;
  let stop: () => void = () => {};
  const result = new Promise<DecodeResult>((resolve, reject) => {
    stop = source.start((t, data) => { if (t >= from && t <= until) worker.frame(t, source.width, source.height, data); });
    const check = setInterval(() => {
      if (cancelled) { clearInterval(check); stop(); worker.cancel(); reject(new Error('cancelled')); return; }
      if (performance.now() < until) return;
      clearInterval(check);
      stop();
      worker.finish().then(resolve, reject);
    }, 100);
  });
  return { result, cancel: () => { cancelled = true; } };
}
