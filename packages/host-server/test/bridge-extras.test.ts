/**
 * Tests bridge capability endpoints not covered by server.test.ts: filters, sort options,
 * tags (not-supported case), and favorites (PUT / DELETE / GET). Also verifies that
 * /library/* routes return 404 when no library is wired into the router.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FixtureBackend } from "@comical/testkit";
import { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-bridge-extras");

let baseUrl: string;
let stop: () => void;
let fixtureStop: () => void;

beforeAll(async () => {
  const fixture = new FixtureBackend().serve();
  fixtureStop = fixture.stop;

  const settings = new SettingsStore(DATA_DIR);
  await settings.set("example", {
    baseUrl: fixture.url,
    sessionToken: "test-token", // required by getFavorites / addFavorite / removeFavorite
  });

  const manager = new BridgeManager({ bridgesDir: BRIDGES_DIR, dataDir: DATA_DIR, settings });
  const srv = Bun.serve({ port: 0, fetch: createRouter(manager).fetch });
  baseUrl = `http://localhost:${srv.port}`;
  stop = () => srv.stop(true);
});

afterAll(() => { stop(); fixtureStop(); });

describe("GET /bridges/:id/filters", () => {
  test("returns filter descriptors for the example bridge", async () => {
    const filters = await fetch(`${baseUrl}/bridges/example/filters`).then((r) => r.json()) as Array<{ key: string }>;
    expect(Array.isArray(filters)).toBe(true);
    expect(filters.length).toBeGreaterThan(0);
    expect(filters.some((f) => f.key === "genre")).toBe(true);
  });
});

describe("GET /bridges/:id/sort", () => {
  test("returns sort options for the example bridge", async () => {
    const options = await fetch(`${baseUrl}/bridges/example/sort`).then((r) => r.json()) as Array<{ key: string; label: string }>;
    expect(Array.isArray(options)).toBe(true);
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((o) => o.key === "title")).toBe(true);
  });
});

describe("GET /bridges/:id/tags", () => {
  test("returns 400 when bridge does not implement getTags", async () => {
    const res = await fetch(`${baseUrl}/bridges/example/tags?q=`);
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toContain("not supported");
  });
});

describe("favorites", () => {
  test("PUT /bridges/:id/favorites/:seriesId → 200", async () => {
    const res = await fetch(`${baseUrl}/bridges/example/favorites/alice`, { method: "PUT" });
    expect(res.ok).toBe(true);
    const data = await res.json() as { ok: boolean };
    expect(data.ok).toBe(true);
  });

  test("GET /bridges/:id/favorites returns a paged result after adding", async () => {
    const data = await fetch(`${baseUrl}/bridges/example/favorites`).then((r) => r.json()) as { items: Array<{ id: string }>; hasNextPage: boolean };
    expect(data.items.some((item) => item.id === "alice")).toBe(true);
  });

  test("GET /bridges/:id/favorites/:seriesId → favorited true after PUT", async () => {
    const data = await fetch(`${baseUrl}/bridges/example/favorites/alice`).then((r) => r.json()) as { favorited: boolean };
    expect(data.favorited).toBe(true);
  });

  test("DELETE /bridges/:id/favorites/:seriesId → 200 and series is removed", async () => {
    const res = await fetch(`${baseUrl}/bridges/example/favorites/alice`, { method: "DELETE" });
    expect(res.ok).toBe(true);

    const check = await fetch(`${baseUrl}/bridges/example/favorites/alice`).then((r) => r.json()) as { favorited: boolean };
    expect(check.favorited).toBe(false);
  });
});

describe("library routes absent without Library service", () => {
  test("GET /library → 404 when no library is wired into the router", async () => {
    // This server was created without opts.library, so /library/* routes are not registered.
    expect((await fetch(`${baseUrl}/library`)).status).toBe(404);
  });

  test("POST /library/entries → 404 when no library is wired", async () => {
    const res = await fetch(`${baseUrl}/library/entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bridgeId: "x", seriesId: "y" }),
    });
    expect(res.status).toBe(404);
  });
});
