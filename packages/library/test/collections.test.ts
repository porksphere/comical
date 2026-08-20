/**
 * Favorites (series / chapter / page items) in the `Library` service — the filter/sort/membership
 * logic that every host and every platform inherits by putting it HERE rather than in a store or a
 * client.
 *
 * Favorites are local user data keyed by typed coordinates, with a DERIVED id. Most of what these
 * lock down follows from that one decision: favoriting is idempotent, "is this favorited" is a
 * keyed lookup, and re-favoriting must not resurrect a fresh record over the user's collections.
 */
import { describe, expect, test } from "bun:test";
import {
  collectionItemId,
  InMemoryLibraryStore,
  Library,
  parseCollectionItemId,
  type PageItemCoord,
  type ChapterPageRef,
  type PageItemSnapshot,
  type LibraryStore,
} from "../src/index.ts";

const coord = (over: Partial<PageItemCoord> = {}): PageItemCoord => ({
  bridgeId: "demo",
  seriesId: "s1",
  chapterId: "c1",
  pageIndex: 0,
  ...over,
});

/** The derived id for a page at the standard coordinates. */
const pageId = (over: Partial<PageItemCoord> = {}) => collectionItemId({ type: "page", ...coord(over) });

/** Fetch an item and narrow it to the page variant (undefined when absent or another type). */
const getPage = async (lib: Library, id: string) => {
  const item = await lib.getCollectionItem(id);
  return item?.type === "page" ? item : undefined;
};

/** Reconcile chapter `c1` of the standard series from explicit page refs. */
const reconcileRefs = (lib: Library, pages: ChapterPageRef[], chapterId = "c1") =>
  lib.reconcileChapterPages("demo", "s1", chapterId, pages);

/** A library with a controllable clock, so `collectedAt` ordering is deterministic. */
function makeLibrary(): { lib: Library; tick: () => void } {
  let t = 1_000;
  return { lib: new Library(new InMemoryLibraryStore(), { now: () => t }), tick: () => void (t += 1_000) };
}

describe("collectionItemId", () => {
  test("round-trips page coordinates, including ids containing the separator", () => {
    const c = { type: "page" as const, ...coord({ seriesId: "weird:id/with?chars", chapterId: "vol:1", pageIndex: 12 }) };
    expect(parseCollectionItemId(collectionItemId(c))).toEqual(c);
  });

  test("round-trips series and chapter coordinates", () => {
    const series = { type: "series" as const, bridgeId: "demo", seriesId: "s:1" };
    const chapter = { type: "chapter" as const, bridgeId: "demo", seriesId: "s1", chapterId: "c/9?x" };
    expect(parseCollectionItemId(collectionItemId(series))).toEqual(series);
    expect(parseCollectionItemId(collectionItemId(chapter))).toEqual(chapter);
  });

  test("the type prefix keeps the three shapes in one unambiguous keyspace", () => {
    expect(collectionItemId({ type: "series", bridgeId: "b", seriesId: "s" })).toBe("series:b:s");
    expect(collectionItemId({ type: "chapter", bridgeId: "b", seriesId: "s", chapterId: "c" })).toBe("chapter:b:s:c");
    expect(collectionItemId({ type: "page", bridgeId: "b", seriesId: "s", chapterId: "c", pageIndex: 0 })).toBe("page:b:s:c:0");
  });

  test("encodes each component so the ':' join stays unambiguous", () => {
    // Were components left raw, "a:b" + "c" would be indistinguishable from "a" + "b:c".
    const a = collectionItemId({ type: "page", ...coord({ bridgeId: "a", seriesId: "b:c" }) });
    const b = collectionItemId({ type: "page", ...coord({ bridgeId: "a:b", seriesId: "c" }) });
    expect(a).not.toBe(b);
    expect(parseCollectionItemId(a)).toEqual({ type: "page", ...coord({ bridgeId: "a", seriesId: "b:c" }) });
    expect(parseCollectionItemId(b)).toEqual({ type: "page", ...coord({ bridgeId: "a:b", seriesId: "c" }) });
  });

  test("rejects malformed ids rather than inventing coordinates", () => {
    expect(parseCollectionItemId("page:too:few")).toBeUndefined();
    expect(parseCollectionItemId("page:a:b:c:d:e")).toBeUndefined();
    expect(parseCollectionItemId("page:a:b:c:notanumber")).toBeUndefined();
    expect(parseCollectionItemId("page:a:b:c:-1")).toBeUndefined();
    expect(parseCollectionItemId("page:a:b:c:1.5")).toBeUndefined();
    expect(parseCollectionItemId("page:a:b:c:")).toBeUndefined();
    expect(parseCollectionItemId("page:a:b::0")).toBeUndefined();
    expect(parseCollectionItemId("series:a")).toBeUndefined();
    expect(parseCollectionItemId("chapter:a:b")).toBeUndefined();
    expect(parseCollectionItemId("ghost:a:b:c:0")).toBeUndefined(); // unknown type token
    expect(parseCollectionItemId("page:%ZZ:b:c:0")).toBeUndefined(); // invalid percent-escape
  });
});

