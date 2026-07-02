import { describe, expect, test } from "bun:test";
import type { HostCapabilities, HttpRequest, HttpResponse } from "@comical/contract";
import {
  BridgeContractError,
  BridgeLoadError,
  BridgeRuntimeError,
  BridgeTimeoutError,
  BridgeValidationError,
  loadBridge,
} from "../src/index.ts";

/** A minimal host: records requests, replies with a canned response, in-memory storage. */
function mockHost(
  reply: (req: HttpRequest) => HttpResponse = () => ({
    url: "https://example.test/",
    status: 200,
    statusText: "OK",
    headers: {},
    body: "",
  }),
): HostCapabilities {
  const store = new Map<string, string>();
  return {
    network: { request: async (req) => reply(req) },
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, v),
      delete: async (k) => void store.delete(k),
      keys: async () => [...store.keys()],
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    settings: {},
  };
}

/** Wrap a factory body (returning the bridge object literal) in a CJS bundle, as bun build emits. */
function bundle(factoryBody: string): string {
  return `module.exports = { default: (host) => (${factoryBody}) };`;
}

const GOOD_INFO = `{ id: "smoke", name: "Smoke", version: "0.0.0", contractVersion: "1.0.0", languages: ["en"], nsfw: false, capabilities: ["search"] }`;

const GOOD_BRIDGE = bundle(`{
  info: ${GOOD_INFO},
  getSeriesDetails: async (id) => ({ id, title: "Title " + id }),
  getChapters: async (id) => [{ id: "c1", name: "Chapter 1", number: 1 }],
  getChapterPages: async (m, c) => [{ index: 0, imageUrl: "https://img.example.test/" + c + "/0.png" }],
  getSearchResults: async (q, p) => ({ items: [{ id: "m1", title: q }], page: p, hasNextPage: false }),
  getSettings: () => [{ type: "string", key: "baseUrl", label: "Backend URL", required: true }],
}`);

