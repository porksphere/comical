import { describe, expect, test } from "bun:test";
import { bridgeImagePath, bridgeInfoSchema, parseRateLimited, rateLimitedMessage } from "@comical/contract";
import type { BridgeImages, HostCapabilities } from "@comical/contract";
import {
  BridgeContractError,
  BridgeValidationError,
  ImageRequestRefusedError,
  assetHostOf,
  loadBridge,
  needsImageRoute,
  resolveImageRequest,
} from "../src/index.ts";

function mockHost(): HostCapabilities {
  const store = new Map<string, string>();
  return {
    network: { request: async () => ({ url: "", status: 200, statusText: "OK", headers: {}, body: "" }) },
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, v),
      delete: async (k) => void store.delete(k),
      keys: async () => [...store.keys()],
      secure: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    settings: {},
  };
}

const bundle = (factoryBody: string) => `module.exports = { default: (host) => (${factoryBody}) };`;

const IMAGES: BridgeImages = {
  hosts: ["cdn.example.test", "plain.example.test", "rotating.example.test", "real.example.test"],
  intercept: ["rotating.example.test"],
};
const info = (images?: BridgeImages, capabilities: string[] = ["search", "direct"]) =>
  JSON.stringify({
    id: "img",
    name: "Img",
    version: "0.0.0",
    contractVersion: "2.1.0",
    languages: ["en"],
    nsfw: false,
    capabilities,
    ...(images ? { images } : {}),
  });

describe("needsImageRoute", () => {
  const withHeaders: BridgeImages = { hosts: ["example.test"], headers: { Referer: "https://example.test/" } };

  test("routes a declared host that needs headers, including its subdomains", () => {
    expect(needsImageRoute(withHeaders, "https://example.test/a.jpg")).toBe(true);
    expect(needsImageRoute(withHeaders, "https://cdn.example.test/a.jpg")).toBe(true);
  });

  test("routes an intercepted host even with no headers", () => {
    expect(needsImageRoute(IMAGES, "https://rotating.example.test/a.jpg")).toBe(true);
  });

  test("leaves a host needing nothing, an undeclared host, and non-http URLs alone", () => {
    expect(needsImageRoute(IMAGES, "https://plain.example.test/a.jpg")).toBe(false);
    expect(needsImageRoute(withHeaders, "https://elsewhere.test/a.jpg")).toBe(false);
    expect(needsImageRoute(withHeaders, "data:image/png;base64,AAAA")).toBe(false);
    expect(needsImageRoute(withHeaders, "/img-proxy?url=https%3A%2F%2Fexample.test%2Fa.jpg")).toBe(false);
    expect(needsImageRoute(undefined, "https://example.test/a.jpg")).toBe(false);
  });
});

