/**
 * Wraps a host's raw `NetworkCapability` with the runtime's politeness layer: rate limiting and
 * optional response caching. This is the network object actually handed to a bridge, so every
 * bridge benefits uniformly regardless of platform.
 */
import type { HttpRequest, HttpResponse, NetworkCapability } from "@comical/contract";
import { type CacheOptions, ResponseCache } from "./cache.ts";
import { type RateLimitOptions, RateLimiter } from "./rate-limiter.ts";

export interface GatedNetworkOptions {
  rateLimit?: Partial<RateLimitOptions>;
  cache?: Partial<CacheOptions>;
}

export function createGatedNetwork(
  raw: NetworkCapability,
  opts: GatedNetworkOptions = {},
): NetworkCapability {
  const limiter = new RateLimiter(opts.rateLimit);
  const cache = new ResponseCache(opts.cache);

  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const cached = cache.get(req);
      if (cached) return cached;

      const release = await limiter.acquire();
      let response: HttpResponse;
      try {
        response = await raw.request(req);
      } finally {
        release();
      }

      cache.set(req, response);
      return response;
    },
  };
}