describe("favoriting a page", () => {
  test("derives the id from the coordinates and records the snapshot", async () => {
    const { lib } = makeLibrary();
    const page = await lib.collectPage(coord({ pageIndex: 3 }), {
      seriesTitle: "Series One",
      chapterName: "Ch 1",
      pageCount: 20,
      sourceUrl: "https://cdn.example/3.jpg",
    });
    expect(page.id).toBe(pageId({ pageIndex: 3 }));
    expect(page).toMatchObject({
      bridgeId: "demo",
      seriesId: "s1",
      chapterId: "c1",
      pageIndex: 3,
      seriesTitle: "Series One",
      chapterName: "Ch 1",
      pageCount: 20,
      collectedAt: 1_000,
      collectionIds: [],
    });
    expect(await lib.getCollectionItem(page.id)).toEqual(page);
  });

  test("is idempotent — re-favoriting refreshes the snapshot without duplicating", async () => {
    const { lib, tick } = makeLibrary();
    await lib.collectPage(coord(), { seriesTitle: "Old Title", chapterName: "Ch 1" });
    tick();
    const again = await lib.collectPage(coord(), { seriesTitle: "Renamed", chapterName: "Chapter 1" });

    expect(await lib.getCollectionItems()).toHaveLength(1);
    expect(again.seriesTitle).toBe("Renamed");
    expect(again.chapterName).toBe("Chapter 1");
    // The original favorite date survives: the user favorited this page once, not twice.
    expect(again.collectedAt).toBe(1_000);
  });

  test("re-favoriting preserves collection memberships", async () => {
    const { lib } = makeLibrary();
    const collection = await lib.createCollection("Panels");
    const page = await lib.collectPage(coord(), { seriesTitle: "Series One" });
    await lib.setItemCollections(page.id, [collection.id]);

    const again = await lib.collectPage(coord(), { seriesTitle: "Series One" });
    expect(again.collectionIds).toEqual([collection.id]);
  });

  test("records both re-anchor keys — the URL and the client-supplied hash", async () => {
    // The hash is free to capture here: the user is looking at the page as they favorite it, so the
    // client already holds the bytes.
    const { lib } = makeLibrary();
    const page = await lib.collectPage(coord(), {
      seriesTitle: "S",
      sourceUrl: "https://cdn.example/0.png",
      contentHash: "sha-0",
    });
    expect(page).toMatchObject({ sourceUrl: "https://cdn.example/0.png", contentHash: "sha-0" });
  });

  test("a partial re-favorite MERGES — it never erases a field it didn't resend", async () => {
    // The client cannot always send everything at once. comical-app favorites on tap and follows up
    // with a second PUT carrying the hash, because SHA-256 over a ~1MB page on Hermes' JS crypto
    // shim is far too slow to block the tap. A rebuild-from-snapshot would let that second PUT wipe
    // whatever it didn't happen to repeat — including `pageCount`, which reconcile falls back on.
    const { lib } = makeLibrary();
    await lib.collectPage(coord(), {
      seriesTitle: "Series One",
      chapterName: "Ch 1",
      pageCount: 20,
      sourceUrl: "https://cdn/p0.png",
    });

    const after = await lib.collectPage(coord(), { seriesTitle: "Series One", contentHash: "sha-0" });
    expect(after).toMatchObject({
      chapterName: "Ch 1",
      pageCount: 20,
      sourceUrl: "https://cdn/p0.png",
      contentHash: "sha-0",
    });
  });

  test("a re-favorite that DOES resend a field takes the fresher value", async () => {
    const { lib } = makeLibrary();
    await lib.collectPage(coord(), { seriesTitle: "S", sourceUrl: "https://cdn/old.png", contentHash: "sha-old" });
    const after = await lib.collectPage(coord(), {
      seriesTitle: "S",
      sourceUrl: "https://cdn/new.png",
      contentHash: "sha-new",
    });
    expect(after).toMatchObject({ sourceUrl: "https://cdn/new.png", contentHash: "sha-new" });
  });

  test("re-favoriting clears `stale` — the user is looking at the page as they tap", async () => {
    const { lib, fav } = await (async () => {
      const { lib } = makeLibrary();
      const fav = await lib.collectPage(coord({ pageIndex: 2 }), { seriesTitle: "S", pageCount: 4 });
      return { lib, fav };
    })();
    await reconcileRefs(lib, [{}, {}]); // count changed, unplaceable → stale
    expect((await getPage(lib, fav.id))?.stale).toBe(true);

    const refreshed = await lib.collectPage(coord({ pageIndex: 2 }), { seriesTitle: "S", pageCount: 4 });
    expect(refreshed.stale).toBeUndefined();
  });

  test("distinct pages of the same chapter are distinct favorites", async () => {
    const { lib } = makeLibrary();
    await lib.collectPage(coord({ pageIndex: 0 }), { seriesTitle: "S" });
    await lib.collectPage(coord({ pageIndex: 1 }), { seriesTitle: "S" });
    expect(await lib.getCollectionItems()).toHaveLength(2);
  });

  test("unfavoriting returns the removed record, and is idempotent", async () => {
    const { lib } = makeLibrary();
    await lib.collectPage(coord(), { seriesTitle: "S" });

    expect((await lib.uncollectItem({ type: "page", ...coord() }))?.seriesTitle).toBe("S");
    expect(await lib.getCollectionItems()).toEqual([]);
    // Removing again is a no-op, not an error — a double-tap must not throw.
    expect(await lib.uncollectItem({ type: "page", ...coord() })).toBeUndefined();
  });
});

describe("getCollectedPageIndices", () => {
  test("returns only the requested chapter's indices, ascending", async () => {
    const { lib } = makeLibrary();
    for (const pageIndex of [5, 1, 3]) await lib.collectPage(coord({ pageIndex }), { seriesTitle: "S" });
    await lib.collectPage(coord({ chapterId: "c2", pageIndex: 9 }), { seriesTitle: "S" });
    await lib.collectPage(coord({ seriesId: "s2", pageIndex: 7 }), { seriesTitle: "Other" });

    expect(await lib.getCollectedPageIndices("demo", "s1", "c1")).toEqual([1, 3, 5]);
    expect(await lib.getCollectedPageIndices("demo", "s1", "c2")).toEqual([9]);
  });

  test("is empty for a chapter with no favorites", async () => {
    const { lib } = makeLibrary();
    expect(await lib.getCollectedPageIndices("demo", "s1", "nope")).toEqual([]);
  });

  test("handles the chapterless-series sentinel like any other chapter id", async () => {
    const { lib } = makeLibrary();
    await lib.collectPage(coord({ chapterId: "__direct__", pageIndex: 2 }), { seriesTitle: "S" });
    expect(await lib.getCollectedPageIndices("demo", "s1", "__direct__")).toEqual([2]);
  });
});

describe("getFavoritePages — filter and sort", () => {
  /** Three favorites across two series, favorited oldest-to-newest in listed order. */
  async function seed() {
    const { lib, tick } = makeLibrary();
    const zebra = await lib.collectPage(coord({ seriesId: "s2", chapterId: "c9", pageIndex: 4 }), {
      seriesTitle: "Zebra Tales",
      chapterName: "Ch 9",
    });
    tick();
    const alpha1 = await lib.collectPage(coord({ chapterId: "c2", pageIndex: 1 }), {
      seriesTitle: "Alpha Comic",
      chapterName: "Ch 2",
    });
    tick();
    const alpha2 = await lib.collectPage(coord({ chapterId: "c1", pageIndex: 7 }), {
      seriesTitle: "Alpha Comic",
      chapterName: "Ch 1",
    });
    return { lib, zebra, alpha1, alpha2 };
  }

  test("defaults to newest favorited first", async () => {
    const { lib, zebra, alpha1, alpha2 } = await seed();
    expect((await lib.getCollectionItems()).map((p) => p.id)).toEqual([alpha2.id, alpha1.id, zebra.id]);
  });

  test("dir=asc reverses the date axis (what used to be a separate 'oldest' key)", async () => {
    const { lib, zebra, alpha1, alpha2 } = await seed();
    expect((await lib.getCollectionItems({ sort: "added", dir: "asc" })).map((p) => p.id)).toEqual([
      zebra.id,
      alpha1.id,
      alpha2.id,
    ]);
  });

  test("sort=series groups by series title, oldest first within a series", async () => {
    const { lib, zebra, alpha1, alpha2 } = await seed();
    expect((await lib.getCollectionItems({ sort: "series" })).map((p) => p.id)).toEqual([
      alpha1.id,
      alpha2.id,
      zebra.id,
    ]);
  });

  test("dir applies to a title-led key too — the thing a fused sort enum couldn't express", async () => {
    // "series, descending" needed a whole new enum value before `dir` existed. One sign covers the
    // entire comparison, so the within-series tie-breaker flips with it.
    const { lib, zebra, alpha1, alpha2 } = await seed();
    expect((await lib.getCollectionItems({ sort: "series", dir: "desc" })).map((p) => p.id)).toEqual([
      zebra.id,
      alpha2.id,
      alpha1.id,
    ]);
  });

  test("sort=chapter is reading order: series, then chapter, then page", async () => {
    const { lib, zebra, alpha1, alpha2 } = await seed();
    // alpha2 is Ch 1 but was favorited LAST — reading order must beat the date axis here.
    expect((await lib.getCollectionItems({ sort: "chapter" })).map((p) => p.id)).toEqual([
      alpha2.id,
      alpha1.id,
      zebra.id,
    ]);
  });

  test("filters by series via its entryKey", async () => {
    const { lib, alpha1, alpha2 } = await seed();
    const got = await lib.getCollectionItems({ series: "demo:s1" });
    expect(got.map((p) => p.id).sort()).toEqual([alpha1.id, alpha2.id].sort());
    expect(await lib.getCollectionItems({ series: "demo:nope" })).toEqual([]);
  });

  test("q matches series title and chapter name, case-insensitively", async () => {
    const { lib, zebra } = await seed();
    expect((await lib.getCollectionItems({ q: "zeBRa" })).map((p) => p.id)).toEqual([zebra.id]);
    expect((await lib.getCollectionItems({ q: "ch 9" })).map((p) => p.id)).toEqual([zebra.id]);
    expect(await lib.getCollectionItems({ q: "nothing" })).toEqual([]);
  });

  test("filters by collection", async () => {
    const { lib, alpha1 } = await seed();
    const panels = await lib.createCollection("Panels");
    await lib.setItemCollections(alpha1.id, [panels.id]);
    expect((await lib.getCollectionItems({ collection: panels.id })).map((p) => p.id)).toEqual([alpha1.id]);
  });

  test("emptying an item's memberships removes the item — pure collections", async () => {
    const { lib, alpha1 } = await seed();
    const panels = await lib.createCollection("Panels");
    await lib.setItemCollections(alpha1.id, [panels.id]);

    expect(await lib.setItemCollections(alpha1.id, [])).toBeUndefined();
    expect(await lib.getCollectionItem(alpha1.id)).toBeUndefined();
    // ...and memberships resolving to zero after unknown ids drop counts as emptying.
    const again = await lib.collectPage(coord({ chapterId: "c2", pageIndex: 1 }), { seriesTitle: "Alpha Comic" });
    expect(await lib.setItemCollections(again.id, ["ghost"])).toBeUndefined();
    expect(await lib.getCollectionItem(again.id)).toBeUndefined();
  });

  test("combines filters", async () => {
    const { lib, alpha1 } = await seed();
    const got = await lib.getCollectionItems({ series: "demo:s1", q: "Ch 2" });
    expect(got.map((p) => p.id)).toEqual([alpha1.id]);
  });

  test("is empty, not an error, with nothing favorited", async () => {
    const { lib } = makeLibrary();
    expect(await lib.getCollectionItems({ sort: "series", q: "x" })).toEqual([]);
  });
});

