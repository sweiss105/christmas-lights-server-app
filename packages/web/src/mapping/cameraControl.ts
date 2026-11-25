/**
 * Phone camera controls for mapping (what Safari lets a web page set varies by iOS version, so
 * every setting is tried on its own and the outcome reported), and a recorder that keeps a small
 * greyscale copy of a spot's footage for checking the decoder against real video.
 */

/** Which camera and frame rate to film with, chosen in the mapping settings. */
export interface CameraChoice {
  /** A specific camera (e.g. the 0.5× ultra wide), or '' for the default back camera. */
  deviceId: string;
  /** Use the camera's zoom to go wider than 1× (on phones that offer it as zoom rather than a separate camera). */
  zoomOut: boolean;
  fps: 30 | 60;
  /** Lock exposure, white balance and focus when filming starts. */
  lock: boolean;
  /** Exposure compensation while locked, in EV (negative darkens: less glare around each light). */
  ev: number;
  /** Keep a small copy of the footage and upload it with the spot. */
  record: boolean;
}

export const DEFAULT_CAMERA: CameraChoice = { deviceId: '', zoomOut: false, fps: 60, lock: true, ev: -1, record: true };

export interface CameraInfo {
  label: string;
  /** The track's settings as the browser reports them (width, height, frameRate, zoom, …). */
  settings: Record<string, unknown>;
  /** What the browser says it can change. */
  capabilities: Record<string, unknown>;
  /** Outcome of each control we tried: 'ok', 'unsupported' or an error message. */
  applied: Record<string, string>;
}

export interface BackCamera { deviceId: string; label: string }

/** Back cameras the browser lists (labels only appear once camera access was granted). */
export async function listBackCameras(): Promise<BackCamera[]> {
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  return all.filter((d) => d.kind === 'videoinput' && !/front|facetime|user/i.test(d.label))
    .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Camera' }));
}

type Caps = MediaTrackCapabilities & Record<string, unknown>;
type Range = { min?: number; max?: number; step?: number };

const capsOf = (track: MediaStreamTrack): Caps => ((track.getCapabilities?.() ?? {}) as Caps);

/** Try one constraint set; returns 'ok', 'unsupported' or the browser's error. */
async function tryApply(track: MediaStreamTrack, name: string, c: Record<string, unknown>): Promise<string> {
  try {
    await track.applyConstraints({ advanced: [c] } as MediaTrackConstraints);
    return 'ok';
  } catch (e) { return `${name}: ${(e as Error).message || 'refused'}`; }
}

/** Settings that apply for the whole session: zoom (for the wide view). */
export async function applyBaseControls(track: MediaStreamTrack, choice: CameraChoice): Promise<Record<string, string>> {
  const caps = capsOf(track);
  const out: Record<string, string> = {};
  const zoom = caps.zoom as Range | undefined;
  if (choice.zoomOut) {
    if (zoom?.min !== undefined && zoom.min < 1) out.zoom = await tryApply(track, 'zoom', { zoom: zoom.min });
    else out.zoom = 'unsupported';
  }
  return out;
}

/** Lock exposure, white balance and focus where the camera allows, darkening by `ev`. */
export async function lockCamera(track: MediaStreamTrack, choice: CameraChoice): Promise<Record<string, string>> {
  const caps = capsOf(track);
  const out: Record<string, string> = {};
  const has = (k: string, mode: string) => Array.isArray(caps[k]) && (caps[k] as string[]).includes(mode);
  const evr = caps.exposureCompensation as Range | undefined;
  if (evr?.min !== undefined && evr.max !== undefined) {
    const ev = Math.max(evr.min, Math.min(evr.max, choice.ev));
    out.exposureCompensation = await tryApply(track, 'exposureCompensation', { exposureCompensation: ev });
  } else out.exposureCompensation = 'unsupported';
  // Let the darker setting take effect before freezing it.
  await new Promise((r) => setTimeout(r, 400));
  out.exposureMode = has('exposureMode', 'manual') ? await tryApply(track, 'exposureMode', { exposureMode: 'manual' }) : 'unsupported';
  out.whiteBalanceMode = has('whiteBalanceMode', 'manual') ? await tryApply(track, 'whiteBalanceMode', { whiteBalanceMode: 'manual' }) : 'unsupported';
  out.focusMode = has('focusMode', 'manual') ? await tryApply(track, 'focusMode', { focusMode: 'manual' }) : 'unsupported';
  return out;
}

