/**
 * FileLibraryStore persistence + the one-time "categories → lists" entry migration: a legacy
 * `entries.json` (carrying `categoryIds`, no `listIds`) is healed on first read and rewritten.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { FavoriteCollection, FavoritePage } from "@comical/library";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FileLibraryStore } from "../src/library-store.ts";

const DIR = join(import.meta.dir, ".tmp-library-store");
const LIB = join(DIR, "library");

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(LIB, { recursive: true });
});
afterEach(() => rmSync(DIR, { recursive: true, force: true }));

describe("FileLibraryStore legacy migration", () => {
  test("entries with categoryIds and no listIds are healed and persisted on first read", async () => {
    // Seed a pre-rename file by hand: the field is `categoryIds`, `listIds` is absent.
    const legacy = {
      "demo:s1": {
        bridgeId: "demo", seriesId: "s1", title: "Legacy One",
        categoryIds: ["old-cat-id"], addedAt: 1, updatedAt: 1,
      },
    };
    writeFileSync(join(LIB, "entries.json"), JSON.stringify(legacy), "utf8");

    const store = new FileLibraryStore(LIB);
    const [entry] = await store.listEntries();

    // In memory: listIds defaulted to [] (membership dropped), categoryIds gone.
    expect(entry!.listIds).toEqual([]);
    expect("categoryIds" in entry!).toBe(false);

    // On disk: the file was rewritten so the migration runs exactly once.
    const onDisk = JSON.parse(readFileSync(join(LIB, "entries.json"), "utf8")) as Record<string, Record<string, unknown>>;
    expect(onDisk["demo:s1"]!.listIds).toEqual([]);
    expect("categoryIds" in onDisk["demo:s1"]!).toBe(false);
  });

  test("a clean entry (already has listIds) is left untouched, no rewrite needed", async () => {
    const clean = {
      "demo:s1": { bridgeId: "demo", seriesId: "s1", title: "Clean", listIds: ["keep"], addedAt: 1, updatedAt: 1 },
    };
    const raw = JSON.stringify(clean);
    writeFileSync(join(LIB, "entries.json"), raw, "utf8");

    const store = new FileLibraryStore(LIB);
    const [entry] = await store.listEntries();
    expect(entry!.listIds).toEqual(["keep"]);
    // Untouched: no migration flush reformatted the file.
    expect(readFileSync(join(LIB, "entries.json"), "utf8")).toBe(raw);
  });
});

describe("FileLibraryStore page favorites", () => {
  const page = (over: Partial<FavoritePage> = {}): FavoritePage => ({
    id: "demo:s1:c1:0",
    bridgeId: "demo",
    seriesId: "s1",
    chapterId: "c1",
    pageIndex: 0,
    favoritedAt: 1_700_000_000_000,
    collectionIds: [],
    seriesTitle: "Series One",
    ...over,
  });

  test("favorites round-trip through a real dir and survive a reopen", async () => {
    const store = new FileLibraryStore(LIB);
    await store.putFavoritePages([
      page({ chapterName: "Ch 1", pageCount: 20 }),
      page({ id: "demo:s1:c1:4", pageIndex: 4, sourceUrl: "https://cdn/4.png", stale: true }),
    ]);

    // A second store over the same dir reads only what was written — no shared in-memory cache.
    const reopened = new FileLibraryStore(LIB);
    const got = (await reopened.listFavoritePages()).sort((a, b) => a.pageIndex - b.pageIndex);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ id: "demo:s1:c1:0", chapterName: "Ch 1", pageCount: 20 });
    expect(got[1]).toMatchObject({ pageIndex: 4, sourceUrl: "https://cdn/4.png", stale: true });
  });

  test("putFavoritePage is an upsert on the derived id, and delete removes just that one", async () => {
    const store = new FileLibraryStore(LIB);
    await store.putFavoritePages([page({ seriesTitle: "First" })]);
    await store.putFavoritePages([page({ seriesTitle: "Second" })]);
    expect(await store.listFavoritePages()).toHaveLength(1);
    expect((await store.listFavoritePages())[0]!.seriesTitle).toBe("Second");

    await store.putFavoritePages([page({ id: "demo:s1:c1:1", pageIndex: 1 })]);
    await store.deleteFavoritePages(["demo:s1:c1:0"]);
    expect((await new FileLibraryStore(LIB).listFavoritePages()).map((p) => p.id)).toEqual(["demo:s1:c1:1"]);
  });

  test("deleting an unknown favorite is a no-op", async () => {
    const store = new FileLibraryStore(LIB);
    await store.deleteFavoritePages(["nope:nope:nope:0"]);
    expect(await store.listFavoritePages()).toEqual([]);
  });

  test("favorites are sharded per series, and a write touches only its own shard", async () => {
    const store = new FileLibraryStore(LIB);
    await store.putFavoritePages([page(), page({ id: "demo:s2:c1:0", seriesId: "s2" })]);

    const shardDir = join(LIB, "favorite-pages");
    expect(readdirSync(shardDir).sort()).toEqual(["demo%3As1.json", "demo%3As2.json"]);

    // Writing into one series must leave the other series' document byte-identical: that is what
    // keeps a chapter open from re-serializing every favorite the user has.
    const otherBefore = readFileSync(join(shardDir, "demo%3As2.json"), "utf8");
    await store.putFavoritePages([page({ id: "demo:s1:c9:3", chapterId: "c9", pageIndex: 3 })]);
    expect(readFileSync(join(shardDir, "demo%3As2.json"), "utf8")).toBe(otherBefore);

    // Emptying a series drops its document rather than leaving an empty one behind.
    await store.deleteFavoritePages(["demo:s2:c1:0"]);
    expect(readdirSync(shardDir)).toEqual(["demo%3As1.json"]);
  });

  test("an unscoped listing spans every shard, after a reopen", async () => {
    const store = new FileLibraryStore(LIB);
    await store.putFavoritePages([
      page(),
      page({ id: "demo:s2:c1:0", seriesId: "s2" }),
      page({ id: "other:s1:c1:0", bridgeId: "other" }),
    ]);
    // A fresh store has no cache — it must find the shards on disk.
    expect((await new FileLibraryStore(LIB).listFavoritePages()).map((p) => p.id).sort()).toEqual([
      "demo:s1:c1:0",
      "demo:s2:c1:0",
      "other:s1:c1:0",
    ]);
  });

  test("getFavoritePage is a keyed lookup, and scoped listing honours the scope", async () => {
    const store = new FileLibraryStore(LIB);
    await store.putFavoritePages([
      page(),
      page({ id: "demo:s1:c2:0", chapterId: "c2" }),
      page({ id: "demo:s2:c1:0", seriesId: "s2" }),
      page({ id: "other:s1:c1:0", bridgeId: "other" }),
    ]);

    const reopened = new FileLibraryStore(LIB);
    expect((await reopened.getFavoritePage("demo:s1:c2:0"))?.chapterId).toBe("c2");
    expect(await reopened.getFavoritePage("nope")).toBeUndefined();

    // Scoping is what keeps a chapter open off the whole-library path.
    expect(await reopened.listFavoritePages({ bridgeId: "demo", seriesId: "s1", chapterId: "c1" })).toHaveLength(1);
    expect(await reopened.listFavoritePages({ bridgeId: "demo", seriesId: "s1" })).toHaveLength(2);
    expect(await reopened.listFavoritePages({ bridgeId: "demo" })).toHaveLength(3);
    expect(await reopened.listFavoritePages()).toHaveLength(4);
  });

  test("collections are stored as one ordered document", async () => {
    const store = new FileLibraryStore(LIB);
    const collections: FavoriteCollection[] = [
      { id: "a", name: "Panels", order: 0 },
      { id: "b", name: "Splashes", order: 1 },
    ];
    await store.putFavoriteCollections(collections);
    expect(await new FileLibraryStore(LIB).listFavoriteCollections()).toEqual(collections);

    // A whole-document write is how a reorder or a cascading delete lands atomically.
    await store.putFavoriteCollections([{ id: "b", name: "Splashes", order: 0 }]);
    expect(await new FileLibraryStore(LIB).listFavoriteCollections()).toEqual([
      { id: "b", name: "Splashes", order: 0 },
    ]);
  });

  test("listFavoriteCollections hands back a copy — mutating it can't corrupt the cache", async () => {
    const store = new FileLibraryStore(LIB);
    await store.putFavoriteCollections([{ id: "a", name: "Panels", order: 0 }]);
    (await store.listFavoriteCollections()).push({ id: "evil", name: "Injected", order: 9 });
    expect(await store.listFavoriteCollections()).toHaveLength(1);
  });

  test("diskUsage counts favorite documents but still skips the covers blob root", async () => {
    const store = new FileLibraryStore(LIB);
    await store.putFavoritePages([page()]);
    const docsOnly = await store.diskUsage();
    expect(docsOnly).toBeGreaterThan(0);

    // The covers BlobStore reports its own usage; counting it here would make /library/usage
    // double it. Favorites store no bytes at all, so they add nothing beyond their JSON document.
    mkdirSync(join(LIB, "covers"), { recursive: true });
    writeFileSync(join(LIB, "covers", "blob.bin"), Buffer.alloc(4096));
    expect(await store.diskUsage()).toBe(docsOnly);
  });
});