describe("loadBridge", () => {
  test("loads a valid bridge and round-trips a search → details", async () => {
    const b = loadBridge({ code: GOOD_BRIDGE, capabilities: mockHost() });
    expect(b.info.id).toBe("smoke");

    const results = await b.getSearchResults!("naruto", 1);
    expect(results.items).toHaveLength(1);
    const id = results.items[0]!.id;

    const details = await b.getSeriesDetails(id);
    expect(details.title).toContain(id);
  });

  test("only present optional methods are exposed", () => {
    const b = loadBridge({ code: GOOD_BRIDGE, capabilities: mockHost() });
    expect(typeof b.getSettings).toBe("function");
    expect(b.getLists).toBeUndefined();
    expect(b.getTags).toBeUndefined();
  });

  test("getTags forwards the query argument to the bridge", async () => {
    const code = bundle(`{
      info: ${GOOD_INFO},
      getSeriesDetails: async (id) => ({ id, title: "T" }),
      getChapters: async () => [],
      getChapterPages: async () => [],
      getSearchResults: async () => ({ items: [], page: 1, hasNextPage: false }),
      getTags: async (q = "") => q ? [{ id: "1", label: q }] : [],
    }`);
    const b = loadBridge({ code, capabilities: mockHost() });
    const withQuery = await b.getTags!("romance");
    expect(withQuery).toHaveLength(1);
    expect(withQuery[0]!.label).toBe("romance");

    const empty = await b.getTags!();
    expect(empty).toHaveLength(0);
  });

  test("rejects output that fails schema validation", async () => {
    const bad = bundle(`{
      info: ${GOOD_INFO},
      getSeriesDetails: async () => ({ title: "missing id" }),
      getChapters: async () => [],
      getChapterPages: async () => [],
      getSearchResults: async () => ({ items: [], page: 1, hasNextPage: false }),
    }`);
    const b = loadBridge({ code: bad, capabilities: mockHost() });
    await expect(b.getSeriesDetails("x")).rejects.toBeInstanceOf(BridgeValidationError);
  });

  test("accepts server-relative page image URLs (proxy pattern)", async () => {
    const code = bundle(`{
      info: ${GOOD_INFO},
      getSeriesDetails: async (id) => ({ id, title: "T" }),
      getChapters: async () => [],
      getChapterPages: async () => [{ index: 0, imageUrl: "/bridges/smoke/series/x/page-image/abc123/42-1" }],
      getSearchResults: async () => ({ items: [], page: 1, hasNextPage: false }),
    }`);
    const b = loadBridge({ code, capabilities: mockHost() });
    const pages = await b.getChapterPages!("m", "c");
    expect(pages[0]!.imageUrl).toBe("/bridges/smoke/series/x/page-image/abc123/42-1");
  });

  test("rejects an incompatible contract version", () => {
    const code = bundle(`{
      info: { ...${GOOD_INFO}, contractVersion: "2.0.0" },
      getSeriesDetails: async (id) => ({ id, title: "T" }),
      getChapters: async () => [],
      getChapterPages: async () => [],
      getSearchResults: async () => ({ items: [], page: 1, hasNextPage: false }),
    }`);
    expect(() => loadBridge({ code, capabilities: mockHost() })).toThrow(BridgeContractError);
  });

  test("rejects an id mismatch against expectedId", () => {
    expect(() =>
      loadBridge({ code: GOOD_BRIDGE, capabilities: mockHost(), expectedId: "other" }),
    ).toThrow(BridgeContractError);
  });

  test("a bundle without a default factory fails to load", () => {
    expect(() => loadBridge({ code: `module.exports = {};`, capabilities: mockHost() })).toThrow(
      BridgeLoadError,
    );
  });

  test("wraps thrown bridge errors as BridgeRuntimeError", async () => {
    const code = bundle(`{
      info: ${GOOD_INFO},
      getSeriesDetails: async () => { throw new Error("backend down"); },
      getChapters: async () => [],
      getChapterPages: async () => [],
      getSearchResults: async () => ({ items: [], page: 1, hasNextPage: false }),
    }`);
    const b = loadBridge({ code, capabilities: mockHost() });
    await expect(b.getSeriesDetails("x")).rejects.toBeInstanceOf(BridgeRuntimeError);
  });

  test("enforces a per-call timeout", async () => {
    const code = bundle(`{
      info: ${GOOD_INFO},
      getSeriesDetails: async () => new Promise(() => {}),
      getChapters: async () => [],
      getChapterPages: async () => [],
      getSearchResults: async () => ({ items: [], page: 1, hasNextPage: false }),
    }`);
    const b = loadBridge({ code, capabilities: mockHost(), limits: { callTimeoutMs: 50 } });
    await expect(b.getSeriesDetails("x")).rejects.toBeInstanceOf(BridgeTimeoutError);
  });

  test("callTimeoutMs: 0 disables the per-call timeout (no lingering timer)", async () => {
    // Native hosts on quickjs-kt disable the timeout: its event loop won't return from `evaluate`
    // until every scheduled timer coroutine drains, so a per-call setTimeout stalls each method for
    // the full timeout. With callTimeoutMs 0, withTimeout returns the promise directly — no timer.
    const code = bundle(`{
      info: ${GOOD_INFO},
      getSeriesDetails: async (id) => { await new Promise((r) => setTimeout(r, 80)); return { id, title: id }; },
      getChapters: async () => [],
      getChapterPages: async () => [],
      getSearchResults: async () => ({ items: [], page: 1, hasNextPage: false }),
    }`);
    const b = loadBridge({ code, capabilities: mockHost(), limits: { callTimeoutMs: 0 } });
    // A method slower than the tiny timeout above would have rejected; with 0 it resolves.
    expect((await b.getSeriesDetails("x")).id).toBe("x");
  });
});

