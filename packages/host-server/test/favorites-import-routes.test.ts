/**
 * The favorites → library import routes: the read-only preview a client shows for confirmation, and
 * the POST that commits either the confirmed selection or (bodyless) everything. Also asserts both
 * are ABSENT when the router has no library wired in.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { entryKey, Library, InMemoryLibraryStore } from "@comical/library";
import { ComicalRuntime } from "@comical/runtime";
import { FixtureBackend } from "@comical/testkit";
import { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-favorites-import");

/** Fixture-catalog series ids, favorited on the backing account in `beforeAll`. */
const favoriteIds = ["alice", "sherlock", "frankenstein"];
let library: Library;
let baseUrl: string;
let noLibraryUrl: string;
let stop: () => void;

const get = (p: string) => fetch(`${baseUrl}${p}`);
const post = (p: string, body?: unknown) =>
  fetch(`${baseUrl}${p}`, {
    method: "POST",
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });

const PREVIEW = "/library/import/bridges/example/favorites/preview";
const IMPORT = "/library/import/bridges/example/favorites";

type Preview = {
  items: Array<{
    seriesId: string;
    title: string;
    status: "new" | "in-library" | "duplicate";
    matches?: Array<{ key: string; bridgeId: string; title: string }>;
  }>;
  truncated: boolean;
};

beforeAll(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  const fixture = new FixtureBackend().serve();

  const settings = new SettingsStore(DATA_DIR);
  await settings.set("example", { baseUrl: fixture.url, sessionToken: "test-token" });

  const manager = new BridgeManager({ bridgesDir: BRIDGES_DIR, dataDir: DATA_DIR, settings });
  // The store is swapped per test (see beforeEach), so the router holds a stable Library instance
  // over a store we can reset.
  library = new Library(new InMemoryLibraryStore());
  const runtime = new ComicalRuntime({ bridges: manager, library });
  const srv = Bun.serve({ port: 0, fetch: createRouter(manager, { library, runtime }).fetch });
  baseUrl = `http://localhost:${srv.port}`;

  const bare = Bun.serve({ port: 0, fetch: createRouter(manager).fetch });
  noLibraryUrl = `http://localhost:${bare.port}`;

  // Favorite three of the fixture's series on the backing "account" so there's something to import.
  for (const id of favoriteIds) {
    const res = await fetch(`${baseUrl}/bridges/example/favorites/${id}`, { method: "PUT" });
    if (!res.ok) throw new Error(`could not seed favorite ${id}: ${res.status}`);
  }

  stop = () => { srv.stop(true); bare.stop(true); fixture.stop(); };
});

afterAll(() => {
  stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// Every test starts from an empty library — the import routes write, so they can't share one.
beforeEach(() => {
  Reflect.set(library, "store", new InMemoryLibraryStore());
});

describe("GET …/favorites/preview", () => {
  test("classifies an untouched library as all-new and writes nothing", async () => {
    const res = await get(PREVIEW);
    expect(res.status).toBe(200);
    const preview = (await res.json()) as Preview;

    expect(preview.truncated).toBe(false);
    expect(preview.items.map((i) => i.seriesId).sort()).toEqual([...favoriteIds].sort());
    expect(preview.items.every((i) => i.status === "new")).toBe(true);
    expect(await library.getLibrary()).toHaveLength(0);
  });

  test("marks a favorite already added from this bridge as in-library", async () => {
    await library.addSeries({ bridgeId: "example", seriesId: favoriteIds[0]!, title: "whatever" });

    const preview = (await get(PREVIEW).then((r) => r.json())) as Preview;
    const item = preview.items.find((i) => i.seriesId === favoriteIds[0]);
    expect(item?.status).toBe("in-library");
  });

  test("marks a title held on another bridge as a duplicate, naming the match", async () => {
    const first = (await get(PREVIEW).then((r) => r.json())) as Preview;
    const title = first.items[0]!.title;
    await library.addSeries({ bridgeId: "other", seriesId: "x9", title: title.toUpperCase() });

    const preview = (await get(PREVIEW).then((r) => r.json())) as Preview;
    const item = preview.items.find((i) => i.seriesId === first.items[0]!.seriesId);
    expect(item?.status).toBe("duplicate");
    expect(item?.matches).toEqual([
      { key: entryKey("other", "x9"), bridgeId: "other", seriesId: "x9", title: title.toUpperCase() },
    ]);
  });

  test("400 for a bridge that does not support favorites", async () => {
    const res = await get("/library/import/bridges/test-sprites/favorites/preview");
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: "bridge does not support favorites" });
  });

  test("404 for an unknown bridge", async () => {
    expect((await get("/library/import/bridges/nope/favorites/preview")).status).toBe(404);
  });
});

describe("POST …/favorites", () => {
  test("with no body, imports every favorite", async () => {
    const res = await post(IMPORT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: favoriteIds.length, skipped: 0, linked: 0 });
    expect(await library.getLibrary()).toHaveLength(favoriteIds.length);
  });

  test("with an items body, imports exactly those", async () => {
    const preview = (await get(PREVIEW).then((r) => r.json())) as Preview;
    const chosen = preview.items.slice(0, 1);

    const result = await post(IMPORT, { items: chosen }).then((r) => r.json());
    expect(result).toEqual({ imported: 1, skipped: 0, linked: 0 });

    const entries = await library.getLibrary();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.seriesId).toBe(chosen[0]!.seriesId);
  });

  test("linkTo groups the import with the existing entry, which stays primary", async () => {
    const preview = (await get(PREVIEW).then((r) => r.json())) as Preview;
    const candidate = preview.items[0]!;
    await library.addSeries({ bridgeId: "other", seriesId: "x9", title: candidate.title });
    const existingKey = entryKey("other", "x9");

    const result = await post(IMPORT, {
      items: [{ seriesId: candidate.seriesId, title: candidate.title, linkTo: existingKey }],
    }).then((r) => r.json());
    expect(result).toEqual({ imported: 1, skipped: 0, linked: 1 });

    const groups = (await get("/library/groups").then((r) => r.json())) as Array<{
      primaryKey: string;
      memberKeys: string[];
    }>;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.primaryKey).toBe(existingKey);
    expect(groups[0]!.memberKeys).toContain(entryKey("example", candidate.seriesId));
  });

  test("an empty items array imports nothing — it is a selection, not an absent body", async () => {
    expect(await post(IMPORT, { items: [] }).then((r) => r.json())).toEqual({ imported: 0, skipped: 0, linked: 0 });
    expect(await library.getLibrary()).toHaveLength(0);
  });

  test("400 when items is not an array", async () => {
    const res = await post(IMPORT, { items: "everything" });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: "items must be an array" });
  });

  test("malformed entries in items are dropped rather than crashing the import", async () => {
    const preview = (await get(PREVIEW).then((r) => r.json())) as Preview;
    const good = preview.items[0]!;
    const result = await post(IMPORT, {
      items: [{ seriesId: good.seriesId, title: good.title }, { title: "no id" }, null],
    }).then((r) => r.json());
    expect(result).toEqual({ imported: 1, skipped: 0, linked: 0 });
  });

  test("400 for a bridge that does not support favorites", async () => {
    const res = await post("/library/import/bridges/test-sprites/favorites");
    expect(res.status).toBe(400);
  });
});

describe("without a library", () => {
  test("both routes are absent", async () => {
    expect((await fetch(`${noLibraryUrl}${PREVIEW}`)).status).toBe(404);
    expect((await fetch(`${noLibraryUrl}${IMPORT}`, { method: "POST" })).status).toBe(404);
  });
});