describe("BridgeInfo.images", () => {
  test("rejects an intercept host that hosts doesn't cover", () => {
    const parsed = bridgeInfoSchema.safeParse({
      ...JSON.parse(info()),
      images: { hosts: ["example.test"], intercept: ["other.test"] },
    });
    expect(parsed.success).toBe(false);
  });

  test("accepts an intercept host covered as a subdomain", () => {
    const parsed = bridgeInfoSchema.safeParse({
      ...JSON.parse(info()),
      images: { hosts: ["example.test"], intercept: ["cdn.example.test"] },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("loader image routing", () => {
  const BRIDGE = (images?: BridgeImages) =>
    bundle(`{
      info: ${info(images)},
      getSeriesDetails: async (id) => ({ id, title: "T", thumbnailUrl: "https://rotating.example.test/cover.jpg" }),
      getSearchResults: async () => ({ items: [
        { id: "a", title: "A", thumbnailUrl: "https://rotating.example.test/a.jpg" },
        { id: "b", title: "B", thumbnailUrl: "https://plain.example.test/b.jpg" },
        { id: "c", title: "C" },
      ] }),
      getSeriesPages: async () => [
        { index: 0, imageUrl: "https://rotating.example.test/0.jpg", thumbnail: { kind: "sprite", sheetUrl: "https://rotating.example.test/sheet.jpg", x: 0, w: 10, h: 10, sheetWidth: 100 } },
        { index: 1, imageUrl: "https://plain.example.test/1.jpg", thumbnail: { kind: "image", url: "https://rotating.example.test/t1.jpg" } },
      ],
      getPageThumbnail: async () => ({ kind: "image", url: "https://rotating.example.test/t.jpg" }),
      interceptImageRequest: async (url) => ({ url: url.replace("rotating", "real") }),
    }`);
  const routed = (url: string) => bridgeImagePath("img", url);

  test("rewrites every image URL a client can't load by itself, and only those", async () => {
    const b = await loadBridge({ code: BRIDGE(IMAGES), capabilities: mockHost() });

    const results = await b.getSearchResults!({ text: "x" });
    expect(results.items.map((e) => e.thumbnailUrl)).toEqual([
      routed("https://rotating.example.test/a.jpg"),
      "https://plain.example.test/b.jpg",
      undefined,
    ]);
    expect((await b.getSeriesDetails("s")).thumbnailUrl).toBe(routed("https://rotating.example.test/cover.jpg"));

    const pages = await b.getSeriesPages!("s");
    expect(pages[0]!.imageUrl).toBe(routed("https://rotating.example.test/0.jpg"));
    expect(pages[0]!.thumbnail).toMatchObject({ kind: "sprite", sheetUrl: routed("https://rotating.example.test/sheet.jpg") });
    expect(pages[1]!.imageUrl).toBe("https://plain.example.test/1.jpg");
    expect(pages[1]!.thumbnail).toEqual({ kind: "image", url: routed("https://rotating.example.test/t1.jpg") });

    expect(await b.getPageThumbnail!("s", 0)).toEqual({ kind: "image", url: routed("https://rotating.example.test/t.jpg") });
  });

  test("leaves a bridge without images untouched", async () => {
    const b = await loadBridge({
      code: BRIDGE(undefined).replace("interceptImageRequest", "unusedHook"),
      capabilities: mockHost(),
    });
    expect((await b.getSearchResults!({ text: "x" })).items[0]!.thumbnailUrl).toBe("https://rotating.example.test/a.jpg");
    expect(b.interceptImageRequest).toBeUndefined();
  });

  test("exposes the interceptor, validated", async () => {
    const b = await loadBridge({ code: BRIDGE(IMAGES), capabilities: mockHost() });
    expect(await b.interceptImageRequest!("https://rotating.example.test/0.jpg")).toEqual({
      url: "https://real.example.test/0.jpg",
    });
  });

  test("refuses a bridge that intercepts without an interceptor", async () => {
    const code = bundle(`{ info: ${info(IMAGES)}, getSeriesDetails: async (id) => ({ id, title: "T" }) }`);
    await expect(loadBridge({ code, capabilities: mockHost() })).rejects.toBeInstanceOf(BridgeContractError);
  });

  test("rejects an interceptor result that isn't a URL", async () => {
    const code = bundle(`{
      info: ${info(IMAGES)},
      getSeriesDetails: async (id) => ({ id, title: "T" }),
      interceptImageRequest: async () => ({ url: "not a url" }),
    }`);
    const b = await loadBridge({ code, capabilities: mockHost() });
    await expect(b.interceptImageRequest!("https://rotating.example.test/0.jpg")).rejects.toBeInstanceOf(
      BridgeValidationError,
    );
  });

  test("passes an interceptor's rate-limited error through with its wait", async () => {
    const code = bundle(`{
      info: ${info(IMAGES)},
      getSeriesDetails: async (id) => ({ id, title: "T" }),
      interceptImageRequest: async () => { throw new Error(${JSON.stringify(rateLimitedMessage(30_000, "busy"))}); },
    }`);
    const b = await loadBridge({ code, capabilities: mockHost() });
    const err = await b.interceptImageRequest!("https://rotating.example.test/0.jpg").catch((e: Error) => e);
    expect(parseRateLimited((err as Error).message)?.retryAfterMs).toBe(30_000);
  });
});

describe("resolveImageRequest", () => {
  const base = { id: "img" };

  test("applies static headers to a non-intercepted host without calling the interceptor", async () => {
    let calls = 0;
    const req = await resolveImageRequest(
      { ...base, images: { hosts: ["example.test"], headers: { Referer: "https://example.test/" } } },
      "https://cdn.example.test/a.jpg",
      async () => (calls++, { url: "https://example.test/x" }),
    );
    expect(req).toEqual({ url: "https://cdn.example.test/a.jpg", headers: { Referer: "https://example.test/" } });
    expect(calls).toBe(0);
  });

  test("intercepts a declared host; its headers override static ones case-insensitively", async () => {
    const req = await resolveImageRequest(
      { ...base, images: { hosts: ["example.test", "real.test"], headers: { Referer: "https://a/", Accept: "image/*" }, intercept: ["example.test"] } },
      "https://example.test/a.jpg",
      async (url) => ({ url: url.replace("example.test", "real.test"), headers: { referer: "https://b/" } }),
    );
    expect(req).toEqual({ url: "https://real.test/a.jpg", headers: { Accept: "image/*", referer: "https://b/" } });
  });

  test("an image needing nothing resolves with no headers", async () => {
    const req = await resolveImageRequest(
      { ...base, images: { hosts: ["example.test"], intercept: ["example.test"] } },
      "https://example.test/a.jpg",
      async (url) => ({ url }),
    );
    expect(req.headers).toEqual({});
  });

  test("refuses an undeclared host, a non-http URL, and a bridge with no images", async () => {
    const images = { hosts: ["example.test"] };
    await expect(resolveImageRequest({ ...base, images }, "https://evil.test/a.jpg")).rejects.toBeInstanceOf(ImageRequestRefusedError);
    await expect(resolveImageRequest({ ...base, images }, "file:///etc/passwd")).rejects.toBeInstanceOf(ImageRequestRefusedError);
    await expect(resolveImageRequest(base, "https://example.test/a.jpg")).rejects.toBeInstanceOf(ImageRequestRefusedError);
  });

  test("refuses an interceptor that sends the request off the declared hosts", async () => {
    const images = { hosts: ["example.test"], intercept: ["example.test"] };
    await expect(
      resolveImageRequest({ ...base, images }, "https://example.test/a.jpg", async () => ({ url: "http://169.254.169.254/" })),
    ).rejects.toBeInstanceOf(ImageRequestRefusedError);
  });

  test("refuses an intercepted host when there is no interceptor to call", async () => {
    const images = { hosts: ["example.test"], intercept: ["example.test"] };
    await expect(resolveImageRequest({ ...base, images }, "https://example.test/a.jpg")).rejects.toBeInstanceOf(
      ImageRequestRefusedError,
    );
  });

  test("propagates what the interceptor throws", async () => {
    const images = { hosts: ["example.test"], intercept: ["example.test"] };
    await expect(
      resolveImageRequest({ ...base, images }, "https://example.test/a.jpg", async () => {
        throw new Error("lookup failed");
      }),
    ).rejects.toThrow("lookup failed");
  });
});

describe("assetHostOf", () => {
  test("unwraps an image-route path, absolute or server-relative", () => {
    expect(assetHostOf(bridgeImagePath("img", "https://cdn.example.test/a.jpg"))).toBe("cdn.example.test");
    expect(assetHostOf(`http://host:3100${bridgeImagePath("img", "https://cdn.example.test/a.jpg")}`)).toBe("cdn.example.test");
  });
});
