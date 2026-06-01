/**
 * The native network capability for the Bun/desktop host: real HTTP via Bun's built-in `fetch`,
 * following redirects, with an attached cookie jar. This is the raw capability; the core wraps it
 * with rate limiting + caching before a bridge ever sees it.
 */
import type { HttpRequest, HttpResponse, NetworkCapability } from "@comical/contract";
import { CookieJar } from "./cookie-jar.ts";

const DEFAULT_USER_AGENT =
  "Comical/0.0 (+https://github.com/comical) bridge-runtime";

export interface BunNetworkOptions {
  cookieJar?: CookieJar;
  userAgent?: string;
}

export function createBunNetwork(opts: BunNetworkOptions = {}): NetworkCapability {
  const jar = opts.cookieJar ?? new CookieJar();
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const headers = new Headers(req.headers ?? {});
      if (!headers.has("user-agent")) headers.set("user-agent", userAgent);
      const cookie = jar.header(req.url);
      if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);

      const init: RequestInit = {
        method: req.method ?? "GET",
        headers,
        redirect: "follow",
      };
      if (req.body !== undefined) init.body = req.body;

      const res = await fetch(req.url, init);
      jar.store(res.url || req.url, res.headers.getSetCookie());
      const body = await res.text();

      return {
        url: res.url || req.url,
        status: res.status,
        statusText: res.statusText,
        headers: Object.fromEntries(res.headers.entries()),
        body,
      };
    },
  };
}
