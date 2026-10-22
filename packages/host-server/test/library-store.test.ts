/**
 * FileLibraryStore persistence for favorites: per-series shards, keyed lookups, batched writes.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Collection, CollectionPageItem } from "@comical/library";
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

describe("FileLibraryStore favorites", () => {
  const page = (over: Partial<CollectionPageItem> = {}): CollectionPageItem => ({
    type: "page",
    id: "page:demo:s1:c1:0",
    bridgeId: "demo",
    seriesId: "s1",
    chapterId: "c1",
    pageIndex: 0,
    collectedAt: 1_700_000_000_000,
    collectionIds: [],
    seriesTitle: "Series One",
    ...over,
  });

  test("favorites round-trip through a real dir and survive a reopen", async () => {
    const store = new FileLibraryStore(LIB);
    await store.putCollectionItems([
      page({ chapterName: "Ch 1", pageCount: 20 }),
      page({ id: "page:demo:s1:c1:4", pageIndex: 4, sourceUrl: "https://cdn/4.png", stale: true }),
    ]);

    // A second store over the same dir reads only what was written — no shared in-memory cache.
    const reopened = new FileLibraryStore(LIB);
    const got = (await reopened.listCollectionItems({ type: "page" }))
      .filter((i): i is CollectionPageItem => i.type === "page")
      .sort((a, b) => a.pageIndex - b.pageIndex);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ id: "page:demo:s1:c1:0", chapterName: "Ch 1", pageCount: 20 });
    expect(got[1]).toMatchObject({ pageIndex: 4, sourceUrl: "https://cdn/4.png", stale: true });
  });

  test("putFavoritePage is an upsert on the derived id, and delete removes just that one", async () => {
    const store = new FileLibraryStore(LIB);
    await store.putCollectionItems([page({ seriesTitle: "First" })]);
    await store.putCollectionItems([page({ seriesTitle: "Second" })]);
    expect(await store.listCollectionItems()).toHaveLength(1);
    expect((await store.listCollectionItems())[0]!.seriesTitle).toBe("Second");

    await store.putCollectionItems([page({ id: "page:demo:s1:c1:1", pageIndex: 1 })]);
    await store.deleteCollectionItems(["page:demo:s1:c1:0"]);
    expect((await new FileLibraryStore(LIB).listCollectionItems()).map((p) => p.id)).toEqual(["page:demo:s1:c1:1"]);
  });

  test("deleting an unknown favorite is a no-op", async () => {
    const store = new FileLibraryStore(LIB);
    await store.deleteCollectionItems(["page:nope:nope:nope:0"]);
    expect(await store.listCollectionItems()).toEqual([]);
  });

  test("items are sharded per series, and a write touches only its own shard", async () => {
    const store = new FileLibraryStore(LIB);
    await store.putCollectionItems([page(), page({ id: "page:demo:s2:c1:0", seriesId: "s2" })]);

    const shardDir = join(LIB, "collection-items");
    expect(readdirSync(shardDir).sort()).toEqual(["demo%3As1.json", "demo%3As2.json"]);

    // Writing into one series must leave the other series' document byte-identical: that is what
    // keeps a chapter open from re-serializing every favorite the user has.
    const otherBefore = readFileSync(join(shardDir, "demo%3As2.json"), "utf8");
    await store.putCollectionItems([page({ id: "page:demo:s1:c9:3", chapterId: "c9", pageIndex: 3 })]);
    expect(readFileSync(join(shardDir, "demo%3As2.json"), "utf8")).toBe(otherBefore);

    // Emptying a series drops its document rather than leaving an empty one behind.
    await store.deleteCollectionItems(["page:demo:s2:c1:0"]);
    expect(readdirSync(shardDir)).toEqual(["demo%3As1.json"]);
  });

  test("an unscoped listing spans every shard, after a reopen", async () => {
    const store = new FileLibraryStore(LIB);
    await store.putCollectionItems([
      page(),
      page({ id: "page:demo:s2:c1:0", seriesId: "s2" }),
      page({ id: "page:other:s1:c1:0", bridgeId: "other" }),
    ]);
    // A fresh store has no cache — it must find the shards on disk.
    expect((await new FileLibraryStore(LIB).listCollectionItems()).map((p) => p.id).sort()).toEqual([
      "page:demo:s1:c1:0",
      "page:demo:s2:c1:0",
      "page:other:s1:c1:0",
    ]);
  });

  test("getFavoritePage is a keyed lookup, and scoped listing honours the scope", async () => {
    const store = new FileLibraryStore(LIB);
    await store.putCollectionItems([
      page(),
      page({ id: "page:demo:s1:c2:0", chapterId: "c2" }),
      page({ id: "page:demo:s2:c1:0", seriesId: "s2" }),
      page({ id: "page:other:s1:c1:0", bridgeId: "other" }),
    ]);

    const reopened = new FileLibraryStore(LIB);
    const fetched = await reopened.getCollectionItem("page:demo:s1:c2:0");
    expect(fetched?.type === "page" ? fetched.chapterId : undefined).toBe("c2");
    expect(await reopened.getCollectionItem("nope")).toBeUndefined();

    // Scoping is what keeps a chapter open off the whole-library path.
    expect(await reopened.listCollectionItems({ bridgeId: "demo", seriesId: "s1", chapterId: "c1" })).toHaveLength(1);
    expect(await reopened.listCollectionItems({ bridgeId: "demo", seriesId: "s1" })).toHaveLength(2);
    expect(await reopened.listCollectionItems({ bridgeId: "demo" })).toHaveLength(3);
    expect(await reopened.listCollectionItems()).toHaveLength(4);
  });

  test("collections are stored as one ordered document", async () => {
    const store = new FileLibraryStore(LIB);
    const collections: Collection[] = [
      { id: "a", name: "Panels", order: 0 },
      { id: "b", name: "Splashes", order: 1 },
    ];
    await store.updateCollections(() => collections);
    expect(await new FileLibraryStore(LIB).listCollections()).toEqual(collections);

    // A whole-document write is how a reorder or a cascading delete lands atomically.
    await store.updateCollections(() => [{ id: "b", name: "Splashes", order: 0 }]);
    expect(await new FileLibraryStore(LIB).listCollections()).toEqual([
      { id: "b", name: "Splashes", order: 0 },
    ]);
  });

  test("overlapping collection updates each see the other's result — none is lost", async () => {
    const store = new FileLibraryStore(LIB);
    await Promise.all(
      ["a", "b", "c", "d"].map((id, i) => store.updateCollections((cur) => [...cur, { id, name: id, order: i }])),
    );
    const ids = (await new FileLibraryStore(LIB).listCollections()).map((c) => c.id).sort();
    expect(ids).toEqual(["a", "b", "c", "d"]);
  });

  test("an update that throws writes nothing", async () => {
    const store = new FileLibraryStore(LIB);
    await store.updateCollections(() => [{ id: "a", name: "Panels", order: 0 }]);
    await expect(
      store.updateCollections(() => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(await new FileLibraryStore(LIB).listCollections()).toEqual([{ id: "a", name: "Panels", order: 0 }]);
  });

  test("listCollections hands back a copy — mutating it can't corrupt the cache", async () => {
    const store = new FileLibraryStore(LIB);
    await store.updateCollections(() => [{ id: "a", name: "Panels", order: 0 }]);
    (await store.listCollections()).push({ id: "evil", name: "Injected", order: 9 });
    expect(await store.listCollections()).toHaveLength(1);
  });

  test("diskUsage counts favorite documents but still skips the covers blob root", async () => {
    const store = new FileLibraryStore(LIB);
    await store.putCollectionItems([page()]);
    const docsOnly = await store.diskUsage();
    expect(docsOnly).toBeGreaterThan(0);

    // The covers BlobStore reports its own usage; counting it here would make /library/usage
    // double it. Favorites store no bytes at all, so they add nothing beyond their JSON document.
    mkdirSync(join(LIB, "covers"), { recursive: true });
    writeFileSync(join(LIB, "covers", "blob.bin"), Buffer.alloc(4096));
    expect(await store.diskUsage()).toBe(docsOnly);
  });
});

describe("FileLibraryStore activity", () => {
  const item = (chapterId: string, detectedAt = 1) => ({ bridgeId: "demo", seriesId: "s1", chapterId, title: "Series One", detectedAt });

  test("an event is recorded once, and that survives a reopen", async () => {
    const store = new FileLibraryStore(LIB);
    expect(await store.putActivity(item("c1"))).toBe(true);
    expect(await store.putActivity(item("c1", 2))).toBe(false);

    const reopened = new FileLibraryStore(LIB);
    expect(await reopened.putActivity(item("c1", 3))).toBe(false);
    expect(await reopened.listActivity()).toEqual([item("c1")]);
  });

  test("dropActivity removes the events named and leaves the rest, on disk too", async () => {
    const store = new FileLibraryStore(LIB);
    for (const id of ["c1", "c2", "c3"]) await store.putActivity(item(id));
    await store.dropActivity(["demo:s1:c1", "demo:s1:c3", "demo:s1:never"]);
    expect((await store.listActivity()).map((a) => a.chapterId)).toEqual(["c2"]);
    expect((await new FileLibraryStore(LIB).listActivity()).map((a) => a.chapterId)).toEqual(["c2"]);
  });
});

describe("FileLibraryStore enumeration", () => {
  test("listProgressKeys finds every series with progress, across a reopen", async () => {
    const store = new FileLibraryStore(LIB);
    expect(await store.listProgressKeys()).toEqual([]);

    // Keys carry characters a filename can't — the listing has to hand back the key, not the name.
    await store.putProgress("demo:s1", { chapterId: "c1", read: true, lastPage: 3, updatedAt: 1 });
    await store.putProgress("scope/name:a b?c", { chapterId: "c1", read: false, lastPage: 0, updatedAt: 2 });
    // Looking a series up doesn't make it one with progress.
    await store.listProgress("demo:never-read");

    const keys = (await new FileLibraryStore(LIB).listProgressKeys()).sort();
    expect(keys).toEqual(["demo:s1", "scope/name:a b?c"]);
    expect((await store.listProgressKeys()).sort()).toEqual(keys);
    expect(await new FileLibraryStore(LIB).listProgress("scope/name:a b?c")).toHaveLength(1);
  });

  test("listBridgePrefs returns every bridge's prefs, and nothing before any are set", async () => {
    const store = new FileLibraryStore(LIB);
    expect(await store.listBridgePrefs()).toEqual([]);

    await store.setBridgePrefs("demo", { bridgeId: "demo", trackersDisabled: true, historyDisabled: false });
    await store.setBridgePrefs("quiet", { bridgeId: "quiet", trackersDisabled: false, historyDisabled: true });

    const prefs = (await new FileLibraryStore(LIB).listBridgePrefs()).sort((a, b) => a.bridgeId.localeCompare(b.bridgeId));
    expect(prefs).toEqual([
      { bridgeId: "demo", trackersDisabled: true, historyDisabled: false },
      { bridgeId: "quiet", trackersDisabled: false, historyDisabled: true },
    ]);
  });
});

describe("FileLibraryStore id migrations", () => {
  test("deleteProgress removes only the chapters named, on disk too", async () => {
    const store = new FileLibraryStore(LIB);
    await store.putProgress("demo:s1", { chapterId: "c1", read: true, updatedAt: 1 });
    await store.putProgress("demo:s1", { chapterId: "c2", read: true, updatedAt: 2 });
    await store.deleteProgress("demo:s1", ["c1", "missing"]);
    expect((await new FileLibraryStore(LIB).listProgress("demo:s1")).map((p) => p.chapterId)).toEqual(["c2"]);
  });

  test("marks are kept per bridge across a reopen, and clear together", async () => {
    const store = new FileLibraryStore(LIB);
    expect(await store.getIdMigrationMark("demo")).toBeUndefined();
    await store.setIdMigrationMark("demo", "2.0.0");
    await store.setIdMigrationMark("other", "1.0.0");
    const reopened = new FileLibraryStore(LIB);
    expect(await reopened.getIdMigrationMark("demo")).toBe("2.0.0");
    await reopened.clearIdMigrationMarks();
    expect(await new FileLibraryStore(LIB).getIdMigrationMark("other")).toBeUndefined();
  });
});

describe("FileLibraryStore corruption", () => {
  const silenced = async <T>(fn: () => Promise<T>): Promise<T> => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      return await fn();
    } finally {
      console.warn = warn;
    }
  };

  test("a garbled collections.json is moved aside, not read as empty and overwritten", async () => {
    writeFileSync(join(LIB, "collections.json"), '[{"id":"c1","name":"Favou'); // cut off mid-write
    const store = new FileLibraryStore(LIB);
    expect(await silenced(() => store.listCollections())).toEqual([]);
    await store.updateCollections(() => [{ id: "c2", name: "New", createdAt: 1, order: 0 } as Collection]);

    const aside = readdirSync(LIB).find((f) => f.startsWith("collections.json.corrupt-"));
    expect(aside).toBeDefined();
    expect(readFileSync(join(LIB, aside!), "utf8")).toBe('[{"id":"c1","name":"Favou');
  });

  test("a progress file of the wrong shape is quarantined, and listings skip the quarantined copy", async () => {
    mkdirSync(join(LIB, "progress"), { recursive: true });
    writeFileSync(join(LIB, "progress", `${encodeURIComponent("demo:s1")}.json`), "[]"); // an array, not a map
    const store = new FileLibraryStore(LIB);
    expect(await silenced(() => store.listProgress("demo:s1"))).toEqual([]);
    // The `.corrupt-*` copy doesn't end in `.json`, so it isn't mistaken for a series with progress.
    expect(await store.listProgressKeys()).toEqual([]);
  });

  test("an unreadable document throws rather than presenting an empty library", async () => {
    mkdirSync(join(LIB, "reading-log.json")); // a directory where the file should be: a real IO error
    await expect(new FileLibraryStore(LIB).listReadingLog()).rejects.toThrow();
  });

  test("concurrent first writes to a cold store all land", async () => {
    const store = new FileLibraryStore(LIB);
    await Promise.all(
      ["c1", "c2", "c3", "c4"].map((id) => store.putProgress("demo:s1", { chapterId: id, read: true, lastPage: 0, updatedAt: 1 })),
    );
    const reopened = await new FileLibraryStore(LIB).listProgress("demo:s1");
    expect(reopened.map((p) => p.chapterId).sort()).toEqual(["c1", "c2", "c3", "c4"]);
  });

  test("clearing activity while another write is pending leaves no stale events behind", async () => {
    const store = new FileLibraryStore(LIB);
    await store.putActivity({ bridgeId: "demo", seriesId: "s1", chapterId: "c1", title: "S", detectedAt: 1 });
    await Promise.all([store.clearActivity(), store.dropActivity(["demo:s1:c1"])]);
    expect(await new FileLibraryStore(LIB).listActivity()).toEqual([]);
  });
});
