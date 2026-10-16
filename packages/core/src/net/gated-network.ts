/**
 * Wraps a host's raw `NetworkCapability` with the runtime's politeness layer: rate limiting,
 * honoring a source's "slow down" responses, and session-cookie handling. This is the network
 * object actually handed to a bridge, so every bridge benefits uniformly regardless of platform.
 */
import {
  rateLimitedMessage,
  retryAfterMs,
  type HttpRequest,
  type HttpResponse,
  type NetworkCapability,
  type RateLimitRoute,
} from "@comical/contract";
import { CookieJar } from "./cookie-jar.ts";
import { type RateLimitOptions, RateLimiter } from "./rate-limiter.ts";
import { compilePathGlob, hostMatches, hostOf, pathOf } from "./url-match.ts";
import { WindowLimiter } from "./window-limiter.ts";

export interface GatedNetworkOptions {
  rateLimit?: Partial<RateLimitOptions>;
  /** Overrides for how throttle responses are honored (defaults below; tests shrink them). */
  throttle?: Partial<ThrottleOptions>;
}

export interface ThrottleOptions {
  /**
   * How long one request may be held, in total, waiting out the source's "slow down" — it stays
   * queued and is retried as often as fits. It has to end inside the bridge call that made it
   * (30s by default) with room left for the request itself. A wait that can't fit is thrown as a
   * rate-limited error, never handed back as a 429: a bridge reads a response's body, and a 429's
   * is an error page (or nothing), which it would misparse into an unrelated failure.
   */
  maxInlineWaitMs: number;
  /** Backoff for a 429 that names no wait: this, doubling per consecutive 429 … */
  backoffStartMs: number;
  /** … capped here. */
  backoffMaxMs: number;
}

export const DEFAULT_THROTTLE: ThrottleOptions = {
  maxInlineWaitMs: 20_000,
  backoffStartMs: 2_000,
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
   * Replace the per-route quotas (`info.rateLimit.routes`). A request matching a route waits for
   * that route's window as well as the bridge-wide limiter, and a "slow down" it earns pauses the
   * route alone. Applied by the loader alongside `setRateLimit`.
   */
  setRouteLimits: (routes: readonly RateLimitRoute[]) => void;
  /**
   * When the source's current "slow down" ends (epoch ms; in the past when it isn't throttling us).
   * The loader reads it to tag a bridge error raised during a throttle as rate-limited. Reports the
   * bridge-wide pause; a single route's pause is surfaced by the requests it holds, not here.
   */
  blockedUntil: () => number;
  /**
   * Requests waiting on OUR pacing — the interval, the concurrency cap, a route's window or a pause —
   * rather than on the source. A bridge call is slow while this is nonzero, not stalled: the loader's
   * call timeout stands down for as long as it is.
   */
  held: () => number;
  /** When everything now held could have started (epoch ms; `now` when nothing is held). */
  heldClearsAt: () => number;
}

interface Route {
  decl: RateLimitRoute;
  host: string | undefined;
  path: RegExp;
  limiter: WindowLimiter;
}

export function createGatedNetwork(
  raw: NetworkCapability,
  opts: GatedNetworkOptions = {},
): GatedNetwork {
  const limiter = new RateLimiter(opts.rateLimit);
  const jar = new CookieJar();
  const throttle = { ...DEFAULT_THROTTLE, ...opts.throttle };
  let routes: Route[] = [];
  let strikes = 0;
  let held = 0;

  /** How long `res` asks us to back off, or undefined when it isn't a throttle response. */
  const throttleWait = (res: HttpResponse): number | undefined => {
    if (res.status !== 429 && res.status !== 503) return undefined;
    const named = retryAfterMs(res.headers);
    // A 503 is only a throttle when it says when to come back; otherwise it's an ordinary outage.
    if (res.status === 503) return named;
    strikes++;
    return named ?? Math.min(throttle.backoffStartMs * 2 ** (strikes - 1), throttle.backoffMaxMs);
  };

  const routeFor = (url: string): Route | undefined => {
    if (routes.length === 0) return undefined;
    const host = hostOf(url);
    const path = pathOf(url);
    return routes.find((r) => (r.host === undefined || (host !== undefined && hostMatches(host, r.host))) && r.path.test(path));
  };

  const network: NetworkCapability = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      // Attach the session cookie for this host (unless the bridge set one explicitly).
      const cookie = jar.header(req.url);
      const gatedReq =
        cookie && !hasHeader(req.headers, "cookie")
          ? { ...req, headers: { ...(req.headers ?? {}), Cookie: cookie } }
          : req;

      const route = routeFor(req.url);
      const deadline = Date.now() + throttle.maxInlineWaitMs;
      let refusal = "";
      for (let attempt = 0; ; attempt++) {
        const now = Date.now();
        // The route's window is a wait too, but one that always ends: only a pause (a refusal) is
        // worth giving up over, since it's the source saying so.
        const resumeAt = Math.max(limiter.pausedUntilMs, route?.limiter.pausedUntilMs ?? 0);
        if (resumeAt > deadline || (attempt > 0 && now >= deadline)) {
          const reason = refusal || `${hostOf(req.url) ?? "the source"} asked us to slow down`;
          throw new Error(rateLimitedMessage(Math.max(resumeAt - now, 1000), reason));
        }

        held++;
        let release!: () => void;
        try {
          if (route) await route.limiter.acquire();
          release = await limiter.acquire();
        } finally {
          held--;
        }
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
        // A source repeating "retry now" is still refusing; space the retries out anyway. A refusal
        // on a budgeted route is that route's quota speaking, so hold it alone; otherwise it's the
        // whole source and every request shares the pause.
        (route?.limiter ?? limiter).pauseUntil(Date.now() + (attempt > 0 ? Math.max(wait, throttle.backoffStartMs) : wait));
        refusal = `HTTP ${response.status} from ${hostOf(req.url) ?? "the source"}`;
      }
    },
  };

  return {
    network,
    setRateLimit: (o) => limiter.reconfigure(o),
    setRouteLimits: (decls) => {
      routes = decls.map((decl, i) => {
        const prior = routes[i];
        const same = prior && prior.decl.match === decl.match && prior.decl.host === decl.host;
        const limiter = same ? prior.limiter : new WindowLimiter(decl);
        if (same) limiter.reconfigure(decl);
        return { decl, host: decl.host?.toLowerCase(), path: compilePathGlob(decl.match), limiter };
      });
    },
    blockedUntil: () => limiter.pausedUntilMs,
    held: () => held,
    heldClearsAt: () => {
      const now = Date.now();
      return routes.reduce((at, r) => Math.max(at, r.limiter.clearsAt(now)), limiter.clearsAt(now));
    },
  };
}

/** Case-insensitive header presence check (header records aren't normalized). */
function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) return false;
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}