describe("favorite collections", () => {
  test("create assigns increasing order; the list comes back ordered", async () => {
    const { lib } = makeLibrary();
    const a = await lib.createCollection("A");
    const b = await lib.createCollection("B");
    expect([a.order, b.order]).toEqual([0, 1]);
    expect((await lib.getCollections()).map((c) => c.name)).toEqual(["A", "B"]);
  });

  test("rename changes the name in place", async () => {
    const { lib } = makeLibrary();
    const a = await lib.createCollection("A");
    await lib.renameCollection(a.id, "Renamed");
    expect((await lib.getCollections())[0]).toMatchObject({ id: a.id, name: "Renamed", order: 0 });
  });

  test("renaming an unknown collection throws", async () => {
    const { lib } = makeLibrary();
    expect(lib.renameCollection("nope", "X")).rejects.toThrow("favorite collection not found: nope");
  });

  test("reorder applies the given order — the client's whole-list drag", async () => {
    const { lib } = makeLibrary();
    const a = await lib.createCollection("A");
    const b = await lib.createCollection("B");
    const c = await lib.createCollection("C");
    await lib.reorderCollections([c.id, b.id, a.id]);
    expect((await lib.getCollections()).map((x) => x.name)).toEqual(["C", "B", "A"]);
  });

  test("reorder leaves collections not named in the list at their existing order", async () => {
    // Behavioural parity with `reorderLists`: a PARTIAL list only repositions what it names, so an
    // omitted collection keeps its old `order` and may end up tied. Clients send the whole list.
    const { lib } = makeLibrary();
    const a = await lib.createCollection("A");
    const b = await lib.createCollection("B");
    const c = await lib.createCollection("C");
    await lib.reorderCollections([c.id, a.id]);
    const byId = new Map((await lib.getCollections()).map((x) => [x.id, x.order]));
    expect(byId.get(c.id)).toBe(0);
    expect(byId.get(a.id)).toBe(1);
    expect(byId.get(b.id)).toBe(1); // untouched — still where it was
  });

  test("setItemCollections replaces memberships and drops unknown ids", async () => {
    const { lib } = makeLibrary();
    const a = await lib.createCollection("A");
    const b = await lib.createCollection("B");
    const page = await lib.collectPage(coord(), { seriesTitle: "S" });

    await lib.setItemCollections(page.id, [a.id, b.id]);
    expect((await lib.getCollectionItem(page.id))?.collectionIds.sort()).toEqual([a.id, b.id].sort());

    const next = await lib.setItemCollections(page.id, [b.id, "ghost", b.id]);
    expect(next?.collectionIds).toEqual([b.id]); // deduped, unknown dropped
  });

  test("setting collections on an unknown item throws", async () => {
    const { lib } = makeLibrary();
    expect(lib.setItemCollections("page:demo:s1:c1:0", [])).rejects.toThrow("item not found");
  });

  test("deleting a collection removes items whose last membership it was — pure collections", async () => {
    const { lib } = makeLibrary();
    const a = await lib.createCollection("A");
    const b = await lib.createCollection("B");
    const p1 = await lib.collectPage(coord({ pageIndex: 0 }), { seriesTitle: "S" });
    const p2 = await lib.collectPage(coord({ pageIndex: 1 }), { seriesTitle: "S" });
    await lib.setItemCollections(p1.id, [a.id, b.id]);
    await lib.setItemCollections(p2.id, [a.id]);

    await lib.deleteCollection(a.id);

    expect((await lib.getCollections()).map((c) => c.id)).toEqual([b.id]);
    // p1 survives with its remaining membership; p2's only membership died with the collection —
    // items exist only as members, PAGES INCLUDED (no bare-heart exception any more).
    expect((await lib.getCollectionItems()).map((i) => i.id)).toEqual([p1.id]);
    expect((await lib.getCollectionItem(p1.id))?.collectionIds).toEqual([b.id]);
    expect(await lib.getCollectionItem(p2.id)).toBeUndefined();
  });

  test("deleting an unknown collection is a no-op", async () => {
    const { lib } = makeLibrary();
    await lib.createCollection("A");
    await lib.deleteCollection("ghost");
    expect(await lib.getCollections()).toHaveLength(1);
  });
});

describe("independence from the series item", () => {
  test("a page can be collected from a series that was never collected itself", async () => {
    const { lib } = makeLibrary();
    await lib.collectPage(coord(), { seriesTitle: "Never Added" });
    expect(await lib.isCollected("demo:s1")).toBe(false);
    expect(await lib.getCollectionItems()).toHaveLength(1);
  });

  test("removing the series leaves its chapter and page items alone", async () => {
    const { lib } = makeLibrary();
    await lib.collectSeries({ bridgeId: "demo", seriesId: "s1" }, { seriesTitle: "Series One" });
    await lib.collectPage(coord(), { seriesTitle: "Series One" });
    await lib.removeSeries("demo:s1");
    expect(await lib.getCollectionItems()).toHaveLength(1);
  });
});

/**
 * Since the library dissolved into collections, a SERIES item is the only record that owns the
 * series' satellite documents — progress, activity, the offline detail and chapter caches, a group
 * membership. Every route that can zero one therefore has to run the same cascade, or the store
 * silently accumulates documents no item points at any more.
 */
