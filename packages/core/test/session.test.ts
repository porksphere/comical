/** The loaded bridge's session methods and the jar's place in the bridge's secure storage. */
import { describe, expect, test } from "bun:test";
import type { HostCapabilities, HttpRequest, HttpResponse, KeyValueStore } from "@comical/contract";
import { webCheckStorageKey } from "@comical/contract";
import { COOKIE_JAR_KEY, loadBridge } from "../src/index.ts";

const BRIDGE = `module.exports = { default: (host) => ({
  info: { id: "t.session", name: "S", version: "1.0.0", contractVersion: "2.1.0", languages: ["en"], nsfw: false, capabilities: [] },
  async getSeriesDetails(id) {
    const res = await host.network.request({ url: "https://www.s.test/series/" + id });
    const keys = await host.storage.secure.keys();
    const peek = await host.storage.secure.get(${JSON.stringify(COOKIE_JAR_KEY)});
    let refused = false;
    try { await host.storage.secure.set(${JSON.stringify(COOKIE_JAR_KEY)}, "x"); } catch { refused = true; }
    return { id, title: JSON.stringify({ status: res.status, keys, peek: peek ?? null, refused }) };
  },
}) };`;

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
    keys: async () => [...data.keys()],
  };
}

function caps(challenged: () => boolean, secure = memory()) {
  const seen: HttpRequest[] = [];
  const plain = memory();
  const capabilities: HostCapabilities = {
    network: {
      request: async (req: HttpRequest): Promise<HttpResponse> => {
        seen.push(req);
        const c = challenged();
        return { url: req.url, status: c ? 403 : 200, statusText: "", headers: c ? { "cf-mitigated": "challenge" } : {}, body: "" };
      },
    },
    storage: { ...plain, secure },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    settings: {},
    getDefaultUserAgent: () => "Host/1",
  };
  return { capabilities, seen, secure };
}

describe("loaded bridge session", () => {
  test("a challenge surfaces as the bridge's error; the import fixes it and is kept in secure storage", async () => {
    let challenged = true;
    const { capabilities, seen, secure } = caps(() => challenged);
    secure.data.set("bridge-own", "1");
    const bridge = await loadBridge({ code: BRIDGE, capabilities, network: { rateLimit: { minIntervalMs: 0 } } });
    await expect(bridge.getSeriesDetails("1")).rejects.toThrow(/\[challenge:https%3A%2F%2Fwww\.s\.test%2Fseries%2F1\|Host%2F1\]/);

    challenged = false;
    await bridge.importCookies!("https://www.s.test/series/1", [{ name: "cf_clearance", value: "ok", domain: ".s.test" }], "Host/1");
    const info = JSON.parse((await bridge.getSeriesDetails("1")).title);
    expect(info).toEqual({ status: 200, keys: ["bridge-own"], peek: null, refused: true });
    expect(Object.entries(seen.at(-1)!.headers ?? {}).find(([k]) => k.toLowerCase() === "cookie")?.[1]).toBe("cf_clearance=ok");
    expect(await bridge.sessionCookies!("https://img.s.test/1.jpg")).toEqual({ cookie: "cf_clearance=ok", userAgent: "Host/1" });

    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse(secure.data.get(COOKIE_JAR_KEY)!).cookies[0]).toMatchObject({ name: "cf_clearance", value: "ok" });
  });

  test("a new load restores the jar from secure storage", async () => {
    const secure = memory();
    secure.data.set(COOKIE_JAR_KEY, JSON.stringify({ v: 1, cookies: [{ name: "cf_clearance", value: "kept", domain: "s.test", hostOnly: false, path: "/", imported: true }], agents: {} }));
    const { capabilities, seen } = caps(() => false, secure);
    const bridge = await loadBridge({ code: BRIDGE, capabilities, network: { rateLimit: { minIntervalMs: 0 } } });
    await bridge.getSeriesDetails("2");
    expect(Object.entries(seen[0]!.headers ?? {}).find(([k]) => k.toLowerCase() === "cookie")?.[1]).toBe("cf_clearance=kept");
    await bridge.clearCookies!();
    expect(await bridge.sessionCookies!("https://www.s.test/")).toEqual({});
  });

  test("values read from the page's storage are kept where the bridge reads them, and cleared with the session", async () => {
    const { capabilities, secure } = caps(() => false);
    secure.data.set("bridge-own", "1");
    const bridge = await loadBridge({ code: BRIDGE, capabilities, network: { rateLimit: { minIntervalMs: 0 } } });
    await bridge.importCookies!("https://www.s.test/", [], "Host/1", { clearance: "tok" });
    expect(secure.data.get(webCheckStorageKey("clearance"))).toBe("tok");
    const info = JSON.parse((await bridge.getSeriesDetails("3")).title);
    expect(info.keys).toEqual(["bridge-own", webCheckStorageKey("clearance")]);

    await bridge.clearCookies!();
    expect(secure.data.has(webCheckStorageKey("clearance"))).toBe(false);
    expect(secure.data.get("bridge-own")).toBe("1");
  });
});
