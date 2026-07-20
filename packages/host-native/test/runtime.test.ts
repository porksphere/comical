/**
 * Verifies the shared native runtime drives a bridge *through @comical/core* (not a hand-rolled
 * shim): the comical_init/comical_call globals load via loadBridge + NativeContextEvaluator, so the
 * core guarantees — rate limiting (info.rateLimit), settings enforcement, contract-version checks —
 * now apply on the native path.
 *
 * The native pieces are mocked: __comical_native_eval is backed by NodeVmEvaluator (simulating the
 * isolated child context that returns the bundle's exports), and the _native_* callbacks are
 * in-memory. The cross-context/engine specifics are validated on-device separately.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { NodeVmEvaluator } from "@comical/core";
import { makeAsyncHost } from "../src/adapter-async.ts";
import { makeCallbackHost } from "../src/adapter-callback.ts";
import { installComicalHarness } from "../src/runtime.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;

const NATIVE_GLOBALS = [
  "__comical_native_eval",
  "_native_log",
  "_native_network_request",
  "_native_storage_get",
  "_native_storage_set",
  "_native_storage_delete",
  "_native_storage_keys",
  "comical_init",
  "comical_call",
  "comical_bridge",
  "comical_init_tracker",
  "comical_call_tracker",
  "comical_drain_tracker_patch",
  "comical_tracker",
];

afterEach(() => {
  for (const k of NATIVE_GLOBALS) delete g[k];
});

/** Simulate the native separate-context evaluator with node:vm (returns the bundle's exports). */
function installNativeEval(): void {
  const ev = new NodeVmEvaluator();
  const noopLog = { debug() {}, info() {}, warn() {}, error() {} };
  g.__comical_native_eval = (code: string) => ev.evaluate(code, noopLog).exports;
}

function stampResponse(): string {
  return JSON.stringify({ url: "x", status: 200, statusText: "OK", headers: {}, body: String(Date.now()) });
}

/** Android-style: async functions returning values. */
function installAsyncNatives(): void {
  const store = new Map<string, string>();
  g._native_log = () => {};
  g._native_network_request = () => Promise.resolve(stampResponse());
  g._native_storage_get = (k: string) => Promise.resolve(store.get(k) ?? null);
  g._native_storage_set = (k: string, v: string) => { store.set(k, v); return Promise.resolve(null); };
  g._native_storage_delete = (k: string) => { store.delete(k); return Promise.resolve(null); };
  g._native_storage_keys = () => Promise.resolve(JSON.stringify([...store.keys()]));
}

/** Android-style network mock whose response depends on the request URL — for tracker OAuth-refresh
 *  tests, which need a distinct `refreshUrl` response and content calls that 401 until refreshed. */
function installScriptedNetwork(
  script: (req: { url: string; method?: string; headers?: Record<string, string> }) => {
    status: number;
    body: unknown;
  },
): void {
  g._native_network_request = (reqJSON: string) => {
    const req = JSON.parse(reqJSON) as { url: string; method?: string; headers?: Record<string, string> };
    const r = script(req);
    return Promise.resolve(
      JSON.stringify({ url: req.url, status: r.status, statusText: "", headers: {}, body: JSON.stringify(r.body) }),
    );
  };
}

/** iOS-style: callback (err, result) functions. */
function installCallbackNatives(): void {
  const store = new Map<string, string>();
  type Cb = (err: unknown, result?: string) => void;
  g._native_log = () => {};
  g._native_network_request = (_req: string, cb: Cb) => cb(null, stampResponse());
  g._native_storage_get = (k: string, cb: Cb) => cb(null, store.get(k));
  g._native_storage_set = (k: string, v: string, cb: Cb) => { store.set(k, v); cb(null); };
  g._native_storage_delete = (k: string, cb: Cb) => { store.delete(k); cb(null); };
  g._native_storage_keys = (cb: Cb) => cb(null, JSON.stringify([...store.keys()]));
}

const RATE_INFO = `{ id: "t", name: "T", version: "0.0.0", contractVersion: "1.0.0", languages: ["en"], nsfw: false, capabilities: ["search"], rateLimit: { maxConcurrent: 1, minIntervalMs: 80 } }`;

