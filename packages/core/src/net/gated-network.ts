/**
 * Wraps a host's raw `NetworkCapability` with the runtime's politeness layer: rate limiting,
 * honoring a source's "slow down" responses, and session-cookie handling. This is the network
 * object actually handed to a bridge, so every bridge benefits uniformly regardless of platform.
 */
import { retryAfterMs, type HttpRequest, type HttpResponse, type NetworkCapability } from "@comical/contract";
import { CookieJar } from "./cookie-jar.ts";
import { type RateLimitOptions, RateLimiter } from "./rate-limiter.ts";

export interface GatedNetworkOptions {
  rateLimit?: Partial<RateLimitOptions>;
  /** Overrides for how throttle responses are honored (defaults below; tests shrink them). */
  throttle?: Partial<ThrottleOptions>;
}

export interface ThrottleOptions {
  /**
   * A throttle wait up to this long is sat out and the request retried once, inside the bridge call
   * (whose budget is 30s by default). Anything longer is handed back to the bridge as the 429 it is,
   * and later requests fail fast with a synthetic 429 until it passes rather than queueing past the
   * call timeout.
   */
  maxInlineWaitMs: number;
  /** Backoff for a 429 that names no wait: this, doubling per consecutive 429 … */
  backoffStartMs: number;
  /** … capped here. */
  backoffMaxMs: number;
}

export const DEFAULT_THROTTLE: ThrottleOptions = {
  maxInlineWaitMs: 15_000,
  backoffStartMs: 10_000,
  backoffMaxMs: 5 * 60_000,
};

export interface GatedNetwork {
  /** The network capability handed to the bridge. */
  network: NetworkCapability;
  /**
   * Adjust the rate limit after creation. The loader uses this to apply a bridge's declared
   * `info.rateLimit` (read only after the bridge is instantiated with the gated network).
   */
  setRateLimit: (opts: Partial<RateLimitOptions>) => void;
  /**
   * When the source's current "slow down" ends (epoch ms; in the past when it isn't throttling us).
   * The loader reads it to tag a bridge error raised during a throttle as rate-limited.
   */
  blockedUntil: () => number;
}

export function createGatedNetwork(
  raw: NetworkCapability,
  opts: GatedNetworkOptions = {},
): GatedNetwork {
  const limiter = new RateLimiter(opts.rateLimit);
  const jar = new CookieJar();
  const throttle = { ...DEFAULT_THROTTLE, ...opts.throttle };
  let strikes = 0;

  /** How long `res` asks us to back off, or undefined when it isn't a throttle response. */
  const throttleWait = (res: HttpResponse): number | undefined => {
    if (res.status !== 429 && res.status !== 503) return undefined;
    const named = retryAfterMs(res.headers);
    // A 503 is only a throttle when it says when to come back; otherwise it's an ordinary outage.
    if (res.status === 503) return named;
    strikes++;
    return named ?? Math.min(throttle.backoffStartMs * 2 ** (strikes - 1), throttle.backoffMaxMs);
  };

  const network: NetworkCapability = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      // Attach the session cookie for this host (unless the bridge set one explicitly).
      const cookie = jar.header(req.url);
      const gatedReq =
        cookie && !hasHeader(req.headers, "cookie")
          ? { ...req, headers: { ...(req.headers ?? {}), Cookie: cookie } }
          : req;

      for (let attempt = 0; ; attempt++) {
        const remaining = limiter.pausedUntilMs - Date.now();
        if (remaining > throttle.maxInlineWaitMs) return throttled(req.url, remaining);

        const release = await limiter.acquire();
        let response: HttpResponse;
        try {
          response = await raw.request(gatedReq);
        } finally {
          release();
        }

        if (response.setCookies && response.setCookies.length > 0) {
          jar.store(response.url || req.url, response.setCookies);
        }

        const wait = throttleWait(response);
        if (wait === undefined) {
          if (response.status < 400) strikes = 0;
          return response;
        }
        limiter.pauseUntil(Date.now() + wait);
        if (attempt > 0 || wait > throttle.maxInlineWaitMs) return response;
      }
    },
  };

  return {
    network,
    setRateLimit: (o) => limiter.reconfigure(o),
    blockedUntil: () => limiter.pausedUntilMs,
  };
}

/** The 429 a request gets while a long throttle is in force — never sent upstream. */
function throttled(url: string, remainingMs: number): HttpResponse {
  return {
    url,
    status: 429,
    statusText: "Too Many Requests",
    headers: { "retry-after": String(Math.ceil(remainingMs / 1000)) },
    body: "",
  };
}

/** Case-insensitive header presence check (header records aren't normalized). */
function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) return false;
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}