describe("uncollecting a series cascades to its satellite documents", () => {
  /** A collected, filed series with progress and both cached documents on it. */
  async function seedSeries(lib: Library, collectionIds: string[]) {
    await lib.collectSeries({ bridgeId: "demo", seriesId: "s1" }, { seriesTitle: "Series One", collectionIds });
    await lib.cacheSeriesDetail("demo:s1", { id: "s1", title: "Series One" });
    await lib.syncChapters("demo:s1", [{ id: "c1", name: "Ch 1", number: 1 }]);
    await lib.markRead("demo:s1", "c1", true);
    await lib.collectPage(coord(), { seriesTitle: "Series One" });
  }

  /**
   * The caches go; the page item survives (its membership is its own) and so does READ PROGRESS,
   * which is the whole point — an organizing action must never destroy the one piece of state the
   * user cannot get back. See `Library.removeSeries`.
   */
  async function expectCascaded(lib: Library) {
    expect(await lib.getSeries("demo:s1")).toBeUndefined();
    expect(await lib.getCachedDetail("demo:s1")).toBeUndefined();
    expect(await lib.getCachedChapters("demo:s1")).toBeUndefined();
    expect((await lib.getCollectionItems()).map((i) => i.type)).toEqual(["page"]);
    expect(await lib.getProgress("demo:s1")).toHaveLength(1);
  }

  test("an explicit uncollect cascades", async () => {
    const { lib } = makeLibrary();
    const shelf = await lib.createCollection("Shelf");
    await seedSeries(lib, [shelf.id]);

    await lib.uncollectItem({ type: "series", bridgeId: "demo", seriesId: "s1" });
    await expectCascaded(lib);
  });

  test("emptying its memberships cascades", async () => {
    const { lib } = makeLibrary();
    const shelf = await lib.createCollection("Shelf");
    await seedSeries(lib, [shelf.id]);

    expect(await lib.setItemCollections(collectionItemId({ type: "series", bridgeId: "demo", seriesId: "s1" }), [])).toBeUndefined();
    await expectCascaded(lib);
  });

  test("deleting its last collection cascades", async () => {
    const { lib } = makeLibrary();
    const shelf = await lib.createCollection("Shelf");
    await seedSeries(lib, [shelf.id]);

    await lib.deleteCollection(shelf.id);
    await expectCascaded(lib);
  });

  test("losing one of several memberships does NOT cascade", async () => {
    const { lib } = makeLibrary();
    const shelf = await lib.createCollection("Shelf");
    const keep = await lib.createCollection("Keep");
    await seedSeries(lib, [shelf.id, keep.id]);

    await lib.deleteCollection(shelf.id);
    expect((await lib.getSeries("demo:s1"))?.collectionIds).toEqual([keep.id]);
    expect(await lib.getProgress("demo:s1")).toHaveLength(1);
  });

  test("re-collecting the series puts the reader back where they were", async () => {
    const { lib } = makeLibrary();
    const shelf = await lib.createCollection("Shelf");
    await seedSeries(lib, [shelf.id]);
    await lib.deleteCollection(shelf.id);

    const next = await lib.createCollection("Next");
    await lib.collectSeries({ bridgeId: "demo", seriesId: "s1" }, { seriesTitle: "Series One", collectionIds: [next.id] });
    await lib.syncChapters("demo:s1", [{ id: "c1", name: "Ch 1", number: 1 }]);
    expect((await lib.getProgress("demo:s1")).find((p) => p.chapterId === "c1")?.read).toBe(true);
    expect((await lib.getLibrary()).find((v) => v.seriesId === "s1")?.unreadCount).toBe(0);
  });

  test("resetProgress is the explicit way to destroy read state — orphans included", async () => {
    const { lib } = makeLibrary();
    const shelf = await lib.createCollection("Shelf");
    await seedSeries(lib, [shelf.id]);
    await lib.deleteCollection(shelf.id);
    expect(await lib.getProgress("demo:s1")).toHaveLength(1);

    // No series item left, so this is reaching an orphan — which is exactly what it is for.
    await lib.resetProgress("demo:s1");
    expect(await lib.getProgress("demo:s1")).toHaveLength(0);
  });

  test("resetProgress on a collected series clears its resume point too", async () => {
    const { lib } = makeLibrary();
    const shelf = await lib.createCollection("Shelf");
    await seedSeries(lib, [shelf.id]);
    expect(await lib.getResume("demo:s1")).toBeDefined();

    await lib.resetProgress("demo:s1");
    expect(await lib.getProgress("demo:s1")).toHaveLength(0);
    expect(await lib.getResume("demo:s1")).toBeUndefined();
    expect(await lib.getSeries("demo:s1")).toBeDefined(); // the series itself stays collected
  });
});

/**
 * Chapter drift. A favorite is located by `(bridge, series, chapter, pageIndex)` and sources mutate
 * chapters underneath it — a page inserted at the front shifts every index after it, a re-upload can
 * replace the chapter wholesale. `reconcileChapterPages` is what stops those favorites from
 * silently pointing at the wrong page.
 *
 * It is lazy and per-chapter on purpose: `pages` is the URL list the reader already fetched to
 * render the chapter it just opened, so repairing costs no extra request and never touches the rest
 * of the series.
 */
