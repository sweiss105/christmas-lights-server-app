import type { DecodeResult, DecoderOptions, MappingPlan } from '@xmas/engine/mapping';

/** Messages to the decode worker. A frame carries either RGBA (from the camera) or greyscale (from the simulator). */
export type WorkerIn =
  | { type: 'start'; plan: MappingPlan; options: DecoderOptions }
  | { type: 'frame'; t: number; width: number; height: number; rgba?: ArrayBuffer; lum?: ArrayBuffer }
  | { type: 'finish' };

export type WorkerOut =
  | { type: 'progress'; frames: number; synced: boolean }
  | { type: 'result'; result: DecodeResult }
  | { type: 'error'; message: string };

/** Greyscale from RGBA, weighted towards green like the eye (and the camera's sensor). */
export function rgbaToLum(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = (rgba[j]! + 2 * rgba[j + 1]! + rgba[j + 2]!) >> 2;
  return out;
}

/** Runs the decoder in a worker; resolves with the result when `finish()` is called. */
export class DecodeWorker {
  private worker: Worker;
  private done: ((r: DecodeResult) => void) | null = null;
  private fail: ((e: Error) => void) | null = null;
  private error: Error | null = null;
  framesSent = 0;
  synced = false;

  constructor(plan: MappingPlan, options: DecoderOptions) {
    this.worker = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === 'progress') this.synced = m.synced;
      else if (m.type === 'result') this.done?.(m.result);
      else if (m.type === 'error') { this.error = new Error(m.message); this.fail?.(this.error); }
    };
    this.worker.onerror = (e) => { this.error = new Error(e.message || 'the decoder stopped'); this.fail?.(this.error); };
    this.post({ type: 'start', plan, options });
  }

  private post(m: WorkerIn, transfer: Transferable[] = []) { this.worker.postMessage(m, transfer); }

  /** Hand over one frame (the buffer moves to the worker). */
  frame(t: number, width: number, height: number, data: { rgba: ArrayBuffer } | { lum: ArrayBuffer }) {
    this.framesSent++;
    const buf = 'rgba' in data ? data.rgba : data.lum;
    this.post({ type: 'frame', t, width, height, ...data }, [buf]);
  }

  finish(): Promise<DecodeResult> {
    return new Promise((resolve, reject) => {
      if (this.error) { reject(this.error); this.worker.terminate(); return; }
      this.done = (r) => { resolve(r); this.worker.terminate(); };
      this.fail = (e) => { reject(e); this.worker.terminate(); };
      this.post({ type: 'finish' });
    });
  }

  cancel() { this.worker.terminate(); }
}
