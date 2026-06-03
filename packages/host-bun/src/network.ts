/**
 * The native network capability for the Bun/desktop host: real HTTP via Bun's built-in `fetch`,
 * following redirects. This is the raw capability; the core wraps it with rate limiting, caching,
 * and the cookie jar before a bridge ever sees it — so this layer just reports `Set-Cookie` (it
 * does NOT keep a jar itself; core owns session state uniformly across hosts).
 */
import type { HttpRequest, HttpResponse, NetworkCapability } from "@comical/contract";

const DEFAULT_USER_AGENT =
  "Comical/0.0 (+https://github.com/comical) bridge-runtime";

export interface BunNetworkOptions {
  userAgent?: string;
}

export function createBunNetwork(opts: BunNetworkOptions = {}): NetworkCapability {
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const headers = new Headers(req.headers ?? {});
      if (!headers.has("user-agent")) headers.set("user-agent", userAgent);

      const init: RequestInit = {
        method: req.method ?? "GET",
        headers,
        redirect: "follow",
      };
      if (req.body !== undefined) init.body = req.body;

      const res = await fetch(req.url, init);
      const body = await res.text();
      const setCookies = res.headers.getSetCookie();

      const response: HttpResponse = {
        url: res.url || req.url,
        status: res.status,
        statusText: res.statusText,
        headers: Object.fromEntries(res.headers.entries()),
        body,
      };
      if (setCookies.length > 0) response.setCookies = setCookies;
      return response;
    },
  };
}
