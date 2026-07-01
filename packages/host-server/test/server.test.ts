/**
 * host-server integration tests: starts the full server (BridgeManager + REST API) against the
 * testkit fixture backend, exercises every endpoint a browser client would call.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FixtureBackend } from "@comical/testkit";
import { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-server");

let baseUrl: string;
let stop: () => void;
let fixtureStop: () => void;

beforeAll(async () => {
  // Start the testkit fixture backend on a real port.
  const fixture = new FixtureBackend().serve();
  fixtureStop = fixture.stop;

  // Pre-configure the example bridge to point at the fixture backend.
  const settings = new SettingsStore(DATA_DIR);
  await settings.set("example", { baseUrl: fixture.url });

  const manager = new BridgeManager({ bridgesDir: BRIDGES_DIR, dataDir: DATA_DIR, settings });
  const router = createRouter(manager);

  const srv = Bun.serve({ port: 0, fetch: router.fetch });
  baseUrl = `http://localhost:${srv.port}`;
  stop = () => srv.stop(true);
});

afterAll(() => { stop(); fixtureStop(); });

describe("GET /health", () => {
  test("returns ok", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
  });
});

describe("GET /bridges", () => {
  test("lists the example bridge", async () => {
    const list = await fetch(`${baseUrl}/bridges`).then(r => r.json()) as Array<{ info: { id: string }; configured: boolean }>;
    expect(list.some(b => b.info.id === "example")).toBe(true);
    expect(list.find(b => b.info.id === "example")?.configured).toBe(true);
  });
});

describe("GET /bridges/:id", () => {
  test("returns info and settings descriptors", async () => {
    const data = await fetch(`${baseUrl}/bridges/example`).then(r => r.json()) as { info: { id: string; iconUrl?: string }; settings: unknown[] };
    expect(data.info.id).toBe("example");
    expect(Array.isArray(data.settings)).toBe(true);
  });

  test("passes through the bridge's declared iconUrl", async () => {
    const data = await fetch(`${baseUrl}/bridges/example`).then(r => r.json()) as { info: { iconUrl?: string } };
    expect(data.info.iconUrl).toBe("https://example.com/favicon.ico");
  });

  test("404 for unknown bridge", async () => {
    const res = await fetch(`${baseUrl}/bridges/nonexistent`);
    expect(res.status).toBe(404);
  });
});

describe("content endpoints", () => {
  test("GET /bridges/:id/search returns series entries", async () => {
    const data = await fetch(`${baseUrl}/bridges/example/search?q=alice`).then(r => r.json()) as { items: Array<{ id: string; title: string }> };
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items[0]!.id).toBe("alice");
  });

  test("GET /bridges/:id/lists returns the list catalog", async () => {
    const lists = await fetch(`${baseUrl}/bridges/example/lists`).then(r => r.json()) as Array<{ id: string; name: string; layout?: string; featured?: boolean }>;
    expect(lists.length).toBeGreaterThan(0);
    expect(lists[0]!.id).toBeTruthy();
    expect(lists[0]!.layout).toBe("carousel");
  });

  test("GET /bridges/:id/lists/:listId returns series entries", async () => {
    const data = await fetch(`${baseUrl}/bridges/example/lists/popular`).then(r => r.json()) as { items: Array<{ id: string }> };
    expect(data.items.length).toBeGreaterThan(0);
  });

  test("GET /bridges/:id/series/:id returns series details", async () => {
    const data = await fetch(`${baseUrl}/bridges/example/series/sherlock`).then(r => r.json()) as { id: string; title: string };
    expect(data.id).toBe("sherlock");
    expect(data.title).toContain("Sherlock");
  });

  test("GET /bridges/:id/series/:id/chapters returns ordered chapters", async () => {
    const chapters = await fetch(`${baseUrl}/bridges/example/series/sherlock/chapters`).then(r => r.json()) as Array<{ id: string; number: number }>;
    expect(chapters.length).toBe(3);
    expect(chapters[0]!.number).toBe(1);
  });

  test("GET /bridges/:id/series/:id/chapters/:id/pages returns absolute image URLs", async () => {
    const pages = await fetch(`${baseUrl}/bridges/example/series/sherlock/chapters/sherlock-1/pages`).then(r => r.json()) as Array<{ index: number; imageUrl: string }>;
    expect(pages.length).toBe(4);
    expect(pages[0]!.imageUrl).toMatch(/^http/);
  });
});

describe("GET /bridges/:id/series/:seriesId/page-image/:hash/:gidRef", () => {
  test("returns 404 when bridge does not implement resolvePage", async () => {
    const res = await fetch(`${baseUrl}/bridges/example/series/alice/page-image/abc123/12345-1`);
    expect(res.status).toBe(404);
  });

  test("returns 302 redirect to the resolved CDN URL for a bridge that implements resolvePage", async () => {
    const mockBridge = {
      info: { id: "mock", name: "Mock", version: "0.0.1", contractVersion: "1.0.0", capabilities: ["direct"] },
      getSeriesDetails: async () => ({ id: "test", title: "Test" }),
      resolvePage: async (_s: string, _h: string, _ref: string) => "https://cdn.example.com/image.jpg",
    };
    const mockMgr = {
      list: async () => [],
      get: async (id: string) => { if (id !== "mock") throw new Error(`not found: ${id}`); return mockBridge; },
      missingRequired: async () => [],
      storedSettings: async () => ({}),
    } as unknown as import("../src/bridge-manager.ts").BridgeManager;

    const srv = Bun.serve({ port: 0, fetch: createRouter(mockMgr).fetch });
    const mockUrl = `http://localhost:${srv.port}`;
    try {
      const res = await fetch(
        `${mockUrl}/bridges/mock/series/test%3A123/page-image/abc123/12345-1`,
        { redirect: "manual" },
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://cdn.example.com/image.jpg");
    } finally {
      srv.stop(true);
    }
  });
});

describe("GET /bridges/:id/series/:seriesId/page-thumb/:pageIndex", () => {
  test("returns 404 when bridge does not implement getPageThumbnail", async () => {
    const res = await fetch(`${baseUrl}/bridges/example/series/alice/page-thumb/5`);
    expect(res.status).toBe(404);
  });

  test("returns the JSON thumbnail descriptor for a bridge that implements getPageThumbnail", async () => {
    const sprite = { kind: "sprite", sheetUrl: "/test-sprite.svg", x: 0, y: 0, w: 200, h: 289, sheetWidth: 4000, sheetHeight: 289 };
    const mockBridge = {
      info: { id: "mock-pt", name: "Mock PT", version: "0.0.1", contractVersion: "1.0.0", capabilities: ["direct"] },
      getSeriesDetails: async () => ({ id: "test", title: "Test" }),
      getPageThumbnail: async (_s: string, _idx: number) => sprite,
    };
    const mockMgr = {
      list: async () => [],
      get: async (id: string) => { if (id !== "mock-pt") throw new Error(`not found: ${id}`); return mockBridge; },
      missingRequired: async () => [],
      storedSettings: async () => ({}),
    } as unknown as import("../src/bridge-manager.ts").BridgeManager;

    const srv = Bun.serve({ port: 0, fetch: createRouter(mockMgr).fetch });
    const mockUrl = `http://localhost:${srv.port}`;
    try {
      const res = await fetch(`${mockUrl}/bridges/mock-pt/series/test/page-thumb/5`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(sprite);
    } finally {
      srv.stop(true);
    }
  });
});

describe("GET /img-proxy", () => {
  test("returns 403 for disallowed URL", async () => {
    const res = await fetch(`${baseUrl}/img-proxy?url=${encodeURIComponent("https://evil.com/img.jpg")}`);
    expect(res.status).toBe(403);
  });

  test("returns 403 when url param is missing", async () => {
    const res = await fetch(`${baseUrl}/img-proxy`);
    expect(res.status).toBe(403);
  });

  test("returns 403 for empty url", async () => {
    const res = await fetch(`${baseUrl}/img-proxy?url=`);
    expect(res.status).toBe(403);
  });

  test("does not require auth token even when token is set", async () => {
    const authMgr = {
      list: async () => [],
      get: async (id: string) => { throw new Error(`not found: ${id}`); },
      missingRequired: async () => [],
      storedSettings: async () => ({}),
    } as unknown as import("../src/bridge-manager.ts").BridgeManager;
    const tokenSrv = Bun.serve({ port: 0, fetch: createRouter(authMgr, { token: "secret" }).fetch });
    try {
      // /img-proxy should respond (403 for bad URL, not 401) even without Authorization header
      const res = await fetch(`http://localhost:${tokenSrv.port}/img-proxy?url=https://evil.com/img.jpg`);
      expect(res.status).toBe(403);
    } finally {
      tokenSrv.stop(true);
    }
  });
});

describe("PUT /bridges/:id/settings", () => {
  test("updates settings and bridges re-use new config", async () => {
    const res = await fetch(`${baseUrl}/bridges/example/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://updated.example" }),
    });
    expect(res.ok).toBe(true);
    const { settings } = await res.json() as { settings: { baseUrl: string } };
    expect(settings.baseUrl).toBe("http://updated.example");
  });
});
