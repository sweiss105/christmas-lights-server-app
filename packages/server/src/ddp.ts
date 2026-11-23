/**
 * DDP (Distributed Display Protocol) — http://www.3waylabs.com/ddp/
 * 10-byte header + up to 1440 bytes of RGB data per UDP packet. WLED listens on 4048.
 */
import dgram from 'node:dgram';

export const DDP_PORT = 4048;
export const DDP_HEADER_LEN = 10;
/** 480 RGB pixels; matches WLED's DDP_CHANNELS_PER_PACKET and stays under a 1500-byte MTU. */
export const DDP_MAX_DATA = 1440;

const FLAG_VER1 = 0x40;
const FLAG_PUSH = 0x01;
/** RGB, 8 bits per channel (what WLED itself sends). */
const TYPE_RGB24 = 0x0b;
const DEST_DEFAULT = 0x01;

/** Split one controller's RGB buffer into DDP packets. The last packet carries PUSH so the frame latches at once. */
export function buildPackets(data: Uint8Array, sequence: number, maxData = DDP_MAX_DATA): Buffer[] {
  if (maxData % 3 !== 0) throw new Error('maxData must be a multiple of 3');
  const seq = ((sequence - 1) % 15) + 1; // 1..15; 0 means "sequence not used"
  const packets: Buffer[] = [];
  for (let offset = 0; offset < data.length || (offset === 0 && data.length === 0); offset += maxData) {
    const len = Math.min(maxData, data.length - offset);
    const last = offset + len >= data.length;
    const pkt = Buffer.allocUnsafe(DDP_HEADER_LEN + len);
    pkt[0] = FLAG_VER1 | (last ? FLAG_PUSH : 0);
    pkt[1] = seq & 0x0f;
    pkt[2] = TYPE_RGB24;
    pkt[3] = DEST_DEFAULT;
    pkt.writeUInt32BE(offset, 4);
    pkt.writeUInt16BE(len, 8);
    pkt.set(data.subarray(offset, offset + len), DDP_HEADER_LEN);
    packets.push(pkt);
    if (data.length === 0) break;
  }
  return packets;
}

export interface ParsedPacket { push: boolean; sequence: number; type: number; dest: number; offset: number; data: Buffer }

export function parsePacket(pkt: Buffer): ParsedPacket {
  if (pkt.length < DDP_HEADER_LEN || (pkt[0]! & 0xc0) !== FLAG_VER1) throw new Error('not a DDP v1 packet');
  const len = pkt.readUInt16BE(8);
  return { push: (pkt[0]! & FLAG_PUSH) !== 0, sequence: pkt[1]! & 0x0f, type: pkt[2]!, dest: pkt[3]!, offset: pkt.readUInt32BE(4), data: pkt.subarray(DDP_HEADER_LEN, DDP_HEADER_LEN + len) };
}

export class DdpSender {
  private socket = dgram.createSocket('udp4');
  private sequence = 0;
  constructor() { this.socket.on('error', () => { /* per-send errors are reported via callbacks */ }); }

  /** Send one frame to a controller. Resolves with the number of packets, rejects on socket error. */
  send(host: string, port: number, data: Uint8Array): Promise<number> {
    const packets = buildPackets(data, ++this.sequence);
    return new Promise((resolve, reject) => {
      let pending = packets.length, failed = false;
      for (const p of packets) {
        this.socket.send(p, port, host, (err) => {
          if (failed) return;
          if (err) { failed = true; reject(err); return; }
          if (--pending === 0) resolve(packets.length);
        });
      }
    });
  }

  close() { this.socket.close(); }
}
