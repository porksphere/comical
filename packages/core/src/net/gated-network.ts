/**
 * Wraps a host's raw `NetworkCapability` with the runtime's politeness layer: rate limiting,
 * honoring a source's "slow down" responses, and session-cookie handling. This is the network
 * object actually handed to a bridge, so every bridge benefits uniformly regardless of platform.
 */
import {
  challengeMessage,
  rateLimitedMessage,
  retryAfterMs,
  type HttpRequest,
  type HttpResponse,
  type NetworkCapability,
  type RateLimitRoute,
} from "@comical/contract";
import { CookieJar, type ImportedCookie } from "./cookie-jar.ts";
import { type RateLimitOptions, RateLimiter } from "./rate-limiter.ts";
import { compilePathGlob, hostMatches, hostOf, pathOf } from "./url-match.ts";
import { WindowLimiter } from "./window-limiter.ts";

export interface GatedNetworkOptions {
  rateLimit?: Partial<RateLimitOptions>;
  /** Overrides for how throttle responses are honored (defaults below; tests shrink them). */
  throttle?: Partial<ThrottleOptions>;
  /**
   * Where the cookie jar is kept between launches. The loader backs it with the bridge's secure
   * storage; without one the jar lives as long as the bridge does.
   */
  cookieStore?: CookieStore;
  /**
   * The User-Agent the host's network sends when a request names none, so a challenge can tell the
   * web view which one to use (the loader passes `getDefaultUserAgent()`).
   */
  defaultUserAgent?: string;
  /** How long a challenged host's requests fail fast without reaching it (default 60 s). */
  challengeHoldMs?: number;
}

/** Persistence for the gated network's cookie jar: one serialized string per bridge. */
export interface CookieStore {
  load(): Promise<string | undefined>;
  save(serialized: string): Promise<void>;
}

/**
 * The bridge's session as the host sees it: the cookies its requests carry, and the import a web
 * check ends with. Exposed on the loaded bridge (see `LoadedBridge`) for the router.
 */
export interface BridgeSession {
  /** The `Cookie` header and User-Agent to send for `url` outside the bridge's own requests (images). */
  sessionCookies(url: string): Promise<{ cookie?: string; userAgent?: string }>;
  /** Add cookies a person earned passing `url`'s site's check, with the User-Agent it ran with. */
  importCookies(url: string, cookies: ImportedCookie[], userAgent?: string): Promise<void>;
  /** Forget `url`'s site's cookies, or every cookie when `url` is absent. */
  clearCookies(url?: string): Promise<void>;
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
  /** The bridge's cookies, for the host. */
  session: BridgeSession;
}

/** Cloudflare's documented signal for a challenge page: `cf-mitigated: challenge`. */
function isChallenge(res: HttpResponse): boolean {
  return headerValue(res.headers, "cf-mitigated")?.toLowerCase() === "challenge";
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
  // Saves are coalesced: a burst of Set-Cookie responses writes once.
  let saving: Promise<void> | undefined;
  const persist = () => {
    if (!opts.cookieStore || saving) return;
    saving = Promise.resolve().then(async () => {
      saving = undefined;
      try {
        await opts.cookieStore!.save(jar.serialize());
      } catch {
        // A failed save only costs the next launch its cookies.
      }
    });
  };
  const jar = new CookieJar(persist);
  let restored: Promise<void> | undefined;
  const ready = () =>
    (restored ??= opts.cookieStore
      ? opts.cookieStore.load().then(
          (s) => jar.restore(s),
          () => {},
        )
      : Promise.resolve());
  // Hosts whose challenge is waiting on a person: requests to them fail fast until it's passed (an
  // import clears it) or the hold runs out, so ten requests don't each hit the check.
  const challenged = new Map<string, { until: number; message: string }>();
  const holdMs = opts.challengeHoldMs ?? 60_000;
  const challengeFor = (req: HttpRequest): string => {
    const method = (req.method ?? "GET").toUpperCase();
    // A web view can only load a page with GET; for anything else the clearance is earned on the
    // site's root, which covers the whole site.
    let url = req.url;
    if (method !== "GET") {
      try {
        url = `${new URL(req.url).origin}/`;
      } catch {
        // keep the request URL
      }
    }
    const userAgent = headerValue(req.headers, "user-agent") ?? opts.defaultUserAgent;
    return challengeMessage(userAgent ? { url, userAgent } : { url });
  };
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
      await ready();
      const host = hostOf(req.url);
      const pending = host ? challenged.get(host) : undefined;
      if (pending) {
        if (pending.until > Date.now()) throw new Error(pending.message);
        challenged.delete(host!);
      }
      // Attach the session's cookies for this host. A bridge that set its own Cookie header keeps
      // it; only cookies imported from a web check are added to it (its own values win by name), so
      // a site's clearance still travels with a bridge that manages its own session.
      const gatedReq = withCookies(req, jar);

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

        if (isChallenge(response)) {
          const message = challengeFor(req);
          if (host) challenged.set(host, { until: Date.now() + holdMs, message });
          throw new Error(message);
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
    session: {
      async sessionCookies(url) {
        await ready();
        const out: { cookie?: string; userAgent?: string } = {};
        const cookie = jar.header(url);
        const userAgent = jar.userAgent(url);
        if (cookie) out.cookie = cookie;
        if (userAgent) out.userAgent = userAgent;
        return out;
      },
      async importCookies(url, cookies, userAgent) {
        await ready();
        jar.import(url, cookies, userAgent);
        // The check is passed: let the site's requests through again.
        const host = hostOf(url);
        if (host) for (const h of [...challenged.keys()]) if (h === host || h.endsWith(`.${host}`) || host.endsWith(`.${h}`)) challenged.delete(h);
      },
      async clearCookies(url) {
        await ready();
        jar.clear(url);
      },
    },
  };
}

/** `req` with the jar's cookies for its URL attached (see the request path for the rule). */
function withCookies(req: HttpRequest, jar: CookieJar): HttpRequest {
  const own = headerEntry(req.headers, "cookie");
  if (!own) {
    const cookie = jar.header(req.url);
    return cookie ? { ...req, headers: { ...(req.headers ?? {}), Cookie: cookie } } : req;
  }
  const imported = jar.header(req.url, { importedOnly: true });
  if (!imported) return req;
  const names = new Set(own[1].split(";").map((p) => p.split("=", 1)[0]!.trim()));
  const extra = imported
    .split("; ")
    .filter((p) => !names.has(p.split("=", 1)[0]!.trim()))
    .join("; ");
  if (!extra) return req;
  const headers = { ...(req.headers ?? {}) };
  headers[own[0]] = `${own[1]}; ${extra}`;
  return { ...req, headers };
}

function headerEntry(headers: Record<string, string> | undefined, name: string): [string, string] | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  const key = Object.keys(headers).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : [key, headers[key]!];
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  return headerEntry(headers, name)?.[1];
}
