import { BridgeTimeoutError } from "./errors.ts";

export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export interface TimeoutPacing {
  /** True while the work is held by the host's own pacing (see `GatedNetwork.held`). */
  busy: () => boolean;
  /** How long the work may run in total while `busy` keeps deferring the timeout. */
  ceilingMs: number;
}

/**
 * Reject if `promise` does not settle within `ms`. Guards against hanging awaits / slow backends.
 * Note: this cannot interrupt a synchronous CPU loop inside the sandbox — that requires a
 * Worker/out-of-process isolate (a later milestone). It does bound async/await stalls.
 *
 * With `pacing`, `ms` bounds a STALL, not the call: when the timer fires while the host's own
 * pacing is holding the work's requests, it is re-armed instead — a queue that is moving is not a
 * hang, and a source declaring a 3s interval would otherwise turn the eleventh queued call into a
 * timeout. The ceiling is what the call may take in all; past it the rejection carries the hold.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string, pacing?: TimeoutPacing): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const arm = (wait: number) => {
      timer = setTimeout(() => {
        const elapsed = Date.now() - started;
        if (pacing && pacing.busy() && elapsed < pacing.ceilingMs) {
          arm(Math.min(ms, pacing.ceilingMs - elapsed));
          return;
        }
        reject(
          new BridgeTimeoutError(
            pacing && pacing.busy()
              ? `${label} exceeded ${pacing.ceilingMs}ms while its requests were held by the source's rate limit`
              : `${label} exceeded ${ms}ms`,
          ),
        );
      }, wait);
    };
    arm(ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
