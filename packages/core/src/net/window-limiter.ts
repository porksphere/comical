/**
 * A sliding-window quota: at most `limit` starts in any `windowMs`, the shape an API documents
 * ("10 requests per minute"). Pairs with `RateLimiter`, which paces starts evenly — a route that
 * allows 10/min bursts fine under a 700ms bridge-wide interval until its 11th call, which this
 * holds until the oldest start has aged out of the window.
 */
export interface WindowLimitOptions {
  /** Starts allowed inside one window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export class WindowLimiter {
  private readonly opts: WindowLimitOptions;
  private starts: number[] = [];
  private pausedUntil = 0;
  private readonly queue: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: WindowLimitOptions) {
    this.opts = { ...opts };
  }

  reconfigure(opts: WindowLimitOptions): void {
    this.opts.limit = opts.limit;
    this.opts.windowMs = opts.windowMs;
    this.drain();
  }

  /** Hold every queued and future start until `until` (epoch ms); pauses only ever extend. */
  pauseUntil(until: number): void {
    if (until <= this.pausedUntil) return;
    this.pausedUntil = until;
    this.drain();
  }

  get pausedUntilMs(): number {
    return this.pausedUntil;
  }

  /** When the next start could happen if asked now (epoch ms; `now` when the window has room). */
  nextStartAt(now = Date.now()): number {
    this.prune(now);
    const byWindow = this.starts.length >= this.opts.limit ? this.starts[0]! + this.opts.windowMs : now;
    return Math.max(now, byWindow, this.pausedUntil);
  }

  /** Resolves when the caller may start. A window counts starts, so nothing is released afterwards. */
  async acquire(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }

  private prune(now: number): void {
    const cutoff = now - this.opts.windowMs;
    let i = 0;
    while (i < this.starts.length && this.starts[i]! <= cutoff) i++;
    if (i > 0) this.starts = this.starts.slice(i);
  }

  private drain(): void {
    if (this.queue.length === 0) return;
    const now = Date.now();
    const at = this.nextStartAt(now);
    if (at > now) {
      if (this.timer === undefined) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.drain();
        }, at - now);
      }
      return;
    }
    const resolve = this.queue.shift();
    if (!resolve) return;
    this.starts.push(now);
    resolve();
    if (this.queue.length > 0) this.drain();
  }
}
