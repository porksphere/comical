/**
 * The host capability API: the ONLY platform-backed powers a bridge may touch.
 *
 * A bridge never opens sockets, reads the filesystem, or sees `process`/`require`. It receives
 * an implementation of `HostCapabilities` (provided by the per-platform host adapter, gated by
 * the core) and works exclusively through it. This is the sandbox boundary that keeps bridges
 * portable across the browser, JSC, QuickJS, and Bun, and keeps them honest.
 *
 * Note: HTML parsing is NOT a host capability — it is pure JS (cheerio) bundled in
 * `@comical/sdk` and runs inside the sandbox, so it needs no platform support.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export interface HttpRequest {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  /** Raw request body for POST/PUT/PATCH. */
  body?: string;
}

export interface HttpResponse {
  /** Final URL after any redirects. */
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Decoded text body. (Binary assets are referenced by URL in `Page`, never inlined.) */
  body: string;
}

/** The sole network path. The host owns cookies, rate limiting, caching, and proxy/native choice. */
export interface NetworkCapability {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** Namespaced key/value storage for a bridge's own scratch (tokens, cookies, ETags). */
export interface StorageCapability {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** Structured logging routed to the host. */
export interface LogCapability {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Resolved user-supplied setting values (e.g. backend URL, credentials), keyed by setting key. */
export type ResolvedSettings = Readonly<Record<string, string | boolean>>;

export interface HostCapabilities {
  network: NetworkCapability;
  storage: StorageCapability;
  log: LogCapability;
  /** Values the user supplied for the bridge's declared `getSettings()` descriptors. */
  settings: ResolvedSettings;
}