/** A bridge that fans out 3 requests at once and reports each request's start timestamp. */
const fanout = (info: string): string => `module.exports = { default: (host) => ({
  info: ${info},
  getSeriesDetails: async (id) => ({ id, title: id }),
  getChapters: async () => [],
  getChapterPages: async () => [],
  getSearchResults: async () => {
    const starts = await Promise.all([0, 1, 2].map((i) =>
      host.network.request({ url: "https://b/" + i }).then((r) => Number(r.body))
    ));
    return { items: starts.map((s) => ({ id: String(s), title: String(s) })), page: 1, hasNextPage: false };
  },
}) };`;

const spread = (items: Array<{ id: string }>): number => {
  const t = items.map((i) => Number(i.id)).sort((a, b) => a - b);
  return t[t.length - 1]! - t[0]!;
};

describe("host-native runtime (Android / async adapter)", () => {
  test("loads through core and round-trips a method", async () => {
    installNativeEval();
    installAsyncNatives();
    installComicalHarness(makeAsyncHost);

    const info = JSON.parse(g.comical_init(fanout(RATE_INFO), "{}") as string);
    expect(info.id).toBe("t");

    const res = JSON.parse(await g.comical_call("getSearchResults", JSON.stringify(["", 1])));
    expect(res.items.length).toBe(3);
  });

  test("serializes a void method result as valid JSON null (honors the Promise<string> contract)", async () => {
    installNativeEval();
    installAsyncNatives();
    installComicalHarness(makeAsyncHost);

    // A bridge whose favorite write returns void. Pre-fix, `JSON.stringify(undefined)` was the VALUE
    // undefined and the native layer coerced it to the invalid string "undefined"; now it must be the
    // valid JSON "null".
    const code = `module.exports = { default: (host) => ({
      info: { id: "f", name: "F", version: "0.0.0", contractVersion: "1.0.0", languages: ["en"], nsfw: false, capabilities: ["favorites"] },
      getFavorites: async () => ({ items: [], page: 1, hasNextPage: false }),
      addFavorite: async () => {},
      removeFavorite: async () => {},
    }) };`;
    g.comical_init(code, "{}");

    const raw = await g.comical_call("addFavorite", JSON.stringify(["series-1"]));
    expect(raw).toBe("null");
    expect(JSON.parse(raw)).toBeNull();
  });

  test("honors info.rateLimit through core", async () => {
    installNativeEval();
    installAsyncNatives();
    installComicalHarness(makeAsyncHost);
    g.comical_init(fanout(RATE_INFO), "{}");

    const res = JSON.parse(await g.comical_call("getSearchResults", JSON.stringify(["", 1])));
    // 3 requests, 1 in flight, ≥80ms apart → starts span ≥ ~160ms.
    expect(spread(res.items)).toBeGreaterThanOrEqual(140);
  });

  test("enforces settings validation at init (invalid enum throws)", () => {
    installNativeEval();
    installAsyncNatives();
    installComicalHarness(makeAsyncHost);

    const info = `{ id: "t", name: "T", version: "0.0.0", contractVersion: "1.0.0", languages: ["en"], nsfw: false, capabilities: ["search"] }`;
    const code = `module.exports = { default: (host) => ({
      info: ${info},
      getSeriesDetails: async (id) => ({ id, title: id }),
      getChapters: async () => [],
      getChapterPages: async () => [],
      getSettings: () => [{ type: "enum", key: "mode", label: "Mode", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }],
    }) };`;
    expect(() => g.comical_init(code, JSON.stringify({ mode: "zzz" }))).toThrow();
  });

  test("rejects an incompatible contract version at init", () => {
    installNativeEval();
    installAsyncNatives();
    installComicalHarness(makeAsyncHost);

    const info = `{ id: "t", name: "T", version: "0.0.0", contractVersion: "999.0.0", languages: ["en"], nsfw: false, capabilities: ["search"] }`;
    const code = `module.exports = { default: (host) => ({
      info: ${info},
      getSeriesDetails: async (id) => ({ id, title: id }),
      getChapters: async () => [],
      getChapterPages: async () => [],
    }) };`;
    expect(() => g.comical_init(code, "{}")).toThrow();
  });
});

describe("host-native runtime (iOS / callback adapter)", () => {
  test("round-trips and honors rate limit", async () => {
    installNativeEval();
    installCallbackNatives();
    installComicalHarness(makeCallbackHost);

    JSON.parse(g.comical_init(fanout(RATE_INFO), "{}") as string);
    const res = JSON.parse(await g.comical_call("getSearchResults", JSON.stringify(["", 1])));
    expect(res.items.length).toBe(3);
    expect(spread(res.items)).toBeGreaterThanOrEqual(140);
  });
});

