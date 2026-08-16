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
 * Body read-back: read the response body once as bytes and return a minimal response whose
 * `json()`/`text()`/`arrayBuffer()` serve that buffer, avoiding RN `Response` body quirks. Bytes
 * (not text) are read because some routes return binary — `resolveAssetSource` proxies image bytes
 * through `/img-proxy` and inlines them as a `data:` URI, which a `.text()` read would corrupt.
 * `headers` is passed through verbatim so callers can read `Location` (redirect assets) and
 * `Content-Type` (the `data:` URI's media type); the original synthetic response omitted it, which
 * crashed asset resolution with "Cannot read property 'get' of undefined".
 */
import type {
  BridgeProvider,
  ComicalRuntime,
  CreateRouter,
  DownloadEngine,
  Downloads,
  EmbeddedCoversConfig,
  EmbeddedTransport,
  Library,
  RegistryProvider,
  TrackerProvider,
} from "./types.ts";

/** Base is arbitrary — the router matches on path only; nothing leaves the device. */
const EMBEDDED_ORIGIN = "http://embedded.comical.local";

/** Optional on-device library service + runtime — when supplied, the reused router also mounts the
 *  `/library*` endpoints (collection, history, activity, progress) resolving against on-device storage. */
export interface EmbeddedLibrary {
  library: Library;
  runtime: ComicalRuntime;
}

export function createEmbeddedTransport(
  provider: BridgeProvider,
  createRouter: CreateRouter,
  registry?: RegistryProvider,
  lib?: EmbeddedLibrary,
  downloads?: Downloads,
  downloadEngine?: DownloadEngine,
  covers?: EmbeddedCoversConfig,
  trackers?: TrackerProvider,
  /** The app's own custom-scheme redirect URI (e.g. `comical://oauth-callback`, from
   *  `expo-linking`'s `Linking.createURL(...)`) — there's no real server to redirect an OAuth
   *  provider to on-device, so `/trackers/:id/oauth-start` builds the auth URL around this
   *  instead. The app completes the round trip itself by calling `GET /oauth/callback` through
   *  this SAME router once it intercepts the redirect (see `openAuthSessionAsync`'s native
   *  redirect detection) — `pendingOAuth` is module-scoped in `@comical/host-server`'s router, so
   *  both calls land on the same state regardless of which `createRouter()` instance handled them. */
  callbackBaseUrl?: string,
): EmbeddedTransport {
  const router = createRouter(provider, {
    cors: false,
    ...(registry ? { registry } : {}),
    ...(lib ? { library: lib.library, runtime: lib.runtime } : {}),
    ...(downloads ? { downloads } : {}),
    ...(downloadEngine ? { downloadEngine } : {}),
    ...(covers ? { covers } : {}),
    ...(trackers ? { trackers } : {}),
    ...(callbackBaseUrl ? { callbackBaseUrl } : {}),
  });
  return async (path, init) => {
    const routed = await router.fetch(new Request(`${EMBEDDED_ORIGIN}${path}`, init));
    const buffer = await routed.arrayBuffer();
    // Decode lazily and only when a text/JSON consumer asks — binary asset routes read
    // `arrayBuffer()` instead and must never pay a (lossy) text decode.
    const decodeText = () => (buffer.byteLength ? new TextDecoder().decode(buffer) : "");
    return {
      ok: routed.status >= 200 && routed.status < 300,
      status: routed.status,
      statusText: routed.statusText,
      headers: routed.headers,
      json: async () => {
        const text = decodeText();
        return text ? JSON.parse(text) : undefined;
      },
      text: async () => decodeText(),
      arrayBuffer: async () => buffer,
    } as unknown as Response;
  };
}
