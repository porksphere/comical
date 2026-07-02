/**
 * The embedded transport: resolve server-relative paths in-process by driving the reused
 * `@comical/host-server` router with a plain `Request` — no socket, no external URI. This is the
 * same router the remote server runs; only the `BridgeProvider` differs (proxy bridges backed by the
 * native engine instead of `loadBridge`d bundles). `createRouter` is injected (and cast to the narrow
 * `CreateRouter`) so this package's public types don't pull Hono.
 *
 * `cors: false`: CORS is meaningless in-process, and Hono's post-response header tweak re-wraps the
 * Response via `new Response(res.body, …)` where `res.body` (a ReadableStream) is `null` under React
 * Native — which silently empties the body. Disabling CORS keeps the original string-bodied Response.
 *
 * Body read-back: read the response to text and return a minimal response whose `json()`/`text()`
 * return that string (the only members a fetch client uses), avoiding RN `Response` body quirks.
 */
import type { BridgeProvider, CreateRouter, EmbeddedTransport } from "./types.ts";

/** Base is arbitrary — the router matches on path only; nothing leaves the device. */
const EMBEDDED_ORIGIN = "http://embedded.comical.local";

export function createEmbeddedTransport(provider: BridgeProvider, createRouter: CreateRouter): EmbeddedTransport {
  const router = createRouter(provider, { cors: false });
  return async (path, init) => {
    const routed = await router.fetch(new Request(`${EMBEDDED_ORIGIN}${path}`, init));
    const body = await routed.text();
    return {
      ok: routed.status >= 200 && routed.status < 300,
      status: routed.status,
      statusText: routed.statusText,
      json: async () => (body ? JSON.parse(body) : undefined),
      text: async () => body,
    } as unknown as Response;
  };
}
