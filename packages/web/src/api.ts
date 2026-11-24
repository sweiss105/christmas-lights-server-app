import type { LayoutConfig, SceneConfig } from '@xmas/engine';

export interface ControllerHealth {
  id: string;
  host: string;
  online: boolean;
  framesSent: number;
  sendErrors: number;
  lastError?: string;
  info?: { name: string; version: string; ledCount: number };
  warning?: string;
}

export interface Status {
  scene: string | null;
  stage: { scene: string | null; dirty: boolean };
  pixels: number;
  output: { brightness: number; gamma: number; enabled: boolean };
  stream: { running: boolean; targetFps: number; fps: number; renderMs: number; lateFrames: number; controllers: ControllerHealth[] };
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  // Cloudflare Access sends an expired session to its login page; reload to sign in again.
  if (res.redirected && !res.url.startsWith(location.origin)) { location.reload(); throw new ApiError(401, 'signing in again'); }
  const text = await res.text();
  let data: unknown = undefined;
  try { data = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? `${method} ${path} failed (${res.status})`);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  status: () => call<Status>('GET', '/api/status'),
  clock: async () => (await call<{ t: number }>('GET', '/api/clock')).t,
  layout: () => call<LayoutConfig>('GET', '/api/layout'),
  scenes: () => call<{ active: string | null; scenes: SceneConfig[] }>('GET', '/api/scenes'),
  stage: () => call<SceneConfig>('GET', '/api/stage'),
  /** Go: put a saved scene on the porch. */
  go: (name: string) => call<{ active: string }>('POST', `/api/scenes/${enc(name)}/activate`),
  blackout: () => call<{ active: null }>('POST', '/api/blackout'),
  setOutput: (o: Partial<{ brightness: number; enabled: boolean; fps: number }>) => call<Status['output']>('PATCH', '/api/output', o),
};
