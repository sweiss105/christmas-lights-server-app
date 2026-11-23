/** Minimal WLED JSON API client + mDNS discovery. */
import { Bonjour } from 'bonjour-service';

export interface WledInfo { name: string; version: string; ledCount: number; mac: string; ip?: string; realtime?: boolean; arch?: string }

const TIMEOUT_MS = 2500;

async function wledFetch(host: string, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`http://${host}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`WLED ${host}${path} → HTTP ${res.status}`);
  return res.json();
}

export async function getInfo(host: string): Promise<WledInfo> {
  const j = (await wledFetch(host, '/json/info')) as Record<string, any>;
  if (typeof j?.ver !== 'string' || typeof j?.leds?.count !== 'number') throw new Error(`${host} did not answer like a WLED controller`);
  return { name: j.name, version: j.ver, ledCount: j.leds.count, mac: j.mac, ip: j.ip, realtime: j.live, arch: j.arch };
}

export async function getPresets(host: string): Promise<{ id: number; name: string }[]> {
  const j = (await wledFetch(host, '/presets.json')) as Record<string, { n?: string }>;
  return Object.entries(j)
    .filter(([id, p]) => id !== '0' && p && Object.keys(p).length > 0)
    .map(([id, p]) => ({ id: Number(id), name: p.n ?? `Preset ${id}` }))
    .sort((a, b) => a.id - b.id);
}

export async function setState(host: string, state: Record<string, unknown>): Promise<void> {
  await wledFetch(host, '/json/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) });
}

/** Leave realtime (DDP) mode and, if given, load a preset so the controller runs on its own. */
export function releaseToPreset(host: string, preset?: number): Promise<void> {
  return setState(host, preset ? { live: false, on: true, ps: preset } : { live: false });
}

export interface Discovered { host: string; port: number; mdnsName: string; info?: WledInfo; error?: string }

/** Browse mDNS for `_wled._tcp` for `timeoutMs`, then query each controller's /json/info. */
export async function discover(timeoutMs = 3000): Promise<Discovered[]> {
  const bonjour = new Bonjour();
  const found = new Map<string, Discovered>();
  try {
    await new Promise<void>((resolve) => {
      const browser = bonjour.find({ type: 'wled' }, (svc) => {
        const host = svc.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? svc.host;
        if (host && !found.has(host)) found.set(host, { host, port: svc.port, mdnsName: svc.name });
      });
      setTimeout(() => { browser.stop(); resolve(); }, timeoutMs);
    });
  } finally {
    bonjour.destroy();
  }
  return Promise.all([...found.values()].map(async (d) => {
    try { return { ...d, info: await getInfo(d.host) }; } catch (e) { return { ...d, error: (e as Error).message }; }
  }));
}
