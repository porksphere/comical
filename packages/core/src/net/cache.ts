/**
 * A tiny in-memory TTL cache for successful GET responses. Disabled by default (ttlMs <= 0).
 * Hosts can layer a persistent cache later; the runtime only needs this interface.
 */
import type { HttpRequest, HttpResponse } from "@comical/contract";

export interface CacheOptions {
  /** Time-to-live in milliseconds. <= 0 disables caching entirely. */
  ttlMs: number;
  /** Maximum number of entries before the oldest is evicted. */
  maxEntries: number;
}

export const DEFAULT_CACHE: CacheOptions = {
  ttlMs: 0,
  maxEntries: 256,
};

interface Entry {
  response: HttpResponse;
  expires: number;
}

export class ResponseCache {
  private readonly opts: CacheOptions;
  private readonly map = new Map<string, Entry>();

  constructor(opts: Partial<CacheOptions> = {}) {
    this.opts = { ...DEFAULT_CACHE, ...opts };
  }

  get enabled(): boolean {
    return this.opts.ttlMs > 0;
  }

  private static cacheable(req: HttpRequest): boolean {
    return (req.method ?? "GET") === "GET";
  }

  private static key(req: HttpRequest): string {
    return `${req.method ?? "GET"} ${req.url}`;
  }

  get(req: HttpRequest): HttpResponse | undefined {
    if (!this.enabled || !ResponseCache.cacheable(req)) return undefined;
    const entry = this.map.get(ResponseCache.key(req));
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.map.delete(ResponseCache.key(req));
      return undefined;
    }
    return entry.response;
  }

  set(req: HttpRequest, response: HttpResponse): void {
    if (!this.enabled || !ResponseCache.cacheable(req)) return;
    if (response.status < 200 || response.status >= 300) return;
    if (this.map.size >= this.opts.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(ResponseCache.key(req), {
      response,
      expires: Date.now() + this.opts.ttlMs,
    });
  }
}
