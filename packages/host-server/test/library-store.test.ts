/**
 * FileLibraryStore persistence + the one-time "categories → lists" entry migration: a legacy
 * `entries.json` (carrying `categoryIds`, no `listIds`) is healed on first read and rewritten.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    await store.putFavoritePage(page({ chapterName: "Ch 1", pageCount: 20 }));
    await store.putFavoritePage(page({ id: "demo:s1:c1:4", pageIndex: 4, thumbFile: "demo/s1/c1/4.png", hasThumb: true }));

    // A second store over the same dir reads only what was written — no shared in-memory cache.
    const reopened = new FileLibraryStore(LIB);
    const got = (await reopened.listFavoritePages()).sort((a, b) => a.pageIndex - b.pageIndex);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ id: "demo:s1:c1:0", chapterName: "Ch 1", pageCount: 20 });
    expect(got[1]).toMatchObject({ pageIndex: 4, thumbFile: "demo/s1/c1/4.png", hasThumb: true });
  });

  test("putFavoritePage is an upsert on the derived id, and delete removes just that one", async () => {
    const store = new FileLibraryStore(LIB);
    await store.putFavoritePage(page({ seriesTitle: "First" }));
    await store.putFavoritePage(page({ seriesTitle: "Second" }));
    expect(await store.listFavoritePages()).toHaveLength(1);
    expect((await store.listFavoritePages())[0]!.seriesTitle).toBe("Second");

    await store.putFavoritePage(page({ id: "demo:s1:c1:1", pageIndex: 1 }));
    await store.deleteFavoritePage("demo:s1:c1:0");
    expect((await new FileLibraryStore(LIB).listFavoritePages()).map((p) => p.id)).toEqual(["demo:s1:c1:1"]);
  });

  test("deleting an unknown favorite is a no-op", async () => {
    const store = new FileLibraryStore(LIB);
    await store.deleteFavoritePage("nope:nope:nope:0");
    expect(await store.listFavoritePages()).toEqual([]);
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

  test("diskUsage counts favorite documents but skips the blob subdirs", async () => {
    const store = new FileLibraryStore(LIB);
    await store.putFavoritePage(page());
    const docsOnly = await store.diskUsage();
    expect(docsOnly).toBeGreaterThan(0);

    // Both blob roots report their own usage via their BlobStore; counting them here would make
    // /library/usage double them.
    for (const sub of ["covers", "favorite-thumbs"]) {
      mkdirSync(join(LIB, sub), { recursive: true });
      writeFileSync(join(LIB, sub, "blob.bin"), Buffer.alloc(4096));
    }
    expect(await store.diskUsage()).toBe(docsOnly);
  });
});