/** Back to automatic after filming, so the live picture looks normal again. */
export async function unlockCamera(track: MediaStreamTrack): Promise<void> {
  const caps = capsOf(track);
  const c: Record<string, unknown> = {};
  for (const k of ['exposureMode', 'whiteBalanceMode', 'focusMode']) if (Array.isArray(caps[k]) && (caps[k] as string[]).includes('continuous')) c[k] = 'continuous';
  const evr = caps.exposureCompensation as Range | undefined;
  if (evr?.min !== undefined) c.exposureCompensation = 0;
  if (Object.keys(c).length) await track.applyConstraints({ advanced: [c] } as MediaTrackConstraints).catch(() => {});
}

export function describeCamera(track: MediaStreamTrack, applied: Record<string, string>): CameraInfo {
  const plain = (o: object) => JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
  return { label: track.label, settings: plain(track.getSettings?.() ?? {}), capabilities: plain(capsOf(track)), applied };
}

/** Short summary for the settings panel: what got locked. */
export function lockSummary(applied: Record<string, string>): string {
  const names: Record<string, string> = { exposureMode: 'exposure', whiteBalanceMode: 'white balance', focusMode: 'focus', exposureCompensation: 'darkening', zoom: 'wide zoom' };
  const ok = Object.entries(applied).filter(([, v]) => v === 'ok').map(([k]) => names[k] ?? k);
  const no = Object.entries(applied).filter(([, v]) => v !== 'ok').map(([k]) => names[k] ?? k);
  return [ok.length ? `Locked: ${ok.join(', ')}` : '', no.length ? `Not available: ${no.join(', ')}` : ''].filter(Boolean).join(' · ');
}

// ---- recording -------------------------------------------------------------------------------

/** Width of the recorded greyscale copy (half the decoder's picture). */
export const RECORD_WIDTH = 640;
/** Cloudflare refuses requests over 100 MB. */
export const MAX_RECORDING_BYTES = 95 * 1024 * 1024;

/**
 * Keeps a half-size greyscale copy of each frame, gzip-compressed as it goes (night footage is mostly
 * black, so it shrinks a lot). File layout: frames back to back (width × height bytes each), then a
 * JSON trailer (sizes, frame times, plan, camera), then the trailer's length as a 4-byte little-endian
 * number.
 */
export class Recorder {
  readonly width: number;
  readonly height: number;
  /** Decoder pixels per recorded pixel, each way. */
  private step: number;
  private times: number[] = [];
  private writer: WritableStreamDefaultWriter<BufferSource> | null = null;
  private blob: Promise<Blob> | null = null;
  private plain: Uint8Array[] = [];
  private bytes = 0;
  readonly compressed: boolean;

  constructor(srcWidth: number, srcHeight: number) {
    const s = Math.max(1, Math.round(srcWidth / RECORD_WIDTH));
    this.width = Math.floor(srcWidth / s);
    this.height = Math.floor(srcHeight / s);
    this.step = s;
    this.compressed = typeof CompressionStream !== 'undefined';
    if (this.compressed) {
      const cs = new CompressionStream('gzip');
      this.writer = cs.writable.getWriter();
      this.blob = new Response(cs.readable).blob();
    }
  }

  /** Add one RGBA frame at the decoder's size (call before the buffer moves to the worker). */
  add(t: number, rgba: ArrayBuffer, srcWidth: number) {
    const src = new Uint8Array(rgba);
    const { width: w, height: h, step: s } = this;
    const out = new Uint8Array(w * h);
    const n = s * s;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let dy = 0; dy < s; dy++) {
          let i = ((y * s + dy) * srcWidth + x * s) * 4;
          for (let dx = 0; dx < s; dx++, i += 4) sum += (src[i]! * 54 + src[i + 1]! * 183 + src[i + 2]! * 19) >> 8;
        }
        out[y * w + x] = Math.round(sum / n);
      }
    }
    this.times.push(Math.round(t * 10) / 10);
    this.bytes += out.length;
    if (this.writer) void this.writer.write(out);
    else this.plain.push(out);
  }

  get frames() { return this.times.length; }

  /** Close the file with its trailer. */
  async finish(meta: Record<string, unknown>): Promise<Blob> {
    const trailer = new TextEncoder().encode(JSON.stringify({ format: 'xmas-map-recording/1', width: this.width, height: this.height, frames: this.times.length, times: this.times, ...meta }));
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, trailer.length, true);
    if (this.writer) {
      await this.writer.write(trailer);
      await this.writer.write(len);
      await this.writer.close();
      return this.blob!;
    }
    return new Blob([...this.plain, trailer, len] as BlobPart[]);
  }

  cancel() { void this.writer?.abort().catch(() => {}); this.plain = []; }
}
