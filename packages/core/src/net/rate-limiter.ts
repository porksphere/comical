/**
 * A small concurrency + min-interval limiter so the runtime stays polite to a user's backend.
 * Bounds how many requests run at once and enforces a minimum gap between request *starts*.
 */
export interface RateLimitOptions {
  /** Maximum requests in flight at once. */
  maxConcurrent: number;
  /** Minimum milliseconds between successive request starts. */
  minIntervalMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  maxConcurrent: 3,
  minIntervalMs: 200,
};

export class RateLimiter {
  private readonly opts: RateLimitOptions;
  private active = 0;
  private lastStart = 0;
  private readonly queue: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: Partial<RateLimitOptions> = {}) {
    this.opts = { ...DEFAULT_RATE_LIMIT, ...opts };
  }

  /** Resolves when the caller may start; the caller MUST later call the returned release fn. */
  async acquire(): Promise<() => void> {
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain(): void {
    if (this.active >= this.opts.maxConcurrent || this.queue.length === 0) return;

    const now = Date.now();
    const wait = Math.max(0, this.lastStart + this.opts.minIntervalMs - now);
    if (wait > 0) {
      if (this.timer === undefined) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.drain();
        }, wait);
      }
      return;
    }

    const resolve = this.queue.shift();
    if (!resolve) return;
    this.active++;
    this.lastStart = Date.now();
    resolve();
    // Try to start more (subject to interval) on the next tick.
    if (this.queue.length > 0) this.drain();
  }
}
