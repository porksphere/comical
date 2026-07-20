/**
 * Wraps a host's raw `NetworkCapability` with the runtime's politeness layer: rate limiting (and
 * session-cookie handling). This is the network object actually handed to a bridge, so every bridge
 * benefits uniformly regardless of platform.
 */
import type { HttpRequest, HttpResponse, NetworkCapability } from "@comical/contract";
import { CookieJar } from "./cookie-jar.ts";
import { type RateLimitOptions, RateLimiter } from "./rate-limiter.ts";

export interface GatedNetworkOptions {
  rateLimit?: Partial<RateLimitOptions>;
}

export interface GatedNetwork {
  /** The network capability handed to the bridge. */
  network: NetworkCapability;
  /**
   * Adjust the rate limit after creation. The loader uses this to apply a bridge's declared
   * `info.rateLimit` (read only after the bridge is instantiated with the gated network).
   */
  setRateLimit: (opts: Partial<RateLimitOptions>) => void;
}

export function createGatedNetwork(
  raw: NetworkCapability,
  opts: GatedNetworkOptions = {},
): GatedNetwork {
  const limiter = new RateLimiter(opts.rateLimit);
  const jar = new CookieJar();

  const network: NetworkCapability = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      // Attach the session cookie for this host (unless the bridge set one explicitly).
      const cookie = jar.header(req.url);
      const gatedReq =
        cookie && !hasHeader(req.headers, "cookie")
          ? { ...req, headers: { ...(req.headers ?? {}), Cookie: cookie } }
          : req;

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
      return response;
    },
  };

  return { network, setRateLimit: (o) => limiter.reconfigure(o) };
}

/** Case-insensitive header presence check (header records aren't normalized). */
function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) return false;
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}
