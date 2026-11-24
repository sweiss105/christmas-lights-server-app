import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Recorder } from '../src/mapping/cameraControl.js';

describe('footage recorder', () => {
  it('keeps half-size greyscale frames, gzip-compressed, with a JSON trailer', async () => {
    const w = 1280, h = 720;
    const rec = new Recorder(w, h);
    expect([rec.width, rec.height]).toEqual([640, 360]);
    for (let f = 0; f < 3; f++) {
      const rgba = new Uint8Array(w * h * 4);
      // A white 2×2 square at decoder pixel (100 + f, 50): one recorded pixel at (50, 25) when f is even.
      for (const [x, y] of [[100, 50], [101, 50], [100, 51], [101, 51]]) rgba.set([255, 255, 255, 255], ((y! * w) + x! + f * 2) * 4);
      rec.add(1000 + f * 16.7, rgba.buffer, w);
    }
    const blob = await rec.finish({ label: 'Spot 1' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(rec.compressed).toBe(true);
    const raw = gunzipSync(bytes);
    const len = raw.readUInt32LE(raw.length - 4);
    const trailer = JSON.parse(raw.subarray(raw.length - 4 - len, raw.length - 4).toString('utf8'));
    expect(trailer).toMatchObject({ format: 'xmas-map-recording/1', width: 640, height: 360, frames: 3, times: [1000, 1016.7, 1033.4], label: 'Spot 1' });
    expect(raw.length - 4 - len).toBe(3 * 640 * 360);
    const frame0 = raw.subarray(0, 640 * 360);
    expect(frame0[25 * 640 + 50]).toBe(255);
    expect(frame0[25 * 640 + 49]).toBe(0);
    const frame1 = raw.subarray(640 * 360, 2 * 640 * 360);
    expect(frame1[25 * 640 + 51]).toBe(255); // moved 2 decoder pixels = 1 recorded pixel
  });
});
