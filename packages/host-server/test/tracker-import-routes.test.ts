/**
 * The tracker-list → library import routes: the read-only preview (the tracker's list classified
 * against the library), the per-bridge resolve (find each entry on a source), and the POST that
 * collects + links the confirmed selection. Also asserts all three are ABSENT when the router has no
 * tracker manager wired in.
 *
 * Real ComicalRuntime + Library over the fixture-backed `example` bridge; the trackers are a plain
 * object standing in for the TrackerManager (the router only calls `get`), same as the other
 * tracker route tests.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Tracker, TrackerLibraryEntry } from "@comical/contract";
import { entryKey, Library, InMemoryLibraryStore } from "@comical/library";
import { ComicalRuntime, MAX_TRACKER_IMPORT_BATCH, type TrackerProvider } from "@comical/runtime";
import { FixtureBackend } from "@comical/testkit";
import { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";
import type { TrackerManager } from "../src/tracker-manager.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-tracker-import");

const PREVIEW = "/library/import/trackers/anilist/preview";
const RESOLVE = "/library/import/trackers/anilist/resolve";
const IMPORT = "/library/import/trackers/anilist";

// Mutable list the mock "anilist" tracker's getLibrary reads from — tests reassign it per-case.
let anilistEntries: TrackerLibraryEntry[] = [];
const anilistUpdates: Array<{ externalId: string | number; chaptersRead?: number; status?: string }> = [];

const anilistTracker: Tracker = {
  info: { id: "anilist", name: "AniList", version: "0.0.0", contractVersion: "2.0.0", capabilities: ["library-sync", "status-sync"] },
  async getLibrary() {
    return { items: anilistEntries, page: 1, hasNextPage: false };
  },
  async updateEntry(externalId, update) {
    anilistUpdates.push({
      externalId,
      ...(update.chaptersRead !== undefined && { chaptersRead: update.chaptersRead }),
      ...(update.status !== undefined && { status: update.status }),
    });
  },
};

// No list to import from: exercises the capability error on preview.
const searchOnlyTracker: Tracker = {
  info: { id: "search-only", name: "Search only", version: "0.0.0", contractVersion: "2.0.0", capabilities: ["search"] },
};

const trackers: TrackerProvider = {
  get: async (id) => {
    if (id === "anilist") return anilistTracker;
    if (id === "search-only") return searchOnlyTracker;
    throw new Error(`tracker not found: ${id}`);
  },
  list: async () => [
    { info: { id: "anilist", capabilities: anilistTracker.info.capabilities } },
    { info: { id: "search-only", capabilities: searchOnlyTracker.info.capabilities } },
  ],
};

let library: Library;
let baseUrl: string;
let noTrackersUrl: string;
let stop: () => void;

const get = (p: string) => fetch(`${baseUrl}${p}`);
const send = (method: string, p: string, body?: unknown) =>
  fetch(`${baseUrl}${p}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
const post = (p: string, body?: unknown) => send("POST", p, body);

type Preview = {
  items: Array<{
    externalId: string | number;
    title: string;
    match: "linked" | "in-library" | "none";
    entries?: Array<{ key: string; bridgeId: string; seriesId: string; title: string; localRead: number }>;
  }>;
  truncated: boolean;
};
type Resolved = Array<{
  externalId: string | number;
  exact?: { id: string; title: string };
  candidates: Array<{ id: string; title: string }>;
  error?: string;
}>;
type ImportResult = {
  imported: number;
  linked: number;
  seeded: number;
  pushed: number;
  failed: Array<{ externalId: string | number; bridgeId: string; seriesId: string; error: string }>;
};

/** Resolve a single entry on the `example` bridge and return its result row. */
const resolveOne = async (entry: Record<string, unknown>): Promise<Resolved[number]> => {
  const res = await post(RESOLVE, { bridgeId: "example", entries: [entry] });
  expect(res.status).toBe(200);
  return ((await res.json()) as Resolved)[0]!;
};

const item = (overrides: Record<string, unknown>) => ({
  externalId: 1,
  title: "Frankenstein",
  status: "reading",
  bridgeId: "example",
  seriesId: "frankenstein",
  ...overrides,
});

beforeAll(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  const fixture = new FixtureBackend().serve();

  const settings = new SettingsStore(DATA_DIR);
  await settings.set("example", { baseUrl: fixture.url });

  const manager = new BridgeManager({ bridgesDir: BRIDGES_DIR, dataDir: DATA_DIR, settings });
  // The store is swapped per test (see beforeEach), so the router holds a stable Library instance
  // over a store we can reset.
  library = new Library(new InMemoryLibraryStore());
  const runtime = new ComicalRuntime({ bridges: manager, library, trackers });
  const srv = Bun.serve({
    port: 0,
    fetch: createRouter(manager, { library, runtime, trackers: trackers as unknown as TrackerManager }).fetch,
  });
  baseUrl = `http://localhost:${srv.port}`;

  const bare = Bun.serve({ port: 0, fetch: createRouter(manager, { library, runtime }).fetch });
  noTrackersUrl = `http://localhost:${bare.port}`;

  stop = () => { srv.stop(true); bare.stop(true); fixture.stop(); };
});

