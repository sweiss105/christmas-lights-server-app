import dgram from 'node:dgram';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parsePacket } from '../src/ddp.js';

/** Receives DDP like WLED does and assembles complete frames on PUSH. */
export async function fakeDdpReceiver(pixelCount: number) {
  const sock = dgram.createSocket('udp4');
  const frames: { at: number; data: Buffer }[] = [];
  let buf = Buffer.alloc(pixelCount * 3);
  sock.on('message', (msg) => {
    const p = parsePacket(msg);
    p.data.copy(buf, p.offset);
    if (p.push) { frames.push({ at: performance.now(), data: Buffer.from(buf) }); buf = Buffer.alloc(pixelCount * 3); }
  });
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', r));
  return { port: (sock.address() as AddressInfo).port, frames, close: () => new Promise<void>((r) => sock.close(() => r())) };
}

/** Stub of the WLED JSON API. */
export async function fakeWledHttp(ledCount = 1450) {
  const posts: unknown[] = [];
  const srv = http.createServer((req, res) => {
    const send = (o: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.url === '/json/info') return send({ ver: '0.15.1', name: 'Left', leds: { count: ledCount }, mac: 'aabbccddeeff', live: false, arch: 'esp32' });
    if (req.url === '/presets.json') return send({ '0': {}, '1': { n: 'Warm' }, '3': { n: 'Chase' }, '2': {} });
    if (req.url === '/json/state' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { posts.push(JSON.parse(body)); send({ success: true }); });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { host: `127.0.0.1:${(srv.address() as AddressInfo).port}`, posts, close: () => new Promise<void>((r) => srv.close(() => r())) };
}
