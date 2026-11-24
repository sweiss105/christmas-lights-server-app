/**
 * Decodes a mapping view off the main thread: frames arrive as RGBA picture data as they're
 * recorded, are turned to greyscale and fed to the decoder, so the camera preview stays smooth.
 */
import { MappingDecoder } from '@xmas/engine/mapping';
import { rgbaToLum, type WorkerIn, type WorkerOut } from './workerProtocol';

const ctx = self as unknown as { onmessage: ((e: MessageEvent<WorkerIn>) => void) | null; postMessage: (m: WorkerOut, transfer?: Transferable[]) => void };
let decoder: MappingDecoder | null = null;
let count = 0;

ctx.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'start') { decoder = new MappingDecoder(m.plan, m.options); count = 0; return; }
    if (!decoder) return;
    if (m.type === 'frame') {
      decoder.push(m.t, m.lum ? new Uint8Array(m.lum) : rgbaToLum(new Uint8ClampedArray(m.rgba!), m.width, m.height));
      if (++count % 10 === 0) ctx.postMessage({ type: 'progress', frames: count, synced: decoder.synced });
      return;
    }
    if (m.type === 'finish') {
      const result = decoder.finish();
      decoder = null;
      ctx.postMessage({ type: 'result', result });
    }
  } catch (err) {
    decoder = null;
    ctx.postMessage({ type: 'error', message: (err as Error).message });
  }
};
