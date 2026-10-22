/**
 * `GET /resolve-link?url=` — open a pasted or shared web link with the installed bridge that covers
 * its host (`BridgeInfo.linkHosts` + `Bridge.resolveUrl`, contract 2.1).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rateLimitedMessage, type LinkTarget } from "@comical/contract";
import type { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";

const info = (id: string, linkHosts?: string[]) => ({
  id, name: id, version: "1.0.0", contractVersion: "2.1.0",
  languages: ["en"], nsfw: false, capabilities: [], ...(linkHosts ? { linkHosts } : {}),
});

/** Bridges by id: each one's `linkHosts` and `resolveUrl`. */
const BRIDGES: Record<string, { linkHosts?: string[]; resolveUrl?: (url: string) => Promise<LinkTarget | null> }> = {
  gallery: {
    linkHosts: ["site.test"],
    resolveUrl: async (url) => {
      const m = /\/g\/(\d+)(?:\/c\/(\d+))?/.exec(url);
      return m ? { seriesId: m[1]!, ...(m[2] ? { chapterId: m[2] } : {}) } : null;
    },
  },
  busy: {
    linkHosts: ["busy.test"],
    resolveUrl: async () => { throw new Error(rateLimitedMessage(7_000, "slow down")); },
  },
  plain: {},
};

let srv: ReturnType<typeof Bun.serve>;
let loads: string[] = [];
const resolve = (url: string) => fetch(`http://localhost:${srv.port}/resolve-link?url=${encodeURIComponent(url)}`);

beforeAll(() => {
  const mgr = {
    list: async () =>
      Object.entries(BRIDGES).map(([id, b]) => ({
        info: info(id, b.linkHosts),
        settings: [], configured: true, missingRequired: [], secretsSet: [], source: "registry" as const,
      })),
    get: async (id: string) => {
      const b = BRIDGES[id];
      if (!b) throw new Error(`not found: ${id}`);
      loads.push(id);
      return { info: info(id, b.linkHosts), resolveUrl: b.resolveUrl };
    },
    missingRequired: async () => [],
    storedSettings: async () => ({}),
  } as unknown as BridgeManager;
  srv = Bun.serve({ port: 0, fetch: createRouter(mgr).fetch });
});
afterAll(() => srv.stop(true));

describe("GET /resolve-link", () => {
  test("opens a series link with the bridge that covers its host", async () => {
    loads = [];
    const res = await resolve("https://www.site.test/g/42");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bridgeId: "gallery", seriesId: "42" });
    // Only the covering bridge is loaded.
    expect(loads).toEqual(["gallery"]);
  });

  test("opens a chapter link with its chapter", async () => {
    const res = await resolve("https://site.test/g/42/c/7");
    expect(await res.json()).toEqual({ bridgeId: "gallery", seriesId: "42", chapterId: "7" });
  });

  test("404s with not-recognized for a page the bridge can't open", async () => {
    const res = await resolve("https://site.test/search?q=x");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { reason: string }).reason).toBe("not-recognized");
  });

  test("404s with no-bridge for a site nothing covers, without loading anything", async () => {
    loads = [];
    const res = await resolve("https://elsewhere.test/g/1");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { reason: string }).reason).toBe("no-bridge");
    expect(loads).toEqual([]);
  });

  test("400s for text that isn't a web link", async () => {
    for (const url of ["", "one piece"]) {
      const res = await resolve(url);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { reason: string }).reason).toBe("invalid-url");
    }
  });

  test("passes a rate-limited bridge through as 429 with Retry-After", async () => {
    const res = await resolve("https://busy.test/g/1");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
  });
});
