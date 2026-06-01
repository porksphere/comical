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
  getSettings: () => [{ type: "text", key: "baseUrl", label: "Backend URL", required: true }],
}`);

describe("loadBridge", () => {
  test("loads a valid bridge and round-trips a search → details", async () => {
    const b = loadBridge({ code: GOOD_BRIDGE, capabilities: mockHost() });
    expect(b.info.id).toBe("smoke");

    const results = await b.getSearchResults("naruto", 1);
    expect(results.items).toHaveLength(1);
    const id = results.items[0]!.id;

    const details = await b.getSeriesDetails(id);
    expect(details.title).toContain(id);
  });

  test("only present optional methods are exposed", () => {
    const b = loadBridge({ code: GOOD_BRIDGE, capabilities: mockHost() });
    expect(typeof b.getSettings).toBe("function");
    expect(b.getHomeSections).toBeUndefined();
    expect(b.getTags).toBeUndefined();
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

  test("rejects relative page image URLs (must be absolute)", async () => {
    const bad = bundle(`{
      info: ${GOOD_INFO},
      getSeriesDetails: async (id) => ({ id, title: "T" }),
      getChapters: async () => [],
      getChapterPages: async () => [{ index: 0, imageUrl: "/relative/0.png" }],
      getSearchResults: async () => ({ items: [], page: 1, hasNextPage: false }),
    }`);
    const b = loadBridge({ code: bad, capabilities: mockHost() });
    await expect(b.getChapterPages("m", "c")).rejects.toBeInstanceOf(BridgeValidationError);
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
});