describe("reconcileChapterPages", () => {
  /** Page 2 of a 4-page chapter. Callers pass a narrower snapshot to drop the URL signal. */
  const WITH_URL: PageItemSnapshot = { seriesTitle: "S", pageCount: 4, sourceUrl: "https://cdn/p2.png" };
  const NO_URL: PageItemSnapshot = { seriesTitle: "S", pageCount: 4 };

  async function seedFavorite(snap: PageItemSnapshot = WITH_URL) {
    const { lib } = makeLibrary();
    const fav = await lib.collectPage(coord({ pageIndex: 2 }), snap);
    return { lib, fav };
  }

  /** Reconcile chapter `c1` of the seeded series from a list of URLs. An empty string stands for a
   *  page the caller has no URL for — a ref with no `url`, which still counts toward the length. */
  const reconcile = (lib: Library, urls: string[], chapterId = "c1") =>
    lib.reconcileChapterPages("demo", "s1", chapterId, urls.map((url) => (url ? { url } : {})));


  const CHAPTER = ["https://cdn/p0.png", "https://cdn/p1.png", "https://cdn/p2.png", "https://cdn/p3.png"];

  test("an unchanged chapter verifies every favorite and repairs nothing", async () => {
    const { lib } = await seedFavorite();
    expect(await reconcile(lib, CHAPTER)).toEqual({
      indices: [2],
      repaired: 0,
      stale: 0,
    });
  });

  test("a page inserted at the front shifts the favorite, and the URL relocates it", async () => {
    const { lib, fav } = await seedFavorite();
    const res = await reconcile(lib, ["https://cdn/new.png", ...CHAPTER]);
    expect(res).toEqual({ indices: [3], repaired: 1, stale: 0 });

    // The record is RE-KEYED, because the id is derived from the coordinates.
    expect(await lib.getCollectionItem(fav.id)).toBeUndefined();
    expect(await lib.getCollectionItem(pageId({ pageIndex: 3 }))).toMatchObject({
      pageIndex: 3,
      pageCount: 5,
    });
  });

  test("a page removed from the front shifts the favorite the other way", async () => {
    const { lib } = await seedFavorite();
    const res = await reconcile(lib, CHAPTER.slice(1));
    expect(res).toEqual({ indices: [1], repaired: 1, stale: 0 });
  });

  test("a page deleted from the chapter goes stale, not deleted from favorites", async () => {
    const { lib, fav } = await seedFavorite();
    // p2 is gone; the chapter is a page shorter and no longer carries its URL.
    const res = await reconcile(lib, [
      "https://cdn/p0.png",
      "https://cdn/p1.png",
      "https://cdn/p3.png",
    ]);
    expect(res).toEqual({ indices: [], repaired: 0, stale: 1 });

    // Kept, with its snapshot intact — the user favorited it deliberately.
    expect(await lib.getCollectionItem(fav.id)).toMatchObject({ stale: true, seriesTitle: "S" });
    expect(await lib.getCollectionItems()).toHaveLength(1);
  });

  test("rotating URLs must NOT mass-stale a chapter that hasn't changed", async () => {
    // Plenty of sources hand out signed / expiring page URLs, so a stored URL matching nothing is
    // the NORM there rather than evidence a page vanished. Treating a miss as proof would stale
    // every favorite in the chapter on the very first reconcile — the exact opposite of the job.
    const { lib } = makeLibrary();
    for (const i of [0, 1, 2]) {
      await lib.collectPage(coord({ pageIndex: i }), {
        seriesTitle: "S",
        pageCount: 4,
        sourceUrl: `https://cdn/p${i}.png?sig=OLD`,
      });
    }
    const resigned = [0, 1, 2, 3].map((i) => `https://cdn/p${i}.png?sig=NEW`);

    const res = await reconcile(lib, resigned);
    expect(res).toEqual({ indices: [0, 1, 2], repaired: 0, stale: 0 });
  });

  test("a URL miss with a CHANGED page count is still stale — that's real evidence", async () => {
    const { lib } = await seedFavorite();
    expect(
      await reconcile(lib, ["https://cdn2/x.png", "https://cdn2/y.png"]),
    ).toEqual({ indices: [], repaired: 0, stale: 1 });
  });

  test("a stale favorite stops being reported as a favorited index", async () => {
    const { lib } = await seedFavorite();
    await reconcile(lib, ["https://cdn/other.png"]);
    // The reader must not highlight or navigate to a page we can't vouch for.
    expect(await lib.getCollectedPageIndices("demo", "s1", "c1")).toEqual([]);
  });

  test("a source reverting a bad re-upload heals the favorite", async () => {
    const { lib, fav } = await seedFavorite();
    await reconcile(lib, ["https://cdn/v2.png"]);
    expect((await getPage(lib, fav.id))?.stale).toBe(true);

    await reconcile(lib, CHAPTER);
    expect((await getPage(lib, fav.id))?.stale).toBeUndefined();
    expect(await lib.getCollectedPageIndices("demo", "s1", "c1")).toEqual([2]);
  });

  test("a relocated favorite adopts its fresh URL, so it survives moving again", async () => {
    const { lib } = await seedFavorite();
    await reconcile(lib, ["https://cdn/new.png", ...CHAPTER]);
    expect((await getPage(lib, pageId({ pageIndex: 3 })))?.sourceUrl).toBe(
      "https://cdn/p2.png",
    );
    // Shift once more; the favorite is still matchable.
    const res = await reconcile(lib, [
      "https://cdn/newer.png",
      "https://cdn/new.png",
      ...CHAPTER,
    ]);
    expect(res).toEqual({ indices: [4], repaired: 1, stale: 0 });
  });

  test("an empty page list is treated as a failed fetch, never as an emptied chapter", async () => {
    // Trusting it would mark the user's entire chapter stale on one transient network error.
    const { lib } = await seedFavorite();
    expect(await reconcile(lib, [])).toEqual({
      indices: [2],
      repaired: 0,
      stale: 0,
    });
    expect((await getPage(lib, pageId({ pageIndex: 2 })))?.stale).toBeUndefined();
  });

  test("with no URL at all, the index is trusted only while the page count holds", async () => {
    const { lib } = await seedFavorite(NO_URL);
    // Same length → assume unchanged.
    expect(await reconcile(lib, ["", "", "", ""])).toEqual({
      indices: [2],
      repaired: 0,
      stale: 0,
    });
    // Different length → "unknown" must not read as "unchanged".
    expect(await reconcile(lib, ["", ""])).toEqual({
      indices: [],
      repaired: 0,
      stale: 1,
    });
  });

  test("only the named chapter is touched", async () => {
    const { lib } = await seedFavorite();
    const other = await lib.collectPage(coord({ chapterId: "c2", pageIndex: 0 }), {
      seriesTitle: "S",
      sourceUrl: "https://cdn/c2-p0.png",
    });
    await reconcile(lib, ["https://cdn/x.png"]);
    expect((await lib.getCollectionItem(other.id))?.stale).toBeUndefined();
  });

  test("reconciling a chapter with no favorites is a no-op", async () => {
    const { lib } = makeLibrary();
    expect(await reconcile(lib, CHAPTER)).toEqual({
      indices: [],
      repaired: 0,
      stale: 0,
    });
  });

  test("two favorites relocating onto one page merge instead of colliding", async () => {
    // A chapter that de-duplicated a repeated page: both favorites now name the same index, and the
    // derived id means they'd overwrite each other. The merge must not drop either's collections.
    const { lib } = makeLibrary();
    const dupes = await lib.createCollection("Dupes");
    const keep = await lib.createCollection("Keep");
    const a = await lib.collectPage(coord({ pageIndex: 1 }), { seriesTitle: "S", sourceUrl: "https://cdn/same.png" });
    const b = await lib.collectPage(coord({ pageIndex: 2 }), { seriesTitle: "S", sourceUrl: "https://cdn/same.png" });
    await lib.setItemCollections(a.id, [dupes.id]);
    await lib.setItemCollections(b.id, [keep.id]);

    expect((await reconcile(lib, ["https://cdn/same.png"])).indices).toEqual([0]);

    const merged = await lib.getCollectionItems();
    expect(merged).toHaveLength(1);
    expect(merged[0]!.collectionIds.sort()).toEqual([dupes.id, keep.id].sort());
    expect(merged[0]!.collectedAt).toBe(1_000); // the earlier of the two
  });
});

/**
 * Scaling. Favorites are the one collection here with no natural ceiling, and a reader hits these
 * paths every time a chapter opens. What matters is that the per-chapter work stays flat as the
 * library grows — a store that loads or rewrites everything per call would not.
 */
