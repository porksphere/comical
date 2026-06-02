/**
 * FunctionEvaluator tests. Runs under Bun (which has browser-like globals), so we can exercise
 * the browser evaluator without an actual browser.
 */
import { describe, expect, test } from "bun:test";
import { loadBridge } from "@comical/core";
import type { HostCapabilities } from "@comical/contract";
import { FunctionEvaluator } from "../src/evaluator.ts";

function mockHost(): HostCapabilities {
  const store = new Map<string, string>();
  return {
    network: { request: async () => { throw new Error("no network in test"); } },
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

const INFO = `{ id: "web", name: "Web", version: "0", contractVersion: "1.0.0", languages: ["en"], nsfw: false, capabilities: ["search"] }`;

function cjsBundle(factoryBody: string): string {
  return `module.exports = { default: (host) => (${factoryBody}) };`;
}

const GOOD = cjsBundle(`{
  info: ${INFO},
  getSeriesDetails: async (id) => ({ id, title: "T" }),
  getChapters: async () => [],
  getChapterPages: async () => [],
  getSearchResults: async (q, p) => ({ items: [{ id: "x", title: q }], page: p, hasNextPage: false }),
}`);

describe("FunctionEvaluator", () => {
  test("loads a bridge and executes a method", async () => {
    const b = loadBridge({ code: GOOD, capabilities: mockHost(), evaluator: new FunctionEvaluator() });
    expect(b.info.id).toBe("web");
    const r = await b.getSearchResults!("hello", 1);
    expect(r.items[0]!.title).toBe("hello");
  });

  test("fetch is shadowed — bridge code cannot call fetch directly", async () => {
    const code = cjsBundle(`{
      info: ${INFO},
      getSeriesDetails: async (id) => ({ id, title: String(typeof fetch) }),
      getChapters: async () => [],
      getChapterPages: async () => [],
      getSearchResults: async () => ({ items: [], page: 1, hasNextPage: false }),
    }`);
    const b = loadBridge({ code, capabilities: mockHost(), evaluator: new FunctionEvaluator() });
    const d = await b.getSeriesDetails("x");
    expect(d.title).toBe("undefined");
  });

  test("XMLHttpRequest is shadowed", async () => {
    const code = cjsBundle(`{
      info: ${INFO},
      getSeriesDetails: async (id) => ({ id, title: String(typeof XMLHttpRequest) }),
      getChapters: async () => [],
      getChapterPages: async () => [],
      getSearchResults: async () => ({ items: [], page: 1, hasNextPage: false }),
    }`);
    const b = loadBridge({ code, capabilities: mockHost(), evaluator: new FunctionEvaluator() });
    const d = await b.getSeriesDetails("x");
    expect(d.title).toBe("undefined");
  });

  test("the gated network (host.network) is still reachable", async () => {
    let called = false;
    const host = mockHost();
    host.network.request = async () => { called = true; return { url: "", status: 200, statusText: "OK", headers: {}, body: "ok" }; };
    const code = cjsBundle(`{
      info: ${INFO},
      getSeriesDetails: async (id) => {
        await host.network.request({ url: "https://test/" });
        return { id, title: "T" };
      },
      getChapters: async () => [],
      getChapterPages: async () => [],
      getSearchResults: async () => ({ items: [], page: 1, hasNextPage: false }),
    }`);
    const b = loadBridge({ code, capabilities: host, evaluator: new FunctionEvaluator() });
    await b.getSeriesDetails("x");
    expect(called).toBe(true);
  });
});
