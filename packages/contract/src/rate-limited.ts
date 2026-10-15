/**
 * A typed "the source is refusing us right now" signal that survives every boundary between a
 * bridge and a host. Bridge errors cross the sandbox as message strings only (each engine formats
 * thrown values differently), so the signal is a marker embedded in the message rather than an
 * error class: a bridge throws `new Error(rateLimitedMessage(ms, why))`, the runtime wraps it as
 * usual, and any host recovers the wait with `parseRateLimited(message)` — the router answers 429
 * with `Retry-After`, and the download engine holds that bridge's queue instead of failing pages.
 */

const MARKER = /\[rate-limited:(\d+)\]/;

/** An error message carrying the rate-limited marker and how long (ms) the source asked us to wait. */
export function rateLimitedMessage(retryAfterMs: number, reason = "rate limited by the source"): string {
  const ms = Number.isFinite(retryAfterMs) ? Math.max(0, Math.round(retryAfterMs)) : 0;
  return `[rate-limited:${ms}] ${reason}`;
}

/** The wait encoded by {@link rateLimitedMessage} anywhere in `message`, or null when absent. */
export function parseRateLimited(message: string): { retryAfterMs: number } | null {
  const m = MARKER.exec(message);
  return m ? { retryAfterMs: Number(m[1]) } : null;
}

/**
 * How long a `Retry-After` / `X-RateLimit-Retry-After` response asks the caller to wait, in ms, or
 * undefined when neither header is usable. `Retry-After` is delta-seconds or an HTTP-date;
 * `X-RateLimit-Retry-After` is a UNIX timestamp in seconds. `headers` keys may be any case.
 */
export function retryAfterMs(headers: Record<string, string> | undefined, now = Date.now()): number | undefined {
  if (!headers) return undefined;
  const get = (name: string): string | undefined => {
    for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v.trim();
    return undefined;
  };
  const ra = get("retry-after");
  if (ra) {
    if (/^\d+$/.test(ra)) return Number(ra) * 1000;
    const at = Date.parse(ra);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const xra = get("x-ratelimit-retry-after");
  if (xra && /^\d+$/.test(xra)) return Math.max(0, Number(xra) * 1000 - now);
  return undefined;
}