describe("sandbox isolation", () => {
  test("require / process / fetch / Bun are unavailable to bridge code", async () => {
    const code = bundle(`{
      info: ${GOOD_INFO},
      getSeriesDetails: async (id) => ({
        id,
        title: [typeof require, typeof process, typeof fetch, typeof Bun].join(","),
      }),
      getChapters: async () => [],
      getChapterPages: async () => [],
      getSearchResults: async () => ({ items: [], page: 1, hasNextPage: false }),
    }`);
    const b = loadBridge({ code, capabilities: mockHost() });
    const details = await b.getSeriesDetails("x");
    expect(details.title).toBe("undefined,undefined,undefined,undefined");
  });

  test("eval / Function constructor are disabled in the sandbox", async () => {
    const code = bundle(`{
      info: ${GOOD_INFO},
      getSeriesDetails: async (id) => { eval("1+1"); return { id, title: "T" }; },
      getChapters: async () => [],
      getChapterPages: async () => [],
      getSearchResults: async () => ({ items: [], page: 1, hasNextPage: false }),
    }`);
    const b = loadBridge({ code, capabilities: mockHost() });
    await expect(b.getSeriesDetails("x")).rejects.toBeInstanceOf(BridgeRuntimeError);
  });

  test("the gated network is the only way out, and reaches the host", async () => {
    let seen: HttpRequest | undefined;
    const host = mockHost((req) => {
      seen = req;
      return { url: req.url, status: 200, statusText: "OK", headers: {}, body: "pong" };
    });
    const code = bundle(`{
      info: ${GOOD_INFO},
      getSeriesDetails: async (id) => {
        const res = await host.network.request({ url: "https://backend.test/" + id });
        return { id, title: res.body };
      },
      getChapters: async () => [],
      getChapterPages: async () => [],
      getSearchResults: async () => ({ items: [], page: 1, hasNextPage: false }),
    }`);
    const b = loadBridge({ code, capabilities: host });
    const details = await b.getSeriesDetails("abc");
    expect(details.title).toBe("pong");
    expect(seen?.url).toBe("https://backend.test/abc");
  });

  // A bridge that fans out 3 requests at once and reports each request's start timestamp.
  const SLOW_INFO = `{ id: "smoke", name: "Smoke", version: "0.0.0", contractVersion: "1.0.0", languages: ["en"], nsfw: false, capabilities: ["search"], rateLimit: { maxConcurrent: 1, minIntervalMs: 80 } }`;
  const FANOUT = bundle(`{
    info: ${SLOW_INFO},
    getSeriesDetails: async (id) => ({ id, title: id }),
    getChapters: async () => [],
    getChapterPages: async () => [],
    getSearchResults: async () => {
      const starts = await Promise.all([0, 1, 2].map((i) =>
        host.network.request({ url: "https://b.test/" + i }).then((r) => Number(r.body))
      ));
      return { items: starts.map((s) => ({ id: String(s), title: String(s) })), page: 1, hasNextPage: false };
    },
  }`);
  const stampHost = () =>
    mockHost((req) => ({ url: req.url, status: 200, statusText: "OK", headers: {}, body: String(Date.now()) }));
  const startSpread = (items: Array<{ id: string }>): number => {
    const t = items.map((i) => Number(i.id)).sort((a, b) => a - b);
    return t[t.length - 1]! - t[0]!;
  };

  test("applies the bridge's declared info.rateLimit", async () => {
    const b = loadBridge({ code: FANOUT, capabilities: stampHost() });
    const res = await b.getSearchResults!("", 1);
    // 3 requests, 1 in flight, ≥80ms apart → starts span ≥ ~160ms (allow scheduling slack).
    expect(startSpread(res.items)).toBeGreaterThanOrEqual(140);
  });

  test("an explicit host rate-limit overrides the declaration (per key)", async () => {
    const b = loadBridge({
      code: FANOUT,
      capabilities: stampHost(),
      network: { rateLimit: { maxConcurrent: 10, minIntervalMs: 0 } },
    });
    const res = await b.getSearchResults!("", 1);
    // Host says "no spacing, 10 concurrent" — the declared 1/80ms must not apply.
    expect(startSpread(res.items)).toBeLessThan(60);
  });

  // A bridge that echoes the options bag it received back through item titles, so the test can
  // assert which option keys survive the loader's boundary schema.
  const ECHO_INFO = `{ id: "smoke", name: "Smoke", version: "0.0.0", contractVersion: "1.0.0", languages: ["en"], nsfw: false, capabilities: ["search", "lists", "exclude-tags"] }`;
  const ECHO_OPTS = bundle(`{
    info: ${ECHO_INFO},
    getSeriesDetails: async (id) => ({ id, title: id }),
    getChapters: async () => [],
    getChapterPages: async () => [],
    getSearchResults: async (q, p, opts) => ({ items: [{ id: "x", title: JSON.stringify(opts ?? null) }], page: p, hasNextPage: false }),
    getListItems: async (l, p, opts) => ({ items: [{ id: "x", title: JSON.stringify(opts ?? null) }], page: p, hasNextPage: false }),
  }`);

  test("excludedTags survives the search/list options boundary schema", async () => {
    const b = loadBridge({ code: ECHO_OPTS, capabilities: mockHost() });

    const search = await b.getSearchResults!("q", 1, { excludedTags: ["t1", "t2"] });
    expect(JSON.parse(search.items[0]!.title)).toEqual({ excludedTags: ["t1", "t2"] });

    const list = await b.getListItems!("popular", 1, { excludedTags: ["t3"] });
    expect(JSON.parse(list.items[0]!.title)).toEqual({ excludedTags: ["t3"] });
  });

  test("unknown option keys are still stripped at the boundary", async () => {
    const b = loadBridge({ code: ECHO_OPTS, capabilities: mockHost() });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const search = await b.getSearchResults!("q", 1, { excludedTags: ["t1"], bogus: 1 } as any);
    expect(JSON.parse(search.items[0]!.title)).toEqual({ excludedTags: ["t1"] });
  });
});
