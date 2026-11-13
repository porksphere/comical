/**
 * The line a bridge's image interceptions wait in before they reach the bridge.
 *
 * An interception is a paced round-trip to the source (e-hentai: one viewer page per image, a few
 * seconds apart), and inside the bridge it waits in the runtime's rate limiter, which can't tell
 * that the client gave up. A reader scrolled past forty pages left forty interceptions queued
 * there, each spending the source's budget on a page nobody would see, ahead of the page being
 * looked at. Waiting HERE instead, where the request's signal is known, lets one whose every asker
 * has gone leave the line before it costs anything.
 *
 * First come, first served: a client asks for pages in the order it wants them (the page on screen,
 * then the warm-ahead in reading order), and dropping the abandoned ones is what keeps a stale
 * request from blocking a new one. Asks for the same key share one interception.
 */
export class AbandonedError extends Error {
  constructor() {
    super("every asker went away before its turn");
    this.name = "AbandonedError";
  }
}

interface Entry {
  key: string;
  run: () => Promise<unknown>;
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  askers: number;
  started: boolean;
}

export class InterceptQueue {
  private running = 0;
  private readonly waiting: Entry[] = [];
  private readonly byKey = new Map<string, Entry>();

  /** `concurrency` is read on every pump, so a bridge whose declared limits change is followed. */
  constructor(private readonly concurrency: () => number) {}

  /** Requests waiting for a turn. */
  get queued(): number {
    return this.waiting.length;
  }

  /**
   * Run `fn` in its turn, or join the ask already queued or running under `key`. Rejects with
   * {@link AbandonedError} when `signal` aborts before the turn and no other asker remains. Once
   * started, an interception is left to finish: its answer is still worth remembering.
   */
  run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let entry = this.byKey.get(key);
    if (!entry) {
      let resolve!: (v: unknown) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      entry = { key, run: fn, promise, resolve, reject, askers: 0, started: false };
      this.byKey.set(key, entry);
      this.waiting.push(entry);
    }
    const joined = entry;
    joined.askers++;
    if (signal) {
      if (signal.aborted) this.leave(joined);
      else signal.addEventListener("abort", () => this.leave(joined), { once: true });
    }
    this.pump();
    return joined.promise as Promise<T>;
  }

  private leave(entry: Entry): void {
    entry.askers--;
    if (entry.started || entry.askers > 0) return;
    const at = this.waiting.indexOf(entry);
    if (at !== -1) this.waiting.splice(at, 1);
    this.byKey.delete(entry.key);
    entry.reject(new AbandonedError());
  }

  private pump(): void {
    while (this.running < Math.max(1, this.concurrency()) && this.waiting.length > 0) {
      const entry = this.waiting.shift()!;
      entry.started = true;
      this.running++;
      entry
        .run()
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.running--;
          this.byKey.delete(entry.key);
          this.pump();
        });
    }
  }
}
