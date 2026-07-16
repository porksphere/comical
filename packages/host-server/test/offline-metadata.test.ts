/**
 * Offline library metadata: the series-details and chapters routes fall back to the library's
 * metadata cache when the bridge can't answer (source down, bridge uninstalled), and successful
 * live responses write through to it. Non-library series keep their exact error behavior.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Library } from "@comical/library";
import { ComicalRuntime } from "@comical/runtime";
import { FixtureBackend } from "@comical/testkit";
import { BridgeManager } from "../src/bridge-manager.ts";
import { FileLibraryStore } from "../src/library-store.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-offline-metadata");

let baseUrl: string;
let stop: () => void;
let fixtureStop: () => void;
let lib: Library;

const get = (p: string) => fetch(`${baseUrl}${p}`);
const post = (p: string, body: unknown) =>
  fetch(`${baseUrl}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  const fixture = new FixtureBackend().serve();
  fixtureStop = fixture.stop;

  const settings = new SettingsStore(DATA_DIR);
  await settings.set("example", { baseUrl: fixture.url });
  const manager = new BridgeManager({ bridgesDir: BRIDGES_DIR, dataDir: DATA_DIR, settings });

  lib = new Library(new FileLibraryStore(join(DATA_DIR, "library")));
  const runtime = new ComicalRuntime({ bridges: manager, library: lib });
  const srv = Bun.serve({ port: 0, fetch: createRouter(manager, { library: lib, runtime }).fetch });
  baseUrl = `http://localhost:${srv.port}`;
  stop = () => srv.stop(true);
});

afterAll(() => {
  stop();
  fixtureStop(); // idempotent — some tests stop it themselves
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("offline metadata fallback", () => {
  test("library series stay renderable after the source goes away; non-library series keep erroring", async () => {
    // Add to library — addToLibrary captures the detail + seeds the chapter list.
    expect((await post("/library/entries", { bridgeId: "example", seriesId: "alice" })).status).toBe(201);

    // Live visits still work and (re)write the cache through.
    const liveDetail = (await (await get("/bridges/example/series/alice")).json()) as { title: string; cached?: boolean };
    expect(liveDetail.cached).toBeUndefined();
    const liveChapters = (await (await get("/bridges/example/series/alice/chapters")).json()) as Array<{ id: string }>;
    expect(liveChapters.length).toBeGreaterThan(0);

    // Source vanishes.
    fixtureStop();

    // Library entry: details come back from the cache, flagged; chapters keep their array shape.
    const cachedDetail = (await (await get("/bridges/example/series/alice")).json()) as {
      title: string; description?: string; cached?: boolean; cachedAt?: number;
    };
    expect(cachedDetail.cached).toBe(true);
    expect(cachedDetail.cachedAt).toBeGreaterThan(0);
    expect(cachedDetail.title.length).toBeGreaterThan(0);

    const cachedChaptersRes = await get("/bridges/example/series/alice/chapters");
    expect(cachedChaptersRes.status).toBe(200);
    const cachedChapters = (await cachedChaptersRes.json()) as Array<{ id: string; name?: string }>;
    expect(cachedChapters.map((c) => c.id)).toEqual(liveChapters.map((c) => c.id));

    // A series NOT in the library keeps the plain error.
    expect((await get("/bridges/example/series/bob")).ok).toBe(false);
  });

  test("a library entry survives its bridge being uninstalled entirely", async () => {
    // Seed cache docs for a bridge id that doesn't exist on this host — the "uninstalled" case,
    // where withContentBridge 404s before any bridge call.
    await lib.addSeries({ bridgeId: "ghost", seriesId: "g1", title: "Ghost Series" });
    await lib.cacheSeriesDetail("ghost:g1", { id: "g1", title: "Ghost Series", description: "Still here." });
    await lib.syncChapters("ghost:g1", [{ id: "c1", name: "Ch 1", number: 1 }]);

    const detail = (await (await get("/bridges/ghost/series/g1")).json()) as { description?: string; cached?: boolean };
    expect(detail.cached).toBe(true);
    expect(detail.description).toBe("Still here.");

    const chapters = (await (await get("/bridges/ghost/series/g1/chapters")).json()) as Array<{ id: string }>;
    expect(chapters.map((c) => c.id)).toEqual(["c1"]);

    // The unknown bridge still 404s for series with nothing cached.
    expect((await get("/bridges/ghost/series/other")).status).toBe(404);
  });
});

describe("absence: no library", () => {
  test("routes behave exactly as before when the library module isn't enabled", async () => {
    const manager = new BridgeManager({
      bridgesDir: BRIDGES_DIR,
      dataDir: DATA_DIR,
      settings: new SettingsStore(DATA_DIR),
    });
    fixtureStop(); // self-sufficient: don't depend on an earlier test having stopped the source
    const srv = Bun.serve({ port: 0, fetch: createRouter(manager).fetch });
    try {
      // Source is down — the details call fails plainly, no fallback exists.
      expect((await fetch(`http://localhost:${srv.port}/bridges/example/series/alice`)).ok).toBe(false);
      expect((await fetch(`http://localhost:${srv.port}/bridges/ghost/series/g1`)).status).toBe(404);
    } finally {
      srv.stop(true);
    }
  });
});