describe("scaling — a chapter's cost is independent of library size", () => {
  /** A store that counts what the service asks of it, and how wide each read was. */
  function countingStore() {
    const inner = new InMemoryLibraryStore();
    const calls = { listAll: 0, listScoped: 0, get: 0, put: 0, del: 0, recordsRead: 0, recordsWritten: 0 };
    const store = new Proxy(inner, {
      get(t, prop, recv) {
        if (prop === "listCollectionItems") {
          return async (scope?: Parameters<typeof inner.listCollectionItems>[0]) => {
            scope ? calls.listScoped++ : calls.listAll++;
            const out = await inner.listCollectionItems(scope);
            calls.recordsRead += out.length;
            return out;
          };
        }
        if (prop === "getCollectionItem") {
          return async (id: string) => (calls.get++, inner.getCollectionItem(id));
        }
        if (prop === "putCollectionItems") {
          return async (pages: Parameters<typeof inner.putCollectionItems>[0]) => {
            calls.put++;
            calls.recordsWritten += pages.length;
            return inner.putCollectionItems(pages);
          };
        }
        if (prop === "deleteCollectionItems") {
          return async (ids: string[]) => (calls.del++, inner.deleteCollectionItems(ids));
        }
        return Reflect.get(t, prop, recv);
      },
    }) as LibraryStore;
    return { store, calls };
  }

  /** `total` favorites spread over many chapters of one series, 5 per chapter. */
  async function seedLibrary(lib: Library, total: number) {
    for (let i = 0; i < total; i++) {
      const chapterId = `c${Math.floor(i / 5)}`;
      await lib.collectPage(
        { bridgeId: "demo", seriesId: "huge", chapterId, pageIndex: i % 5 },
        { seriesTitle: "Huge", chapterName: chapterId, pageCount: 20, sourceUrl: `https://cdn/${chapterId}/${i % 5}.png` },
      );
    }
  }

  test("favoriting a page is a keyed lookup — it never lists the library", async () => {
    const { store, calls } = countingStore();
    const lib = new Library(store);
    await seedLibrary(lib, 200);
    // 200 favorites added: 200 keyed gets, 200 batched writes, and not one full listing.
    expect(calls.get).toBe(200);
    expect(calls.listAll).toBe(0);
    expect(calls.recordsWritten).toBe(200);
  });

  test("opening a chapter reads only that chapter's favorites", async () => {
    const { store, calls } = countingStore();
    const lib = new Library(store);
    await seedLibrary(lib, 500);
    const before = { ...calls };

    await lib.getCollectedPageIndices("demo", "huge", "c7");

    expect(calls.listAll).toBe(before.listAll); // never the whole-library path
    expect(calls.listScoped).toBe(before.listScoped + 1);
    // 5 records touched out of 500 — the cost is the chapter, not the library.
    expect(calls.recordsRead - before.recordsRead).toBe(5);
  });

  test("reconciling a chapter costs one scoped read and at most two batched writes", async () => {
    const { store, calls } = countingStore();
    const lib = new Library(store);
    await seedLibrary(lib, 500);
    const before = { ...calls };

    // Shift the chapter by one page so every favorite in it needs repairing.
    const pages = ["https://cdn/c7/new.png", ...Array.from({ length: 5 }, (_, i) => `https://cdn/c7/${i}.png`)];
    const res = await lib.reconcileChapterPages("demo", "huge", "c7", pages.map((url) => ({ url })));
    expect(res.repaired).toBe(5);

    expect(calls.listAll).toBe(before.listAll); // still never the whole library
    expect(calls.listScoped).toBe(before.listScoped + 1);
    expect(calls.recordsRead - before.recordsRead).toBe(5);
    // Five repairs, but ONE delete call and ONE put call — a store rewrites its whole document per
    // call, so a write per record would re-serialize all 500 favorites five times over.
    expect(calls.del - before.del).toBe(1);
    expect(calls.put - before.put).toBe(1);
  });

  test("a per-series grid reads only that series' favorites", async () => {
    const { store, calls } = countingStore();
    const lib = new Library(store);
    await seedLibrary(lib, 100);
    await lib.collectPage(
      { bridgeId: "demo", seriesId: "other", chapterId: "c0", pageIndex: 0 },
      { seriesTitle: "Other" },
    );
    const before = { ...calls };

    const got = await lib.getCollectionItems({ series: "demo:other" });
    expect(got).toHaveLength(1);
    expect(calls.listAll).toBe(before.listAll);
    expect(calls.recordsRead - before.recordsRead).toBe(1);
  });

  test("deleting a collection cascades in one batched write and one batched delete", async () => {
    const { store, calls } = countingStore();
    const lib = new Library(store);
    await seedLibrary(lib, 50);
    const doomed = await lib.createCollection("Doomed");
    const keep = await lib.createCollection("Keep");
    const members = (await lib.getCollectionItems()).slice(0, 20);
    for (const [i, page] of members.entries()) {
      // Half also live in another collection (they survive, stripped); half only here (removed).
      await lib.setItemCollections(page.id, i % 2 === 0 ? [doomed.id, keep.id] : [doomed.id]);
    }
    const before = { ...calls };

    await lib.deleteCollection(doomed.id);

    // 10 survivors stripped in ONE write, 10 last-membership items removed in ONE delete. (The full
    // listing is inherent — a cascade must consider every item, since collections span series.)
    expect(calls.put - before.put).toBe(1);
    expect(calls.recordsWritten - before.recordsWritten).toBe(10);
    expect(calls.del - before.del).toBe(1);
    expect((await lib.getCollectionItems({ collection: keep.id })).length).toBe(10);
  });
});

/**
 * The content-hash signal. It is the strong re-anchor key — it survives URL rot and a chapter
 * re-uploaded under a new id — but it is inherently SPARSE: a client can only hash pages it has
 * rendered, and hashing a whole chapter would mean downloading it just to open it.
 *
 * So the contract is that hashes may only ever help. These lock that down: hits are acted on, misses
 * are not (with one narrow, provable exception), and coverage grows by adoption rather than fetching.
 */
