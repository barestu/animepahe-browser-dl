// Cooperative pause / cancel primitive shared by the service worker and the offscreen document.
//
// Nothing here force-kills work: every long operation awaits `wait()` at an interruptible
// boundary (between segments, between jobs) and passes `signal` to fetch/abortable APIs.
// Pausing therefore PRESERVES in-flight progress — the workers simply block, the partially
// downloaded segment array stays in memory, and `resume()` continues where it stopped.

export class CanceledError extends Error {
  constructor(message = 'canceled') {
    super(message);
    this.name = 'CanceledError';
  }
}

export class Gate {
  private paused = false;
  private canceled = false;
  private waiters: Array<() => void> = [];
  private readonly controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get isPaused(): boolean {
    return this.paused;
  }
  get isCanceled(): boolean {
    return this.canceled;
  }

  pause(): void {
    if (!this.canceled) this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.release();
  }

  /** Terminal: aborts in-flight fetches and makes every future `wait()` throw. */
  cancel(): void {
    if (this.canceled) return;
    this.canceled = true;
    this.paused = false;
    try {
      this.controller.abort(new CanceledError());
    } catch {
      /* already aborted */
    }
    this.release();
  }

  /** Throws CanceledError if canceled; otherwise blocks for as long as the gate is paused. */
  async wait(): Promise<void> {
    if (this.canceled) throw new CanceledError();
    while (this.paused) {
      await new Promise<void>((r) => this.waiters.push(r));
      if (this.canceled) throw new CanceledError();
    }
  }

  private release(): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const r of pending) r();
  }
}

/** setTimeout that rejects with CanceledError the moment the gate is canceled. */
export function sleep(ms: number, gate?: Gate): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      gate?.signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CanceledError());
    };
    if (gate) {
      if (gate.isCanceled) {
        clearTimeout(timer);
        reject(new CanceledError());
        return;
      }
      gate.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
