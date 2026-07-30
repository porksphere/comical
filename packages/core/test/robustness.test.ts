import { describe, expect, test } from "bun:test";
import type { HostCapabilities, HttpResponse } from "@comical/contract";
import { BridgeRuntimeError, loadBridge } from "../src/index.ts";

function hostReturning(body: string, status = 200): HostCapabilities {
  const res: HttpResponse = { url: "http://b.test/", status, statusText: "", headers: {}, body };
  const store = new Map<string, string>();
  return {
    network: { request: async () => res },
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

const INFO = `{ id: "rob", name: "Rob", version: "0", contractVersion: "1.0.0", languages: ["en"], nsfw: false, capabilities: ["search"] }`;

/** A bridge whose search JSON-parses the (possibly malformed) response body. */
const JSON_BRIDGE = `module.exports = { default: (host) => ({
  info: ${INFO},
  getSeriesDetails: async (id) => ({ id, title: "T" }),
  getChapters: async () => [],
  getChapterPages: async () => [],
  getSearchResults: async (req) => {
    const res = await host.network.request({ url: "http://b.test/search" });
    const data = JSON.parse(res.body);
    return { items: data.items };
  },
}) };`;

describe("robustness", () => {
  test("malformed JSON body surfaces as a typed BridgeRuntimeError, not a crash", async () => {
    const b = loadBridge({ code: JSON_BRIDGE, capabilities: hostReturning("<html>not json</html>") });
    await expect(b.getSearchResults!({ text: "x" })).rejects.toBeInstanceOf(BridgeRuntimeError);
  });

  test("empty body surfaces as a typed error", async () => {
    const b = loadBridge({ code: JSON_BRIDGE, capabilities: hostReturning("") });
    await expect(b.getSearchResults!({ text: "x" })).rejects.toBeInstanceOf(BridgeRuntimeError);
  });

  test("a bridge that tolerates 5xx by returning empty resolves cleanly", async () => {
    const tolerant = `module.exports = { default: (host) => ({
      info: ${INFO},
      getSeriesDetails: async (id) => ({ id, title: "T" }),
      getChapters: async () => [],
      getChapterPages: async () => [],
      getSearchResults: async (req) => {
        const res = await host.network.request({ url: "http://b.test/search" });
        if (res.status >= 500) return { items: [] };
        return { items: [{ id: "m1", title: req.text }] };
      },
    }) };`;
    const b = loadBridge({ code: tolerant, capabilities: hostReturning("upstream error", 503) });
    const results = await b.getSearchResults!({ text: "x" });
    expect(results.items).toHaveLength(0);
  });
});
