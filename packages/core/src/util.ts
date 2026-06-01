import { BridgeTimeoutError } from "./errors.ts";

export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Reject if `promise` does not settle within `ms`. Guards against hanging awaits / slow backends.
 * Note: this cannot interrupt a synchronous CPU loop inside the sandbox — that requires a
 * Worker/out-of-process isolate (a later milestone). It does bound async/await stalls.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new BridgeTimeoutError(`${label} exceeded ${ms}ms`));
    }, ms);
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
