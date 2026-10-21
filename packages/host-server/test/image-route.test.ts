/**
 * `GET /bridges/:id/image` — the route the loader rewrites a bridge's image URLs into when they
 * need headers or interception (`BridgeInfo.images`, contract 2.1).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BridgeImages, ImageRequest } from "@comical/contract";
import { bridgeImagePath } from "@comical/contract";
import type { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";

let cdn: ReturnType<typeof Bun.serve>;
let seen: { path: string; referer: string | null; token: string | null }[] = [];
let origin: string;

beforeAll(() => {
  cdn = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, referer: req.headers.get("referer"), token: req.headers.get("x-token") });
      return new Response(`bytes:${url.pathname}`, { headers: { "Content-Type": "image/png" } });
    },
  });
  // `localhost` and `127.0.0.1` name the same upstream as two different hosts.
  origin = `http://127.0.0.1:${cdn.port}`;
});
afterAll(() => cdn.stop(true));

interface MockBridge {
  interceptImageRequest?: (url: string) => Promise<ImageRequest>;
}

/** A router over one listed bridge `img`, whose instance is only reachable through `get`. */
function serve(images: BridgeImages | undefined, bridge: MockBridge = {}) {
  let loads = 0;
  const mgr = {
    list: async () => [
      {
        info: {
          id: "img", name: "Img", version: "1.0.0", contractVersion: "2.1.0",
          languages: ["en"], nsfw: false, capabilities: [], ...(images ? { images } : {}),
        },
        settings: [], configured: true, missingRequired: [], source: "registry" as const,
      },
    ],
    get: async (id: string) => {
      if (id !== "img") throw new Error(`not found: ${id}`);
      loads++;
      return bridge;
    },
    missingRequired: async () => [],
    storedSettings: async () => ({}),
  } as unknown as BridgeManager;
  const srv = Bun.serve({ port: 0, fetch: createRouter(mgr).fetch });
  return {
    get: (id: string, url: string) =>
      fetch(`http://localhost:${srv.port}${bridgeImagePath(id, url)}`, { redirect: "manual" }),
    loads: () => loads,
    stop: () => srv.stop(true),
  };
}

describe("GET /bridges/:id/image", () => {
  test("redirects an image that needs no headers to where the interceptor sent it, uncached", async () => {
    const s = serve(
      { hosts: ["localhost", "127.0.0.1"], intercept: ["localhost"] },
      { interceptImageRequest: async (u) => ({ url: u.replace("localhost", "127.0.0.1").replace("/old/", "/new/") }) },
    );
    try {
      const res = await s.get("img", `http://localhost:${cdn.port}/old/0.png`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${origin}/new/0.png`);
      expect(res.headers.get("cache-control")).toBe("no-store");
    } finally {
      s.stop();
    }
  });

  test("proxies with static headers, without loading the bridge", async () => {
    const s = serve({ hosts: ["127.0.0.1"], headers: { Referer: "https://site.example/" } });
    seen = [];
    try {
      const res = await s.get("img", `${origin}/a.png`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("bytes:/a.png");
      expect(res.headers.get("cache-control")).toBe("max-age=86400");
      expect(seen).toEqual([{ path: "/a.png", referer: "https://site.example/", token: null }]);
      expect(s.loads()).toBe(0);
    } finally {
      s.stop();
    }
  });

  test("proxies with the interceptor's headers on top of the static ones", async () => {
    const s = serve(
      { hosts: ["127.0.0.1"], headers: { Referer: "https://site.example/" }, intercept: ["127.0.0.1"] },
      { interceptImageRequest: async (u) => ({ url: u.replace("/a.png", "/b.png"), headers: { "X-Token": "t1" } }) },
    );
    seen = [];
    try {
      const res = await s.get("img", `${origin}/a.png`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("bytes:/b.png");
      expect(seen).toEqual([{ path: "/b.png", referer: "https://site.example/", token: "t1" }]);
      // Re-resolved on every fetch: nothing the interceptor returned is remembered.
      await s.get("img", `${origin}/a.png`);
      expect(s.loads()).toBe(2);
    } finally {
      s.stop();
    }
  });

  test("refuses an undeclared host and an interceptor that leaves the declared hosts", async () => {
    const s = serve(
      { hosts: ["localhost"], intercept: ["localhost"] },
      { interceptImageRequest: async () => ({ url: `${origin}/a.png` }) },
    );
    seen = [];
    try {
      expect((await s.get("img", `${origin}/a.png`)).status).toBe(403);
      expect((await s.get("img", `http://localhost:${cdn.port}/a.png`)).status).toBe(403);
      expect(seen).toEqual([]);
    } finally {
      s.stop();
    }
  });

  test("refuses every image of a bridge that declares no images", async () => {
    const s = serve(undefined);
    try {
      expect((await s.get("img", `${origin}/a.png`)).status).toBe(403);
    } finally {
      s.stop();
    }
  });

  test("404s an unknown bridge", async () => {
    const s = serve({ hosts: ["127.0.0.1"] });
    try {
      expect((await s.get("nope", `${origin}/a.png`)).status).toBe(404);
    } finally {
      s.stop();
    }
  });

  test("answers 429 with Retry-After when the interceptor reports the source is limiting it", async () => {
    const s = serve(
      { hosts: ["127.0.0.1"], intercept: ["127.0.0.1"] },
      {
        interceptImageRequest: async () => {
          throw new Error("interceptImageRequest threw: [rate-limited:60000] lookups exhausted");
        },
      },
    );
    try {
      const res = await s.get("img", `${origin}/a.png`);
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("60");
      expect(((await res.json()) as { error: string }).error).toContain("lookups exhausted");
    } finally {
      s.stop();
    }
  });

  test("500s when the interceptor fails", async () => {
    const s = serve(
      { hosts: ["127.0.0.1"], intercept: ["127.0.0.1"] },
      {
        interceptImageRequest: async () => {
          throw new Error("lookup page changed");
        },
      },
    );
    try {
      const res = await s.get("img", `${origin}/a.png`);
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toContain("lookup page changed");
    } finally {
      s.stop();
    }
  });
});
