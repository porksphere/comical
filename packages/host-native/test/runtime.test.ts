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