describe("reconcileChapterPages — content hashes", () => {
  const WITH_BOTH: PageItemSnapshot = {
    seriesTitle: "S",
    pageCount: 4,
    sourceUrl: "https://cdn/p2.png",
    contentHash: "sha-p2",
  };

  async function seedHashed(snap: PageItemSnapshot = WITH_BOTH) {
    const { lib } = makeLibrary();
    const fav = await lib.collectPage(coord({ pageIndex: 2 }), snap);
    return { lib, fav };
  }

  test("a hash relocates a page whose URL has completely rotated", async () => {
    // This is the case URL matching alone gave up on: same bytes, brand-new signed URLs.
    const { lib } = await seedHashed();
    const res = await reconcileRefs(lib, [
      { url: "https://cdn2/signed?a=1", contentHash: "sha-p0" },
      { url: "https://cdn2/signed?a=2", contentHash: "sha-p2" }, // moved to index 1
      { url: "https://cdn2/signed?a=3", contentHash: "sha-p3" },
    ]);
    expect(res).toEqual({ indices: [1], repaired: 1, stale: 0 });
    // The rotated URL is adopted too, so the cheap signal works again next time.
    expect((await getPage(lib, pageId({ pageIndex: 1 })))?.sourceUrl).toBe(
      "https://cdn2/signed?a=2",
    );
  });

  test("a hash beats a page count that says 'unchanged'", async () => {
    // Same length, so the count fallback would have shrugged — the hash finds the real position.
    const { lib } = await seedHashed();
    const res = await reconcileRefs(lib, [
      { contentHash: "sha-p1" },
      { contentHash: "sha-p2" },
      { contentHash: "sha-p0" },
      { contentHash: "sha-p3" },
    ]);
    expect(res).toEqual({ indices: [1], repaired: 1, stale: 0 });
  });

  test("SPARSE hashes are safe — an unhashed list behaves exactly as before", async () => {
    // The realistic payload: the client rendered one page, so it can hash one page. Every other
    // favorite must be unaffected rather than staled for lacking a hash to match against.
    const { lib } = makeLibrary();
    for (const i of [0, 1, 2]) {
      await lib.collectPage(coord({ pageIndex: i }), {
        seriesTitle: "S",
        pageCount: 4,
        sourceUrl: `https://cdn/p${i}.png`,
        contentHash: `sha-p${i}`,
      });
    }
    const res = await reconcileRefs(lib, [
      { url: "https://cdn/p0.png" },
      { url: "https://cdn/p1.png", contentHash: "sha-p1" }, // the only page the reader hashed
      { url: "https://cdn/p2.png" },
      { url: "https://cdn/p3.png" },
    ]);
    expect(res).toEqual({ indices: [0, 1, 2], repaired: 0, stale: 0 });
  });

  test("a hash MISS is never evidence — the page may simply be one of the unhashed ones", async () => {
    // A favorite with a hash, against a list that carries hashes for OTHER pages only. Treating
    // that as "gone" would stale favorites purely for being outside the reader's scroll position.
    const { lib, fav } = await seedHashed();
    const res = await reconcileRefs(lib, [
      { url: "https://cdn/p0.png", contentHash: "sha-p0" },
      { url: "https://cdn/p1.png", contentHash: "sha-p1" },
      { url: "https://cdn/p2.png" }, // our page, unhashed this time
      { url: "https://cdn/p3.png" },
    ]);
    expect(res).toEqual({ indices: [2], repaired: 0, stale: 0 });
    expect((await getPage(lib, fav.id))?.stale).toBeUndefined();
  });

  test("a hash AT the favorite's own index that differs IS evidence — that's the one exception", async () => {
    // Same length and no URL to match, so every other signal shrugs. But the reader hashed exactly
    // the page our favorite claims to be, and it is a different image: proof it isn't there.
    // This is the same-length re-upload case nothing else catches.
    const { lib, fav } = await seedHashed({ seriesTitle: "S", pageCount: 4, contentHash: "sha-p2" });
    const res = await reconcileRefs(lib, [{}, {}, { contentHash: "sha-DIFFERENT" }, {}]);
    expect(res).toEqual({ indices: [], repaired: 0, stale: 1 });
    expect((await getPage(lib, fav.id))?.stale).toBe(true);
  });

  test("...but a differing positional hash loses to finding the page elsewhere", async () => {
    const { lib } = await seedHashed({ seriesTitle: "S", pageCount: 4, contentHash: "sha-p2" });
    const res = await reconcileRefs(lib, [{}, {}, { contentHash: "sha-OTHER" }, { contentHash: "sha-p2" }]);
    expect(res).toEqual({ indices: [3], repaired: 1, stale: 0 });
  });

  test("a favorite with no hash ADOPTS one, so coverage grows as the user reads", async () => {
    // No extra fetch anywhere: the reader hashes what it was already displaying, and the favorite
    // is permanently upgraded to the rot-proof signal.
    const { lib } = await seedHashed({ seriesTitle: "S", pageCount: 4, sourceUrl: "https://cdn/p2.png" });
    expect((await getPage(lib, pageId({ pageIndex: 2 })))?.contentHash).toBeUndefined();

    await reconcileRefs(lib, [
      { url: "https://cdn/p0.png" },
      { url: "https://cdn/p1.png" },
      { url: "https://cdn/p2.png", contentHash: "sha-p2" },
      { url: "https://cdn/p3.png" },
    ]);
    expect((await getPage(lib, pageId({ pageIndex: 2 })))?.contentHash).toBe("sha-p2");

    // Now the URLs can rot freely and the favorite still relocates.
    const res = await reconcileRefs(lib, [{ url: "https://new/x.png" }, { url: "https://new/y.png", contentHash: "sha-p2" }]);
    expect(res).toEqual({ indices: [1], repaired: 1, stale: 0 });
  });

  test("adopting never overwrites a hash the favorite already had", async () => {
    const { lib } = await seedHashed();
    await reconcileRefs(lib, [{}, {}, { url: "https://cdn/p2.png", contentHash: "sha-IMPOSTOR" }, {}]);
    // Reached via the URL/count path, not the hash — the stored hash is the user's own capture.
    expect((await getPage(lib, pageId({ pageIndex: 2 })))?.contentHash).toBe("sha-p2");
  });

  test("rotating URLs plus zero hashes still doesn't mass-stale an unchanged chapter", async () => {
    const { lib } = await seedHashed();
    expect(await reconcileRefs(lib, [{ url: "https://r/1" }, { url: "https://r/2" }, { url: "https://r/3" }, { url: "https://r/4" }])).toEqual({
      indices: [2],
      repaired: 0,
      stale: 0,
    });
  });
});

/**
 * The series and chapter variants of the union. Series anchors are trivial (stable coordinates, no
 * drift); chapter anchors carry logical-chapter identity so a re-upload can re-anchor them. Both
 * follow the same merge-on-favorite semantics pages pinned down.
 */
describe("series and chapter favorites", () => {
  test("collectSeries is idempotent and merges over the stored record", async () => {
    const { lib, tick } = makeLibrary();
    await lib.collectSeries({ bridgeId: "demo", seriesId: "s1" }, { seriesTitle: "One", thumbnailUrl: "https://cdn/a.png" });
    tick();
    const again = await lib.collectSeries({ bridgeId: "demo", seriesId: "s1" }, { seriesTitle: "Renamed" });

    expect(await lib.getCollectionItems({ type: "series" })).toHaveLength(1);
    expect(again.item).toMatchObject({
      type: "series",
      seriesTitle: "Renamed", // supplied wins
      thumbnailUrl: "https://cdn/a.png", // omitted preserved
      collectedAt: 1_000, // original date survives
    });
  });

  test("collectSeries files into collections in the same call, dropping unknown ids", async () => {
    const { lib } = makeLibrary();
    const shelf = await lib.createCollection("Shelf");
    const { item } = await lib.collectSeries(
      { bridgeId: "demo", seriesId: "s1" },
      { seriesTitle: "One", collectionIds: [shelf.id, "no-such-collection"] },
    );
    expect(item.collectionIds).toEqual([shelf.id]);
    expect((await lib.getLibrary({ collection: shelf.id })).map((v) => v.seriesId)).toEqual(["s1"]);
  });

  test("a collectionIds list that resolves to nothing leaves existing memberships alone", async () => {
    // The alternative — treating it as an empty set — would delete the series this very call just
    // collected. Emptying memberships stays an explicit `setItemCollections` call.
    const { lib } = makeLibrary();
    const shelf = await lib.createCollection("Shelf");
    await lib.collectSeries({ bridgeId: "demo", seriesId: "s1" }, { seriesTitle: "One", collectionIds: [shelf.id] });

    const { item } = await lib.collectSeries(
      { bridgeId: "demo", seriesId: "s1" },
      { seriesTitle: "One", collectionIds: ["gone"] },
    );
    expect(item.collectionIds).toEqual([shelf.id]);
  });

  test("collectChapter records logical identity and merges like the others", async () => {
    const { lib } = makeLibrary();
    await lib.collectChapter(
      { bridgeId: "demo", seriesId: "s1", chapterId: "c9" },
      { seriesTitle: "One", chapterName: "Ch 9", number: 9, languageCode: "en" },
    );
    const again = await lib.collectChapter(
      { bridgeId: "demo", seriesId: "s1", chapterId: "c9" },
      { seriesTitle: "One" },
    );
    expect(again).toMatchObject({ type: "chapter", chapterName: "Ch 9", number: 9, languageCode: "en" });
  });

  test("the three types share one keyspace without colliding", async () => {
    const { lib } = makeLibrary();
    await lib.collectSeries({ bridgeId: "demo", seriesId: "s1" }, { seriesTitle: "S" });
    await lib.collectChapter({ bridgeId: "demo", seriesId: "s1", chapterId: "c1" }, { seriesTitle: "S" });
    await lib.collectPage(coord(), { seriesTitle: "S" });

    expect(await lib.getCollectionItems()).toHaveLength(3);
    expect(await lib.getCollectionItems({ type: "series" })).toHaveLength(1);
    expect(await lib.getCollectionItems({ type: "chapter" })).toHaveLength(1);
    expect(await lib.getCollectionItems({ type: "page" })).toHaveLength(1);
    // The page indices path only ever sees pages — a chapter anchor on c1 must not leak in.
    expect(await lib.getCollectedPageIndices("demo", "s1", "c1")).toEqual([0]);
  });

  test("a collection can hold all three types, and filters return the mixed union", async () => {
    const { lib } = makeLibrary();
    const mixed = await lib.createCollection("Mixed");
    const series = (await lib.collectSeries({ bridgeId: "demo", seriesId: "s1" }, { seriesTitle: "S" })).item;
    const chapter = await lib.collectChapter({ bridgeId: "demo", seriesId: "s1", chapterId: "c1" }, { seriesTitle: "S" });
    const page = await lib.collectPage(coord(), { seriesTitle: "S" });
    for (const item of [series, chapter, page]) await lib.setItemCollections(item.id, [mixed.id]);

    const got = await lib.getCollectionItems({ collection: mixed.id });
    expect(got.map((i) => i.type).sort()).toEqual(["chapter", "page", "series"]);
  });

  test("deleting a collection removes every type whose last membership it was — no exceptions", async () => {
    // PURE COLLECTIONS: items exist only as members. Pages get no bare-heart carve-out.
    const { lib } = makeLibrary();
    const only = await lib.createCollection("Only");
    const keep = await lib.createCollection("Keep");
    const series = (await lib.collectSeries({ bridgeId: "demo", seriesId: "s1" }, { seriesTitle: "S" })).item;
    const chapter = await lib.collectChapter({ bridgeId: "demo", seriesId: "s1", chapterId: "c1" }, { seriesTitle: "S" });
    const both = await lib.collectChapter({ bridgeId: "demo", seriesId: "s1", chapterId: "c2" }, { seriesTitle: "S" });
    const page = await lib.collectPage(coord(), { seriesTitle: "S" });
    await lib.setItemCollections(series.id, [only.id]);
    await lib.setItemCollections(chapter.id, [only.id]);
    await lib.setItemCollections(both.id, [only.id, keep.id]);
    await lib.setItemCollections(page.id, [only.id]);

    await lib.deleteCollection(only.id);

    // Only the two-collection chapter survives, stripped to its remaining membership.
    expect((await lib.getCollectionItems()).map((i) => i.id)).toEqual([both.id]);
    expect((await lib.getCollectionItem(both.id))?.collectionIds).toEqual([keep.id]);
    expect(await lib.getCollectionItem(page.id)).toBeUndefined();
  });
});

