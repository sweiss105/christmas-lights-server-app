/**
 * Sends values as fast as the server accepts them, always the newest one, never a backlog.
 * While a request is in flight, further values replace each other; when it finishes, the latest
 * is sent. Used for sliders, so dragging stays responsive without a debounce delay.
 */
export function latestWins<T>(send: (value: T) => Promise<unknown>, onError: (e: unknown) => void = () => {}) {
  let inFlight = false;
  let pending: { value: T } | null = null;

  const run = async (value: T) => {
    inFlight = true;
    try { await send(value); } catch (e) { onError(e); }
    inFlight = false;
    if (pending) {
      const next = pending.value;
      pending = null;
      void run(next);
    }
  };

  return (value: T) => {
    if (inFlight) pending = { value };
    else void run(value);
  };
}