afterAll(() => {
  stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// Every test starts from an empty library — the import route writes, so they can't share one.
beforeEach(() => {
  Reflect.set(library, "store", new InMemoryLibraryStore());
  anilistEntries = [
    { externalId: 1, title: "Frankenstein", status: "reading", chaptersRead: 1 },
    { externalId: 2, title: "Dracula", status: "planning" },
  ];
  anilistUpdates.length = 0;
});

describe("GET …/trackers/:id/preview", () => {
  test("classifies every entry as none against an empty library and writes nothing", async () => {
    const res = await get(PREVIEW);
    expect(res.status).toBe(200);
    const preview = (await res.json()) as Preview;

    expect(preview.truncated).toBe(false);
    expect(preview.items.map((i) => [i.externalId, i.match])).toEqual([[1, "none"], [2, "none"]]);
    expect(await library.getLibrary()).toHaveLength(0);
  });

  test("marks an entry whose title the library holds as in-library, naming the series", async () => {
    await library.collectSeries({ bridgeId: "example", seriesId: "frankenstein" }, { seriesTitle: "FRANKENSTEIN!" });

    const preview = (await get(PREVIEW).then((r) => r.json())) as Preview;
    expect(preview.items.find((i) => i.externalId === 1)).toMatchObject({
      match: "in-library",
      entries: [{ key: entryKey("example", "frankenstein"), bridgeId: "example", seriesId: "frankenstein", title: "FRANKENSTEIN!", localRead: 0 }],
    });
  });

  test("marks an entry already linked to this tracker as linked", async () => {
    await library.collectSeries({ bridgeId: "example", seriesId: "frankenstein" }, { seriesTitle: "Frankenstein" });
    await library.linkTracker(entryKey("example", "frankenstein"), "anilist", 1);

    const preview = (await get(PREVIEW).then((r) => r.json())) as Preview;
    expect(preview.items.find((i) => i.externalId === 1)?.match).toBe("linked");
  });

  test("400 for a tracker that has no list to import", async () => {
    const res = await get("/library/import/trackers/search-only/preview");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/library-sync/);
  });

  test("404 for an unknown tracker", async () => {
    expect((await get("/library/import/trackers/nope/preview")).status).toBe(404);
  });
});

describe("POST …/trackers/:id/resolve", () => {
  test("finds an entry whose title the bridge lists as an exact match", async () => {
    const res = await post(RESOLVE, { bridgeId: "example", entries: [{ externalId: 1, title: "frankenstein" }] });
    expect(res.status).toBe(200);
    const r = ((await res.json()) as Resolved)[0]!;
    expect(r).toMatchObject({ externalId: 1, exact: { id: "frankenstein" }, candidates: [] });
  });

  test("accepts the top hit when its alternate titles carry the tracker's name", async () => {
    const r = await resolveOne({ externalId: 7, title: "Odyssey", altTitles: ["Odysseia"] });
    expect(r.exact?.id).toBe("odyssey");
  });

  test("offers candidates to choose between when nothing matches exactly", async () => {
    const r = await resolveOne({ externalId: 8, title: "Adventures" });
    expect(r.exact).toBeUndefined();
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.length).toBeLessThanOrEqual(3);
  });

  test("an entry the bridge does not have resolves to nothing, not an error", async () => {
    const r = await resolveOne({ externalId: 9, title: "Zzyzx Chronicles" });
    expect(r).toEqual({ externalId: 9, candidates: [] });
  });

  test("400 without a bridgeId", async () => {
    expect((await post(RESOLVE, { entries: [{ externalId: 1, title: "x" }] })).status).toBe(400);
  });

  test("400 for an empty or oversized batch", async () => {
    expect((await post(RESOLVE, { bridgeId: "example", entries: [] })).status).toBe(400);
    const entries = Array.from({ length: MAX_TRACKER_IMPORT_BATCH + 1 }, (_, i) => ({ externalId: i + 1, title: "x" }));
    expect((await post(RESOLVE, { bridgeId: "example", entries })).status).toBe(400);
  });

  test("400 for a body that is not JSON", async () => {
    const res = await fetch(`${baseUrl}${RESOLVE}`, { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
  });

  test("404 for an unknown tracker", async () => {
    const res = await post("/library/import/trackers/nope/resolve", { bridgeId: "example", entries: [{ externalId: 1, title: "x" }] });
    expect(res.status).toBe(404);
  });

  test("404 for an unknown bridge", async () => {
    const res = await post(RESOLVE, { bridgeId: "nope", entries: [{ externalId: 1, title: "x" }] });
    expect(res.status).toBe(404);
  });
});

describe("POST …/trackers/:id", () => {
  test("collects a new series, links it, and seeds its progress from the tracker", async () => {
    const res = await post(IMPORT, { items: [item({ chaptersRead: 1 })], seedProgress: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: 1, linked: 1, seeded: 1, pushed: 0, failed: [] });

    const key = entryKey("example", "frankenstein");
    expect(await library.getSeries(key)).toMatchObject({ seriesTitle: "Frankenstein" });
    expect(await library.getTrackerLink(key, "anilist")).toMatchObject({ externalId: 1, status: "reading", chaptersRead: 1 });
    const progress = (await get("/library/collected/series/example/frankenstein/progress").then((r) => r.json())) as Array<{ read: boolean }>;
    expect(progress.filter((p) => p.read)).toHaveLength(1);
    expect(anilistUpdates).toEqual([]);
  });

  test("with seeding off, the new series is linked but nothing is marked read", async () => {
    const result = (await post(IMPORT, { items: [item({ chaptersRead: 1 })], seedProgress: false }).then((r) => r.json())) as ImportResult;
    expect(result).toMatchObject({ imported: 1, linked: 1, seeded: 0 });

    const progress = (await get("/library/collected/series/example/frankenstein/progress").then((r) => r.json())) as Array<{ read: boolean }>;
    expect(progress.filter((p) => p.read)).toEqual([]);
  });

  test("files a new series into the given collections", async () => {
    const collection = await library.createCollection("Imported");
    await post(IMPORT, { items: [item({})], collectionIds: [collection.id], seedProgress: true });

    const entry = await library.getSeries(entryKey("example", "frankenstein"));
    expect(entry?.collectionIds).toEqual([collection.id]);
  });

  test("a series already in the library keeps its progress and pushes it when ahead", async () => {
    await send("PUT", "/library/collected/series/example/sherlock", { seriesTitle: "The Adventures of Sherlock Holmes" });
    await send("PUT", "/library/collected/series/example/sherlock/progress/sherlock-3", { read: true, chapterName: "Ch 3", number: 3 });

    const result = (await post(IMPORT, {
      items: [item({ externalId: 5, title: "The Adventures of Sherlock Holmes", seriesId: "sherlock", chaptersRead: 1 })],
      seedProgress: true,
    }).then((r) => r.json())) as ImportResult;
    expect(result).toEqual({ imported: 0, linked: 1, seeded: 0, pushed: 1, failed: [] });
    expect(anilistUpdates).toEqual([{ externalId: 5, chaptersRead: 3 }]);
  });

  test("a series already in the library and behind the tracker is linked, never marked", async () => {
    await send("PUT", "/library/collected/series/example/sherlock", { seriesTitle: "The Adventures of Sherlock Holmes" });

    const result = (await post(IMPORT, {
      items: [item({ externalId: 5, title: "The Adventures of Sherlock Holmes", seriesId: "sherlock", chaptersRead: 3 })],
      seedProgress: true,
    }).then((r) => r.json())) as ImportResult;
    expect(result).toEqual({ imported: 0, linked: 1, seeded: 0, pushed: 0, failed: [] });

    const progress = (await get("/library/collected/series/example/sherlock/progress").then((r) => r.json())) as Array<{ read: boolean }>;
    expect(progress.filter((p) => p.read)).toEqual([]);
    expect(await library.getTrackerLink(entryKey("example", "sherlock"), "anilist")).toMatchObject({ externalId: 5, chaptersRead: 3 });
    expect(anilistUpdates).toEqual([]);
  });

  test("an item whose details cannot be fetched is still collected under the tracker's title", async () => {
    const result = (await post(IMPORT, {
      items: [item({ externalId: 2, title: "Ghost", seriesId: "no-such-series" })],
      seedProgress: true,
    }).then((r) => r.json())) as ImportResult;
    expect(result).toMatchObject({ imported: 1, linked: 1, failed: [] });
    expect(await library.getSeries(entryKey("example", "no-such-series"))).toMatchObject({ seriesTitle: "Ghost" });
  });

  test("an item on an unknown bridge is reported in failed without stopping the batch", async () => {
    const result = (await post(IMPORT, {
      items: [item({}), item({ externalId: 2, title: "Dracula", bridgeId: "nope", seriesId: "dracula" })],
      seedProgress: true,
    }).then((r) => r.json())) as ImportResult;
    expect(result.imported).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ externalId: 2, bridgeId: "nope", seriesId: "dracula" });
    expect(await library.getSeries(entryKey("example", "frankenstein"))).toBeDefined();
  });

  test("400 for an invalid status, a missing seedProgress, or an oversized batch", async () => {
    expect((await post(IMPORT, { items: [item({ status: "bogus" })], seedProgress: true })).status).toBe(400);
    expect((await post(IMPORT, { items: [item({})] })).status).toBe(400);
    const items = Array.from({ length: MAX_TRACKER_IMPORT_BATCH + 1 }, (_, i) => item({ externalId: i + 1 }));
    expect((await post(IMPORT, { items, seedProgress: true })).status).toBe(400);
  });

  test("404 for an unknown tracker", async () => {
    expect((await post("/library/import/trackers/nope", { items: [item({})], seedProgress: true })).status).toBe(404);
  });
});

describe("without a tracker manager", () => {
  test("all three routes are absent", async () => {
    expect((await fetch(`${noTrackersUrl}${PREVIEW}`)).status).toBe(404);
    expect((await fetch(`${noTrackersUrl}${RESOLVE}`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${noTrackersUrl}${IMPORT}`, { method: "POST" })).status).toBe(404);
  });
});
