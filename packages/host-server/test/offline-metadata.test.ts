/**
 * Offline library metadata: the series-details and chapters routes fall back to the library's
 * metadata cache when the bridge can't answer (source down, bridge uninstalled), and successful
 * live responses write through to it. Non-library series keep their exact error behavior.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Library } from "@comical/library";
import { ComicalRuntime } from "@comical/runtime";
import { FixtureBackend } from "@comical/testkit";
import { BridgeManager } from "../src/bridge-manager.ts";
import { FileBlobStore } from "../src/blob-store.ts";
import { FileLibraryStore } from "../src/library-store.ts";
import { createServerPageFetcher } from "../src/page-fetcher.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-offline-metadata");

let baseUrl: string;
let fixtureUrl: string;
let stop: () => void;
let fixtureStop: () => void;
let lib: Library;
const COVERS_DIR = join(DATA_DIR, "library", "covers");

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

  fixtureUrl = fixture.url;
  lib = new Library(new FileLibraryStore(join(DATA_DIR, "library")));
  const runtime = new ComicalRuntime({ bridges: manager, library: lib });
  let routerFetch: (req: Request) => Response | Promise<Response> = () => new Response(null, { status: 503 });
  const covers = { blobs: new FileBlobStore(COVERS_DIR), fetchPage: createServerPageFetcher(() => routerFetch) };
  const router = createRouter(manager, { library: lib, runtime, covers });
  routerFetch = (req) => router.fetch(req);
  const srv = Bun.serve({ port: 0, fetch: router.fetch });
  baseUrl = `http://localhost:${srv.port}`;
  stop = () => srv.stop(true);
});

afterAll(() => {
  stop();
  fixtureStop(); // idempotent — some tests stop it themselves
  rmSync(DATA_DIR, { recursive: true, force: true });
});

/** Poll until `probe` returns ok (fire-and-forget captures land asynchronously). */
async function waitForOk(probe: () => Promise<Response>, timeoutMs = 5_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await probe();
    if (res.ok || Date.now() > deadline) return res;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("cover bytes", () => {
  test("captured on library-add, served back, removed with the entry", async () => {
    const res = await post("/library/entries", {
      bridgeId: "example",
      seriesId: "sherlock",
      title: "Sherlock",
      thumbnailUrl: `${fixtureUrl}/img/sherlock-cover.png`,
    });
    expect(res.status).toBe(201);

    // Capture is fire-and-forget — poll the cover route until the bytes land.
    const cover = await waitForOk(() => get("/library/entries/example/sherlock/cover"));
    expect(cover.ok).toBe(true);
    expect(cover.headers.get("Content-Type")).toBe("image/png");
    expect((await cover.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(existsSync(join(COVERS_DIR, "example"))).toBe(true);

    // Removing the entry unlinks the blob and the route 404s again.
    await fetch(`${baseUrl}/library/entries/example/sherlock`, { method: "DELETE" });
    expect((await get("/library/entries/example/sherlock/cover")).status).toBe(404);
    expect(existsSync(join(COVERS_DIR, "example", "sherlock.png"))).toBe(false);
  });

  test("a changed cover URL re-captures; an unchanged one doesn't", async () => {
    const key = "example:moby-dick";
    const urlA = `${fixtureUrl}/img/moby-cover-a.png`;
    const urlB = `${fixtureUrl}/img/moby-cover-b.png`;

    await post("/library/entries", { bridgeId: "example", seriesId: "moby-dick", title: "Moby-Dick", thumbnailUrl: urlA });
    await waitForOk(() => get("/library/entries/example/moby-dick/cover"));
    expect((await lib.getCachedDetail(key))?.coverSourceUrl).toBe(urlA);

    // The source changed its cover art (surfacing here as a refreshed snapshot thumbnail) — the
    // next capture trigger sees the mismatch and re-captures from the new URL.
    await post("/library/entries", { bridgeId: "example", seriesId: "moby-dick", title: "Moby-Dick", thumbnailUrl: urlB });
    const deadline = Date.now() + 5_000;
    while ((await lib.getCachedDetail(key))?.coverSourceUrl !== urlB && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await lib.getCachedDetail(key))?.coverSourceUrl).toBe(urlB);
    expect((await get("/library/entries/example/moby-dick/cover")).ok).toBe(true);

    await fetch(`${baseUrl}/library/entries/example/moby-dick`, { method: "DELETE" });
  });
});

describe("entry snapshot reconciliation", () => {
  test("browsing heals a stale library snapshot from the live info", async () => {
    // A covers-less router so the background capture never fires at the fixture's external cover URLs.
    const manager = new BridgeManager({
      bridgesDir: BRIDGES_DIR,
      dataDir: DATA_DIR,
      settings: new SettingsStore(DATA_DIR),
    });
    const lib2 = new Library(new FileLibraryStore(join(DATA_DIR, "library-reconcile")));
    const runtime = new ComicalRuntime({ bridges: manager, library: lib2 });
    const srv = Bun.serve({ port: 0, fetch: createRouter(manager, { library: lib2, runtime }).fetch });
    const base = `http://localhost:${srv.port}`;
    try {
      // Seed a deliberately stale snapshot (wrong title/author).
      await lib2.addSeries({ bridgeId: "example", seriesId: "dracula", title: "Wrong Old Title", author: "Nobody" });

      // A live series-page visit write-throughs the fresh info and reconciles the snapshot.
      expect((await fetch(`${base}/bridges/example/series/dracula`)).ok).toBe(true);
      const deadline = Date.now() + 5_000;
      while ((await lib2.getEntry("example:dracula"))?.title !== "Dracula" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const entry = await lib2.getEntry("example:dracula");
      expect(entry?.title).toBe("Dracula");
      expect(entry?.author).toBe("Bram Stoker");
    } finally {
      srv.stop(true);
    }
  });
});

describe("offline metadata fallback", () => {
  test("library series stay renderable after the source goes away; non-library series keep erroring", async () => {
    // Add to library — addToLibrary captures the detail + seeds the chapter list, and the cover
    // (supplied here as a fixture-local URL so no test traffic leaves the machine) is captured too.
    expect(
      (
        await post("/library/entries", {
          bridgeId: "example",
          seriesId: "alice",
          title: "Alice's Adventures in Wonderland",
          thumbnailUrl: `${fixtureUrl}/img/alice-cover.png`,
        })
      ).status,
    ).toBe(201);
    await waitForOk(() => get("/library/entries/example/alice/cover"));

    // Live visits still work and (re)write the cache through.
    const liveDetail = (await (await get("/bridges/example/series/alice")).json()) as { title: string; cached?: boolean };
    expect(liveDetail.cached).toBeUndefined();
    const liveChapters = (await (await get("/bridges/example/series/alice/chapters")).json()) as Array<{ id: string }>;
    expect(liveChapters.length).toBeGreaterThan(0);

    // Source vanishes.
    fixtureStop();

    // Library entry: details come back from the cache, flagged; chapters keep their array shape.
    const cachedDetail = (await (await get("/bridges/example/series/alice")).json()) as {
      title: string; description?: string; cached?: boolean; cachedAt?: number; thumbnailUrl?: string;
    };
    expect(cachedDetail.cached).toBe(true);
    expect(cachedDetail.cachedAt).toBeGreaterThan(0);
    expect(cachedDetail.title.length).toBeGreaterThan(0);
    // The captured cover replaces the (now unreachable) live thumbnail with this host's own route,
    // which still serves the bytes from disk with the source down.
    expect(cachedDetail.thumbnailUrl).toBe("/library/entries/example/alice/cover");
    expect((await get("/library/entries/example/alice/cover")).ok).toBe(true);

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
