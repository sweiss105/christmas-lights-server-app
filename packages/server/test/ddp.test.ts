import { describe, expect, it } from 'vitest';
import { buildPackets, DDP_MAX_DATA, parsePacket } from '../src/ddp.js';

describe('DDP packets', () => {
  it('splits 1450 pixels into 480-pixel packets with byte offsets and PUSH on the last', () => {
    const data = new Uint8Array(1450 * 3).map((_, i) => i & 255);
    const pkts = buildPackets(data, 1).map(parsePacket);
    expect(pkts.map((p) => p.data.length)).toEqual([1440, 1440, 1440, 30]);
    expect(pkts.map((p) => p.offset)).toEqual([0, 1440, 2880, 4320]);
    expect(pkts.map((p) => p.push)).toEqual([false, false, false, true]);
    expect(pkts.every((p) => p.type === 0x0b && p.dest === 1 && p.sequence === 1)).toBe(true);
    const joined = Buffer.concat(pkts.map((p) => p.data));
    expect(joined.equals(Buffer.from(data))).toBe(true);
  });

  it('writes the exact header bytes', () => {
    const [p] = buildPackets(new Uint8Array([1, 2, 3]), 7);
    expect([...p!.subarray(0, 10)]).toEqual([0x41, 7, 0x0b, 1, 0, 0, 0, 0, 0, 3]);
  });

  it('keeps sequence numbers in 1..15', () => {
    const seqs = [1, 15, 16, 30, 31].map((s) => parsePacket(buildPackets(new Uint8Array(3), s)[0]!).sequence);
    expect(seqs).toEqual([1, 15, 1, 15, 1]);
  });

  it('never exceeds an Ethernet MTU', () => {
    expect(Math.max(...buildPackets(new Uint8Array(10000), 1).map((p) => p.length))).toBeLessThanOrEqual(DDP_MAX_DATA + 10);
  });
});