// ── Trackers (comical_init_tracker / comical_call_tracker / comical_drain_tracker_patch) ────────
// Verifies the tracker path goes through @comical/core's loadTracker (contract-validated results,
// getSettings enforced) exactly like the bridge path, AND that an expired OAuth token is refreshed
// transparently via the shared RefreshableNetwork — with the refreshed blob buffered for the native
// side to persist (comical_drain_tracker_patch), since the sandboxed context has no other channel
// back to the RN-level settings store.

const TRACKER_INFO = `{ id: "t", name: "T", version: "0.0.0", contractVersion: "1.0.0", capabilities: ["library-sync"] }`;

/** A tracker whose getLibrary makes one authenticated content request and echoes its response title. */
const oauthTracker = (info: string): string => `module.exports = { default: (host) => ({
  info: ${info},
  getSettings: () => [{
    type: "oauth-pin", key: "token", label: "Account", authUrl: "https://x/pin",
    exchange: { url: "https://x/token", clientId: "cid", clientSecret: "secret", redirectUri: "urn:ietf:wg:oauth:2.0:oob", refreshUrl: "https://x/refresh" },
  }],
  getLibrary: async (page) => {
    const res = await host.network.request({ url: "https://x/content", headers: { Authorization: "Bearer " + host.settings.token } });
    return { items: [{ externalId: "1", title: JSON.parse(res.body).title, status: "reading" }], page, hasNextPage: false };
  },
}) };`;

describe("host-native runtime — trackers", () => {
  test("loads through core and round-trips getLibrary", async () => {
    installNativeEval();
    installScriptedNetwork(() => ({ status: 200, body: { title: "ok" } }));
    installComicalHarness(makeAsyncHost);

    const info = JSON.parse(g.comical_init_tracker!(oauthTracker(TRACKER_INFO), JSON.stringify({ token: "a1" })) as string);
    expect(info.id).toBe("t");

    const res = JSON.parse(await g.comical_call_tracker!("getLibrary", JSON.stringify([1])));
    expect(res.items[0].title).toBe("ok");
  });

  test("refreshes an expired OAuth token on 401, retries, and buffers the new blob for comical_drain_tracker_patch", async () => {
    installNativeEval();
    let contentCalls = 0;
    installScriptedNetwork((req) => {
      if (req.url === "https://x/refresh") {
        return { status: 200, body: { access_token: "a2", refresh_token: "r2", expires_in: 3600 } };
      }
      contentCalls++;
      return contentCalls === 1 ? { status: 401, body: "" } : { status: 200, body: { title: "refreshed" } };
    });
    installComicalHarness(makeAsyncHost);

    // Stored value is a token blob (has a refresh token) — the shape buildRefreshConfigs needs to
    // wire up a refresh; the tracker itself only ever sees the unwrapped access token.
    const stored = { token: JSON.stringify({ access: "a1", refresh: "r1" }) };
    g.comical_init_tracker!(oauthTracker(TRACKER_INFO), JSON.stringify(stored));

    const res = JSON.parse(await g.comical_call_tracker!("getLibrary", JSON.stringify([1])));
    expect(res.items[0].title).toBe("refreshed");

    const patchJSON = g.comical_drain_tracker_patch!();
    expect(patchJSON).not.toBeNull();
    expect(JSON.parse(patchJSON!)).toEqual({
      key: "token",
      blob: { access: "a2", refresh: "r2", expiresAt: expect.any(Number) },
    });

    // Drained once — a second drain with nothing new since returns null.
    expect(g.comical_drain_tracker_patch!()).toBeNull();
  });

  test("a plain (non-blob) stored token is passed through unchanged, with no refresh configured", async () => {
    installNativeEval();
    installScriptedNetwork(() => ({ status: 200, body: { title: "ok" } }));
    installComicalHarness(makeAsyncHost);

    // No `refresh` token on the stored value → buildRefreshConfigs skips it → nothing to drain.
    g.comical_init_tracker!(oauthTracker(TRACKER_INFO), JSON.stringify({ token: "plain-token" }));
    const res = JSON.parse(await g.comical_call_tracker!("getLibrary", JSON.stringify([1])));
    expect(res.items[0].title).toBe("ok");
    expect(g.comical_drain_tracker_patch!()).toBeNull();
  });

  test("comical_call_tracker rejects before comical_init_tracker has run", async () => {
    installComicalHarness(makeAsyncHost);
    await expect(g.comical_call_tracker!("getLibrary", "[1]")).rejects.toThrow(/not initialised/);
  });
});
