import { describe, expect, test } from "bun:test";
import { bridgeInfoSchema, parseRateLimited, rateLimitedMessage } from "@comical/contract";
import type { HostCapabilities, LinkTarget } from "@comical/contract";
import {
  BridgeContractError,
  BridgeValidationError,
  bridgesForLink,
  loadBridge,
  normalizeLink,
  resolveLink,
} from "../src/index.ts";

function mockHost(): HostCapabilities {
  return {
    network: { request: async () => ({ url: "", status: 200, statusText: "OK", headers: {}, body: "" }) },
    storage: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      keys: async () => [],
      secure: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    settings: {},
  };
}

const bundle = (factoryBody: string) => `module.exports = { default: (host) => (${factoryBody}) };`;
const info = (linkHosts?: string[]) =>
  JSON.stringify({
    id: "lnk",
    name: "Lnk",
    version: "0.0.0",
    contractVersion: "2.1.0",
    languages: ["en"],
    nsfw: false,
    capabilities: ["search"],
    ...(linkHosts ? { linkHosts } : {}),
  });

describe("BridgeInfo.linkHosts", () => {
  test("accepts a list of hosts", () => {
    expect(bridgeInfoSchema.safeParse({ ...JSON.parse(info()), linkHosts: ["site.test"] }).success).toBe(true);
  });

  test("rejects an empty list or an empty host", () => {
    expect(bridgeInfoSchema.safeParse({ ...JSON.parse(info()), linkHosts: [] }).success).toBe(false);
    expect(bridgeInfoSchema.safeParse({ ...JSON.parse(info()), linkHosts: [""] }).success).toBe(false);
  });
});

describe("loader resolveUrl", () => {
  const BRIDGE = (body: string, linkHosts: string[] | null = ["site.test"]) =>
    bundle(`{ info: ${info(linkHosts ?? undefined)}, getSeriesDetails: async (id) => ({ id, title: "T" }), ${body} }`);

  test("exposes resolveUrl, validated", async () => {
    const b = await loadBridge({
      code: BRIDGE(`resolveUrl: async (url) => {
        const m = /\\/g\\/(\\d+)(?:\\/c\\/(\\d+))?/.exec(url);
        return m ? { seriesId: m[1], ...(m[2] ? { chapterId: m[2] } : {}) } : null;
      }`),
      capabilities: mockHost(),
    });
    expect(await b.resolveUrl!("https://site.test/g/12")).toEqual({ seriesId: "12" });
    expect(await b.resolveUrl!("https://site.test/g/12/c/3")).toEqual({ seriesId: "12", chapterId: "3" });
    expect(await b.resolveUrl!("https://site.test/search")).toBeNull();
  });

  test("rejects a result with an empty series id", async () => {
    const b = await loadBridge({ code: BRIDGE(`resolveUrl: async () => ({ seriesId: "" })`), capabilities: mockHost() });
    await expect(b.resolveUrl!("https://site.test/g/1")).rejects.toBeInstanceOf(BridgeValidationError);
  });

  test("rejects an empty url before the bridge sees it", async () => {
    // A bridge that would happily answer anything — so a rejection can only come from the loader.
    const b = await loadBridge({ code: BRIDGE(`resolveUrl: async () => ({ seriesId: "x" })`), capabilities: mockHost() });
    await expect(b.resolveUrl!("")).rejects.toBeInstanceOf(BridgeValidationError);
  });

  test("refuses a bridge that declares linkHosts without resolveUrl", async () => {
    await expect(loadBridge({ code: BRIDGE(""), capabilities: mockHost() })).rejects.toBeInstanceOf(BridgeContractError);
  });

  test("a bridge without links has no resolveUrl", async () => {
    const b = await loadBridge({ code: BRIDGE("", null), capabilities: mockHost() });
    expect(b.resolveUrl).toBeUndefined();
  });
});

describe("normalizeLink", () => {
  test("trims a pasted http(s) link", () => {
    expect(normalizeLink("  https://site.test/g/1 \n")).toBe("https://site.test/g/1");
    expect(normalizeLink("http://site.test")).toBe("http://site.test");
  });

  test("refuses text that isn't a single web link", () => {
    expect(normalizeLink("one piece")).toBeUndefined();
    expect(normalizeLink("site.test/g/1")).toBeUndefined();
    expect(normalizeLink("ftp://site.test/x")).toBeUndefined();
    expect(normalizeLink("https://site.test/a https://site.test/b")).toBeUndefined();
    expect(normalizeLink("https://")).toBeUndefined();
  });
});

describe("bridgesForLink", () => {
  const infos = [
    { id: "a", linkHosts: ["site.test"] },
    { id: "b" },
    { id: "c", linkHosts: ["other.test", "SITE.test"] },
  ];

  test("picks every bridge covering the host or a parent domain, in order", () => {
    expect(bridgesForLink(infos, "https://www.site.test/g/1")).toEqual(["a", "c"]);
    expect(bridgesForLink(infos, "https://other.test/x")).toEqual(["c"]);
  });

  test("picks none for an uncovered host or a lookalike", () => {
    expect(bridgesForLink(infos, "https://elsewhere.test/")).toEqual([]);
    expect(bridgesForLink(infos, "https://notsite.test/")).toEqual([]);
  });
});

describe("resolveLink", () => {
  const infos = [
    { id: "a", linkHosts: ["site.test"] },
    { id: "b", linkHosts: ["site.test"] },
  ];

  test("returns the first bridge that recognizes the link, skipping the ones that don't", async () => {
    const asked: string[] = [];
    const res = await resolveLink(infos, " https://site.test/g/1 ", async (id, url) => {
      asked.push(`${id} ${url}`);
      return id === "b" ? { seriesId: "1" } : null;
    });
    expect(res).toEqual({ ok: true, bridgeId: "b", target: { seriesId: "1" } });
    expect(asked).toEqual(["a https://site.test/g/1", "b https://site.test/g/1"]);
  });

  test("says why nothing opened it", async () => {
    const none = async (): Promise<LinkTarget | null> => null;
    expect(await resolveLink(infos, "not a link", none)).toEqual({ ok: false, reason: "invalid-url" });
    expect(await resolveLink(infos, "https://elsewhere.test/g/1", none)).toEqual({ ok: false, reason: "no-bridge" });
    expect(await resolveLink(infos, "https://site.test/search", none)).toEqual({ ok: false, reason: "not-recognized" });
  });

  test("a failing bridge doesn't stop the next one", async () => {
    const res = await resolveLink(infos, "https://site.test/g/1", async (id) => {
      if (id === "a") throw new Error("boom");
      return { seriesId: "1" };
    });
    expect(res).toEqual({ ok: true, bridgeId: "b", target: { seriesId: "1" } });
  });

  test("rethrows the first error when no bridge recognizes the link", async () => {
    const limited = rateLimitedMessage(5_000, "busy");
    const err = await resolveLink(infos, "https://site.test/g/1", async (id) => {
      if (id === "a") throw new Error(limited);
      return null;
    }).catch((e: Error) => e);
    expect(parseRateLimited((err as Error).message)?.retryAfterMs).toBe(5_000);
  });
});
