/**
 * The Comical CORS proxy — a Hono app deployable on Bun or as a Cloudflare Worker.
 *
 * Bridges running in a browser cannot make cross-origin requests directly (CORS) and may face
 * Cloudflare/bot challenges when fetching certain backends. This proxy sits between the browser
 * and the backend: the browser posts a forwarded request to the proxy, the proxy fetches it
 * server-side (no CORS restrictions), and returns the response with CORS headers.
 *
 * Self-host your own instance — we operate none. The bridge configures the proxy URL as a user
 * setting, so it remains user-supplied infrastructure.
 *
 * Security features:
 *  - Optional bearer-token auth (COMICAL_PROXY_TOKEN env var).
 *  - SSRF protection: private/loopback/link-local addresses are blocked.
 *  - Strict allowed-origins CORS (COMICAL_PROXY_ORIGIN env var, defaults to *).
 *  - Response size cap (COMICAL_PROXY_MAX_BYTES env var, default 10 MB).
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { assertAllowed, ProxyGuardError } from "./guard.ts";

export interface ProxyEnv {
  /** Bearer token required on all requests. Empty/unset = no auth required (dev only). */
  COMICAL_PROXY_TOKEN?: string;
  /** Allowed CORS origin. Defaults to '*'. */
  COMICAL_PROXY_ORIGIN?: string;
  /** Max response body bytes. Defaults to 10_485_760 (10 MB). */
  COMICAL_PROXY_MAX_BYTES?: string;
}

export interface ProxyOptions {
  env?: ProxyEnv;
  /**
   * Hostnames exempt from the SSRF guard. For testing only — never set in production.
   * Allows the proxy to reach localhost test servers without disabling the guard globally.
   */
  allowedHosts?: Set<string>;
}

export interface ForwardedRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ForwardedResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export function createProxyApp(envOrOpts: ProxyEnv | ProxyOptions = {}): Hono {
  const isOpts = "env" in envOrOpts || "allowedHosts" in envOrOpts;
  const env: ProxyEnv = isOpts ? ((envOrOpts as ProxyOptions).env ?? {}) : (envOrOpts as ProxyEnv);
  const allowedHosts: Set<string> = (isOpts ? (envOrOpts as ProxyOptions).allowedHosts : undefined) ?? new Set();
  const app = new Hono();
  const token = env.COMICAL_PROXY_TOKEN ?? "";
  const origin = env.COMICAL_PROXY_ORIGIN ?? "*";
  const maxBytes = Number(env.COMICAL_PROXY_MAX_BYTES ?? DEFAULT_MAX_BYTES);

  app.use(
    "*",
    cors({
      origin,
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      maxAge: 86400,
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/proxy", async (c) => {
    // Auth check.
    if (token) {
      const auth = c.req.header("authorization") ?? "";
      const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (provided !== token) {
        return c.json({ error: "unauthorized" }, 401);
      }
    }

    let req: ForwardedRequest;
    try {
      req = await c.req.json<ForwardedRequest>();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    // SSRF guard (allowedHosts exempts specific hostnames for testing).
    let targetUrl: URL;
    try {
      targetUrl = assertAllowed(req.url, allowedHosts);
    } catch (e) {
      return c.json({ error: e instanceof ProxyGuardError ? e.message : "blocked" }, 403);
    }

    // Forward the request.
    const init: RequestInit = {
      method: req.method ?? "GET",
      headers: req.headers ?? {},
      redirect: "follow",
    };
    if (req.body !== undefined) init.body = req.body;

    let upstream: Response;
    try {
      upstream = await fetch(targetUrl.toString(), init);
    } catch (e) {
      return c.json({ error: `upstream fetch failed: ${e instanceof Error ? e.message : e}` }, 502);
    }

    // Size guard.
    const raw = await upstream.arrayBuffer();
    if (raw.byteLength > maxBytes) {
      return c.json({ error: `response too large (${raw.byteLength} bytes > ${maxBytes})` }, 502);
    }

    const body = new TextDecoder().decode(raw);
    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      // Strip hop-by-hop headers the client doesn't need.
      if (!["transfer-encoding", "connection", "keep-alive", "set-cookie"].includes(k.toLowerCase())) {
        responseHeaders[k] = v;
      }
    });

    const result: ForwardedResponse = {
      url: upstream.url || req.url,
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
      body,
    };
    return c.json(result);
  });

  return app;
}