/**
 * Chapter drift, chapter-item edition — run for free inside `syncChapters`, which already receives
 * the fresh chapter list for every library series. A vanished chapter id re-anchors by logical
 * chapter `(number, languageCode)`; page favorites in the re-uploaded chapter heal through the same
 * remap (built from the entry's previous `knownChapters`, so no chapter item needs to exist).
 */
describe("syncChapters re-anchors chapter and page favorites", () => {
  const chp = (id: string, number?: number, name?: string) => ({
    id,
    name: name ?? `Ch ${number ?? "?"}`,
    ...(number !== undefined && { number, languageCode: "en" }),
  });

  async function seededSeries() {
    const { lib } = makeLibrary();
    await lib.collectSeries({ bridgeId: "demo", seriesId: "s1" }, { seriesTitle: "One" });
    // Baseline sync — knownChapters carries each chapter's logical identity afterwards.
    await lib.syncChapters("demo:s1", [chp("c1", 1), chp("c2", 2)]);
    return lib;
  }

  test("a chapter re-uploaded under a new id re-keys its favorite by logical identity", async () => {
    const lib = await seededSeries();
    const fav = await lib.collectChapter(
      { bridgeId: "demo", seriesId: "s1", chapterId: "c2" },
      { seriesTitle: "One", chapterName: "Ch 2", number: 2, languageCode: "en" },
    );

    // The source replaces c2 with c2-v2 (same logical chapter).
    await lib.syncChapters("demo:s1", [chp("c1", 1), chp("c2-v2", 2, "Ch 2 (fixed)")]);

    expect(await lib.getCollectionItem(fav.id)).toBeUndefined(); // re-keyed
    const moved = await lib.getCollectionItem(collectionItemId({ type: "chapter", bridgeId: "demo", seriesId: "s1", chapterId: "c2-v2" }));
    expect(moved).toMatchObject({ type: "chapter", chapterId: "c2-v2", chapterName: "Ch 2 (fixed)" });
    expect(moved?.stale).toBeUndefined();
  });

  test("page favorites in a re-uploaded chapter heal through the same remap, with no chapter item", async () => {
    const lib = await seededSeries();
    await lib.collectPage(coord({ chapterId: "c2", pageIndex: 3 }), { seriesTitle: "One" });

    await lib.syncChapters("demo:s1", [chp("c1", 1), chp("c2-v2", 2)]);

    expect(await lib.getCollectedPageIndices("demo", "s1", "c2")).toEqual([]);
    expect(await lib.getCollectedPageIndices("demo", "s1", "c2-v2")).toEqual([3]);
  });

  test("a vanished chapter with no logical match goes stale, and heals when it returns", async () => {
    const lib = await seededSeries();
    const fav = await lib.collectChapter(
      { bridgeId: "demo", seriesId: "s1", chapterId: "c2" },
      { seriesTitle: "One", number: 2, languageCode: "en" },
    );

    // c2 gone entirely; nothing at (2, en) any more.
    await lib.syncChapters("demo:s1", [chp("c1", 1)]);
    expect((await lib.getCollectionItem(fav.id))?.stale).toBe(true);

    // The source restores it — same id — and the favorite un-stales.
    await lib.syncChapters("demo:s1", [chp("c1", 1), chp("c2", 2)]);
    expect((await lib.getCollectionItem(fav.id))?.stale).toBeUndefined();
  });

  test("a chapter favorited before any sync baseline self-anchors by its own snapshot", async () => {
    const { lib } = makeLibrary();
    await lib.collectSeries({ bridgeId: "demo", seriesId: "s1" }, { seriesTitle: "One" });
    await lib.syncChapters("demo:s1", [chp("old-c5", 5)]);
    // knownChapters knows old-c5. Favorite it WITHOUT the entry ever having seen the replacement.
    await lib.collectChapter(
      { bridgeId: "demo", seriesId: "s1", chapterId: "old-c5" },
      { seriesTitle: "One", number: 5, languageCode: "en" },
    );
    await lib.syncChapters("demo:s1", [chp("new-c5", 5)]);
    const moved = await lib.getCollectionItem(collectionItemId({ type: "chapter", bridgeId: "demo", seriesId: "s1", chapterId: "new-c5" }));
    expect(moved?.type).toBe("chapter");
  });

  test("an untouched sync leaves favorites alone", async () => {
    const lib = await seededSeries();
    const fav = await lib.collectChapter({ bridgeId: "demo", seriesId: "s1", chapterId: "c1" }, { seriesTitle: "One" });
    await lib.syncChapters("demo:s1", [chp("c1", 1), chp("c2", 2)]);
    expect(await lib.getCollectionItem(fav.id)).toMatchObject({ chapterId: "c1" });
    expect((await lib.getCollectionItem(fav.id))?.stale).toBeUndefined();
  });
});
