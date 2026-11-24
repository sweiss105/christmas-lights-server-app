/**
 * Aligns the browser's effect clock with the server's, so the preview renders the same frame the
 * porch is showing. All times are in seconds.
 */
export interface ClockSample {
  /** Local time (performance.now()/1000) when the request was sent. */
  sentAt: number;
  /** Local time when the response arrived. */
  receivedAt: number;
  /** Server effect time reported in the response. */
  serverT: number;
}

/**
 * Offset to add to local time to get server effect time. Uses the sample with the shortest round
 * trip (the least network noise) and assumes the server read its clock halfway through it.
 */
export function estimateOffset(samples: ClockSample[]): number {
  if (!samples.length) throw new Error('no clock samples');
  const best = samples.reduce((a, b) => (b.receivedAt - b.sentAt < a.receivedAt - a.sentAt ? b : a));
  const midpoint = (best.sentAt + best.receivedAt) / 2;
  return best.serverT - midpoint;
}

export class ServerClock {
  private offset = 0;
  synced = false;

  constructor(private readonly fetchT: () => Promise<number>, private readonly localNow = () => performance.now() / 1000) {}

  /** Effect time now, in step with the server once synced. */
  now(): number { return this.localNow() + this.offset; }

  /** Local time (performance.now()/1000) at which the server's clock reads `serverT`. */
  toLocal(serverT: number): number { return serverT - this.offset; }

  async sync(rounds = 5): Promise<void> {
    const samples: ClockSample[] = [];
    for (let i = 0; i < rounds; i++) {
      const sentAt = this.localNow();
      const serverT = await this.fetchT();
      samples.push({ sentAt, receivedAt: this.localNow(), serverT });
    }
    this.offset = estimateOffset(samples);
    this.synced = true;
  }
}
