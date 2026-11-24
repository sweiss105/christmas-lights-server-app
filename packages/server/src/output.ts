/** Fixed-rate render → DDP loop with per-controller health. */
import type { Engine } from '@xmas/engine';
import { DDP_PORT, DdpSender } from './ddp.js';
import { getInfo, releaseToPreset, type WledInfo } from './wled.js';

export interface ControllerHealth {
  id: string;
  host: string;
  online: boolean | null;
  info?: WledInfo;
  warning?: string;
  framesSent: number;
  sendErrors: number;
  lastError?: string;
}

export interface OutputStats {
  running: boolean;
  targetFps: number;
  fps: number;
  renderMs: number;
  lateFrames: number;
  controllers: ControllerHealth[];
}

export class OutputLoop {
  private sender = new DdpSender();
  private timer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private start = performance.now();
  private next = 0;
  private frameTimes: number[] = [];
  private renderMs = 0;
  private lateFrames = 0;
  private health = new Map<string, ControllerHealth>();

  /** Optional post-processing of each frame before it is sent (e.g. flashing one run to identify it). */
  overlay: ((frame: Uint8Array, t: number) => void) | null = null;

  constructor(private getEngine: () => Engine, public fps = 40) {}

  get running() { return this.timer !== null; }

  /** Seconds since the server started; effects animate on this clock. */
  now() { return (performance.now() - this.start) / 1000; }

  private controllers() { return this.getEngine().layout.config.controllers; }

  private healthFor(id: string, host: string): ControllerHealth {
    let h = this.health.get(id);
    if (!h || h.host !== host) { h = { id, host, online: null, framesSent: 0, sendErrors: 0 }; this.health.set(id, h); }
    return h;
  }

  startStreaming() {
    if (this.timer) return;
    this.next = performance.now();
    const tick = () => {
      const period = 1000 / this.fps;
      this.frame();
      this.next += period;
      const now = performance.now();
      if (now - this.next > period * 4) { this.lateFrames++; this.next = now; } // fell badly behind: resync rather than burst
      this.timer = setTimeout(tick, Math.max(0, this.next - now));
    };
    this.timer = setTimeout(tick, 0);
  }

  /** Stop streaming; controllers with a fallbackPreset load it, others drop out of realtime mode. */
  async stopStreaming(release = true) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!release) return;
    await Promise.allSettled(this.controllers().map((c) => releaseToPreset(c.host, c.fallbackPreset)));
  }

  private frame() {
    const engine = this.getEngine();
    const t0 = performance.now();
    const t = this.now();
    const frame = engine.render(t);
    this.overlay?.(frame, t);
    this.renderMs = this.renderMs * 0.9 + (performance.now() - t0) * 0.1;
    this.frameTimes.push(t0);
    while (this.frameTimes.length && t0 - this.frameTimes[0]! > 1000) this.frameTimes.shift();
    for (const c of engine.layout.config.controllers) {
      const off = engine.layout.controllerOffset.get(c.id)! * 3;
      const h = this.healthFor(c.id, c.host);
      // copy: the engine reuses its frame buffer on the next render
      this.sender.send(c.host, c.port ?? DDP_PORT, frame.slice(off, off + c.pixelCount * 3)).then(
        () => { h.framesSent++; },
        (e: Error) => { h.sendErrors++; h.lastError = e.message; },
      );
    }
  }

  /** Poll /json/info so the UI can show which controllers are up and whether LED counts match. */
  startHealthChecks(intervalMs = 10000) {
    const check = async () => {
      await Promise.all(this.controllers().map(async (c) => {
        const h = this.healthFor(c.id, c.host);
        try {
          h.info = await getInfo(c.host);
          h.online = true;
          h.warning = h.info.ledCount < c.pixelCount ? `WLED is set to ${h.info.ledCount} LEDs but layout uses ${c.pixelCount}` : undefined;
        } catch (e) {
          h.online = false;
          h.lastError = (e as Error).message;
        }
      }));
    };
    void check();
    this.healthTimer = setInterval(check, intervalMs);
  }

  stats(): OutputStats {
    return {
      running: this.running,
      targetFps: this.fps,
      fps: this.running ? this.frameTimes.length : 0,
      renderMs: Math.round(this.renderMs * 100) / 100,
      lateFrames: this.lateFrames,
      controllers: this.controllers().map((c) => this.healthFor(c.id, c.host)),
    };
  }

  async close() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    await this.stopStreaming(false);
    this.sender.close();
  }
}
