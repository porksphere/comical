/**
 * The download side of the rate-limited signal: a page fetch or page resolution that the source
 * refused with "slow down" throws a {@link PageRateLimitedError}, and the engine holds that bridge's
 * queue until the wait passes instead of failing the page (a fail would burn the retry, and the
 * placeholder some sources serve instead of the image must never be saved as the page).
 */
import { parseRateLimited, retryAfterMs } from "@comical/contract";

/** The wait assumed when the source says "slow down" without saying for how long. */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

export class PageRateLimitedError extends Error {
  override readonly name = "PageRateLimitedError";
  constructor(
    readonly retryAfterMs: number,
    message = "rate limited by the source",
  ) {
    super(message);
  }
}

/** The slice of a fetch `Response` the check needs (satisfied by `Response` and the RN transport). */
export interface RateLimitResponse {
  status: number;
  headers?: { get(name: string): string | null } | undefined;
}

/**
 * A {@link PageRateLimitedError} for a response that is the source (or this host's router, relaying
 * a bridge's rate-limited error) saying "slow down" — a 429, or a 503 that names a Retry-After —
 * else null. `body` is checked for the rate-limited marker a router relays in its JSON error.
 */
export function rateLimitedFromResponse(res: RateLimitResponse, body?: string): PageRateLimitedError | null {
  if (res.status !== 429 && res.status !== 503) return null;
  const header = (name: string) => res.headers?.get(name) ?? undefined;
  const ra = header("Retry-After");
  const xra = header("X-RateLimit-Retry-After");
  const named = retryAfterMs({ ...(ra ? { "retry-after": ra } : {}), ...(xra ? { "x-ratelimit-retry-after": xra } : {}) });
  const marked = body ? parseRateLimited(body)?.retryAfterMs : undefined;
  if (res.status === 503 && named === undefined && marked === undefined) return null;
  return new PageRateLimitedError(marked ?? named ?? DEFAULT_RATE_LIMIT_WAIT_MS, `source answered ${res.status}`);
}

/** The wait (ms) carried by a thrown value — a {@link PageRateLimitedError} or a marked message. */
export function rateLimitWaitOf(e: unknown): number | undefined {
  if (e instanceof PageRateLimitedError) return e.retryAfterMs;
  if (e && typeof e === "object" && (e as { name?: unknown }).name === "PageRateLimitedError") {
    const ms = (e as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof ms === "number") return ms;
  }
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : undefined;
  return message ? parseRateLimited(message)?.retryAfterMs : undefined;
}
