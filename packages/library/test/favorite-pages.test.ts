/**
 * Page favorites in the `Library` service — the filter/sort/membership logic that every host and
 * every platform inherits by putting it HERE rather than in a store or a client.
 *
 * Favorites are local user data keyed by page coordinates, with a DERIVED id. Most of what these
 * lock down follows from that one decision: favoriting is idempotent, "is this page favorited" is a
 * keyed lookup, and re-favoriting must not resurrect a fresh record over the user's collections.
 */
import { describe, expect, test } from "bun:test";
import {
  favoritePageId,
  InMemoryLibraryStore,
  Library,
  parseFavoritePageId,
  UNCOLLECTED,
  type FavoritePageCoord,
  type FavoritePageSnapshot,
} from "../src/index.ts";

const coord = (over: Partial<FavoritePageCoord> = {}): FavoritePageCoord => ({
  bridgeId: "demo",
  seriesId: "s1",
  chapterId: "c1",
  pageIndex: 0,
  ...over,
});

/** A library with a controllable clock, so `favoritedAt` ordering is deterministic. */
function makeLibrary(): { lib: Library; tick: () => void } {
  let t = 1_000;
  return { lib: new Library(new InMemoryLibraryStore(), { now: () => t }), tick: () => void (t += 1_000) };
}

describe("favoritePageId", () => {
  test("round-trips coordinates, including ids containing the separator", () => {
    const c = coord({ seriesId: "weird:id/with?chars", chapterId: "vol:1", pageIndex: 12 });
    expect(parseFavoritePageId(favoritePageId(c))).toEqual(c);
  });

  test("encodes each component so the ':' join stays unambiguous", () => {
    // Were components left raw, "a:b" + "c" would be indistinguishable from "a" + "b:c".
    const a = favoritePageId(coord({ bridgeId: "a", seriesId: "b:c" }));
    const b = favoritePageId(coord({ bridgeId: "a:b", seriesId: "c" }));
    expect(a).not.toBe(b);
    expect(parseFavoritePageId(a)).toEqual(coord({ bridgeId: "a", seriesId: "b:c" }));
    expect(parseFavoritePageId(b)).toEqual(coord({ bridgeId: "a:b", seriesId: "c" }));
  });

  test("is stable — the same coordinates always derive the same id", () => {
    expect(favoritePageId(coord())).toBe(favoritePageId(coord()));
  });

  test("rejects malformed ids rather than inventing coordinates", () => {
    expect(parseFavoritePageId("too:few:parts")).toBeUndefined();
    expect(parseFavoritePageId("a:b:c:d:e")).toBeUndefined();
    expect(parseFavoritePageId("a:b:c:notanumber")).toBeUndefined();
    expect(parseFavoritePageId("a:b:c:-1")).toBeUndefined();
    expect(parseFavoritePageId("a:b:c:1.5")).toBeUndefined();
    expect(parseFavoritePageId("a:b:c:")).toBeUndefined();
    expect(parseFavoritePageId("a:b::0")).toBeUndefined();
    expect(parseFavoritePageId("%ZZ:b:c:0")).toBeUndefined(); // invalid percent-escape
  });
});

describe("favoriting a page", () => {
  test("derives the id from the coordinates and records the snapshot", async () => {
    const { lib } = makeLibrary();
    const page = await lib.favoritePage(coord({ pageIndex: 3 }), {
      seriesTitle: "Series One",
      chapterName: "Ch 1",
      pageCount: 20,
      sourceUrl: "https://cdn.example/3.jpg",
    });
    expect(page.id).toBe(favoritePageId(coord({ pageIndex: 3 })));
    expect(page).toMatchObject({
      bridgeId: "demo",
      seriesId: "s1",
      chapterId: "c1",
      pageIndex: 3,
      seriesTitle: "Series One",
      chapterName: "Ch 1",
      pageCount: 20,
      favoritedAt: 1_000,
      collectionIds: [],
    });
    expect(await lib.getFavoritePage(page.id)).toEqual(page);
  });

  test("is idempotent — re-favoriting refreshes the snapshot without duplicating", async () => {
    const { lib, tick } = makeLibrary();
    await lib.favoritePage(coord(), { seriesTitle: "Old Title", chapterName: "Ch 1" });
    tick();
    const again = await lib.favoritePage(coord(), { seriesTitle: "Renamed", chapterName: "Chapter 1" });

    expect(await lib.getFavoritePages()).toHaveLength(1);
    expect(again.seriesTitle).toBe("Renamed");
    expect(again.chapterName).toBe("Chapter 1");
    // The original favorite date survives: the user favorited this page once, not twice.
    expect(again.favoritedAt).toBe(1_000);
  });

  test("re-favoriting preserves collection memberships", async () => {
    const { lib } = makeLibrary();
    const collection = await lib.createFavoriteCollection("Panels");
    const page = await lib.favoritePage(coord(), { seriesTitle: "Series One" });
    await lib.setFavoritePageCollections(page.id, [collection.id]);

    const again = await lib.favoritePage(coord(), { seriesTitle: "Series One" });
    expect(again.collectionIds).toEqual([collection.id]);
  });

  test("records the client-supplied content hash — the re-anchor key", async () => {
    const { lib } = makeLibrary();
    const page = await lib.favoritePage(coord(), {
      seriesTitle: "S",
      sourceUrl: "https://cdn.example/0.png",
      contentHash: "abc123",
    });
    expect(page).toMatchObject({ sourceUrl: "https://cdn.example/0.png", contentHash: "abc123" });
  });

  test("distinct pages of the same chapter are distinct favorites", async () => {
    const { lib } = makeLibrary();
    await lib.favoritePage(coord({ pageIndex: 0 }), { seriesTitle: "S" });
    await lib.favoritePage(coord({ pageIndex: 1 }), { seriesTitle: "S" });
    expect(await lib.getFavoritePages()).toHaveLength(2);
  });

  test("unfavoriting returns the removed record, and is idempotent", async () => {
    const { lib } = makeLibrary();
    await lib.favoritePage(coord(), { seriesTitle: "S" });

    expect((await lib.unfavoritePage(coord()))?.seriesTitle).toBe("S");
    expect(await lib.getFavoritePages()).toEqual([]);
    // Removing again is a no-op, not an error — a double-tap must not throw.
    expect(await lib.unfavoritePage(coord())).toBeUndefined();
  });
});

describe("getFavoritePageIndices", () => {
  test("returns only the requested chapter's indices, ascending", async () => {
    const { lib } = makeLibrary();
    for (const pageIndex of [5, 1, 3]) await lib.favoritePage(coord({ pageIndex }), { seriesTitle: "S" });
    await lib.favoritePage(coord({ chapterId: "c2", pageIndex: 9 }), { seriesTitle: "S" });
    await lib.favoritePage(coord({ seriesId: "s2", pageIndex: 7 }), { seriesTitle: "Other" });

    expect(await lib.getFavoritePageIndices("demo", "s1", "c1")).toEqual([1, 3, 5]);
    expect(await lib.getFavoritePageIndices("demo", "s1", "c2")).toEqual([9]);
  });

  test("is empty for a chapter with no favorites", async () => {
    const { lib } = makeLibrary();
    expect(await lib.getFavoritePageIndices("demo", "s1", "nope")).toEqual([]);
  });

  test("handles the chapterless-series sentinel like any other chapter id", async () => {
    const { lib } = makeLibrary();
    await lib.favoritePage(coord({ chapterId: "__direct__", pageIndex: 2 }), { seriesTitle: "S" });
    expect(await lib.getFavoritePageIndices("demo", "s1", "__direct__")).toEqual([2]);
  });
});

describe("getFavoritePages — filter and sort", () => {
  /** Three favorites across two series, favorited oldest-to-newest in listed order. */
  async function seed() {
    const { lib, tick } = makeLibrary();
    const zebra = await lib.favoritePage(coord({ seriesId: "s2", chapterId: "c9", pageIndex: 4 }), {
      seriesTitle: "Zebra Tales",
      chapterName: "Ch 9",
    });
    tick();
    const alpha1 = await lib.favoritePage(coord({ chapterId: "c2", pageIndex: 1 }), {
      seriesTitle: "Alpha Comic",
      chapterName: "Ch 2",
    });
    tick();
    const alpha2 = await lib.favoritePage(coord({ chapterId: "c1", pageIndex: 7 }), {
      seriesTitle: "Alpha Comic",
      chapterName: "Ch 1",
    });
    return { lib, zebra, alpha1, alpha2 };
  }

  test("defaults to newest favorited first", async () => {
    const { lib, zebra, alpha1, alpha2 } = await seed();
    expect((await lib.getFavoritePages()).map((p) => p.id)).toEqual([alpha2.id, alpha1.id, zebra.id]);
  });

  test("sort=oldest reverses the date axis", async () => {
    const { lib, zebra, alpha1, alpha2 } = await seed();
    expect((await lib.getFavoritePages({ sort: "oldest" })).map((p) => p.id)).toEqual([
      zebra.id,
      alpha1.id,
      alpha2.id,
    ]);
  });

  test("sort=series groups by series title, newest first within a series", async () => {
    const { lib, zebra, alpha1, alpha2 } = await seed();
    expect((await lib.getFavoritePages({ sort: "series" })).map((p) => p.id)).toEqual([
      alpha2.id,
      alpha1.id,
      zebra.id,
    ]);
  });

  test("sort=chapter is reading order: series, then chapter, then page", async () => {
    const { lib, zebra, alpha1, alpha2 } = await seed();
    // alpha2 is Ch 1 but was favorited LAST — reading order must beat the date axis here.
    expect((await lib.getFavoritePages({ sort: "chapter" })).map((p) => p.id)).toEqual([
      alpha2.id,
      alpha1.id,
      zebra.id,
    ]);
  });

  test("filters by series via its entryKey", async () => {
    const { lib, alpha1, alpha2 } = await seed();
    const got = await lib.getFavoritePages({ series: "demo:s1" });
    expect(got.map((p) => p.id).sort()).toEqual([alpha1.id, alpha2.id].sort());
    expect(await lib.getFavoritePages({ series: "demo:nope" })).toEqual([]);
  });

  test("q matches series title and chapter name, case-insensitively", async () => {
    const { lib, zebra } = await seed();
    expect((await lib.getFavoritePages({ q: "zeBRa" })).map((p) => p.id)).toEqual([zebra.id]);
    expect((await lib.getFavoritePages({ q: "ch 9" })).map((p) => p.id)).toEqual([zebra.id]);
    expect(await lib.getFavoritePages({ q: "nothing" })).toEqual([]);
  });

  test("filters by collection, and by the 'uncollected' sentinel", async () => {
    const { lib, alpha1, alpha2, zebra } = await seed();
    const panels = await lib.createFavoriteCollection("Panels");
    await lib.setFavoritePageCollections(alpha1.id, [panels.id]);

    expect((await lib.getFavoritePages({ collection: panels.id })).map((p) => p.id)).toEqual([alpha1.id]);
    expect((await lib.getFavoritePages({ collection: UNCOLLECTED })).map((p) => p.id).sort()).toEqual(
      [alpha2.id, zebra.id].sort(),
    );
  });

  test("combines filters", async () => {
    const { lib, alpha1 } = await seed();
    const got = await lib.getFavoritePages({ series: "demo:s1", q: "Ch 2" });
    expect(got.map((p) => p.id)).toEqual([alpha1.id]);
  });

  test("is empty, not an error, with nothing favorited", async () => {
    const { lib } = makeLibrary();
    expect(await lib.getFavoritePages({ sort: "series", q: "x" })).toEqual([]);
  });
});

describe("favorite collections", () => {
  test("create assigns increasing order; the list comes back ordered", async () => {
    const { lib } = makeLibrary();
    const a = await lib.createFavoriteCollection("A");
    const b = await lib.createFavoriteCollection("B");
    expect([a.order, b.order]).toEqual([0, 1]);
    expect((await lib.getFavoriteCollections()).map((c) => c.name)).toEqual(["A", "B"]);
  });

  test("rename changes the name in place", async () => {
    const { lib } = makeLibrary();
    const a = await lib.createFavoriteCollection("A");
    await lib.renameFavoriteCollection(a.id, "Renamed");
    expect((await lib.getFavoriteCollections())[0]).toMatchObject({ id: a.id, name: "Renamed", order: 0 });
  });

  test("renaming an unknown collection throws", async () => {
    const { lib } = makeLibrary();
    expect(lib.renameFavoriteCollection("nope", "X")).rejects.toThrow("favorite collection not found: nope");
  });

  test("reorder applies the given order — the client's whole-list drag", async () => {
    const { lib } = makeLibrary();
    const a = await lib.createFavoriteCollection("A");
    const b = await lib.createFavoriteCollection("B");
    const c = await lib.createFavoriteCollection("C");
    await lib.reorderFavoriteCollections([c.id, b.id, a.id]);
    expect((await lib.getFavoriteCollections()).map((x) => x.name)).toEqual(["C", "B", "A"]);
  });

  test("reorder leaves collections not named in the list at their existing order", async () => {
    // Behavioural parity with `reorderLists`: a PARTIAL list only repositions what it names, so an
    // omitted collection keeps its old `order` and may end up tied. Clients send the whole list.
    const { lib } = makeLibrary();
    const a = await lib.createFavoriteCollection("A");
    const b = await lib.createFavoriteCollection("B");
    const c = await lib.createFavoriteCollection("C");
    await lib.reorderFavoriteCollections([c.id, a.id]);
    const byId = new Map((await lib.getFavoriteCollections()).map((x) => [x.id, x.order]));
    expect(byId.get(c.id)).toBe(0);
    expect(byId.get(a.id)).toBe(1);
    expect(byId.get(b.id)).toBe(1); // untouched — still where it was
  });

  test("setFavoritePageCollections replaces memberships and drops unknown ids", async () => {
    const { lib } = makeLibrary();
    const a = await lib.createFavoriteCollection("A");
    const b = await lib.createFavoriteCollection("B");
    const page = await lib.favoritePage(coord(), { seriesTitle: "S" });

    await lib.setFavoritePageCollections(page.id, [a.id, b.id]);
    expect((await lib.getFavoritePage(page.id))?.collectionIds.sort()).toEqual([a.id, b.id].sort());

    const next = await lib.setFavoritePageCollections(page.id, [b.id, "ghost", b.id]);
    expect(next.collectionIds).toEqual([b.id]); // deduped, unknown dropped
  });

  test("setting collections on an unknown favorite throws", async () => {
    const { lib } = makeLibrary();
    expect(lib.setFavoritePageCollections("demo:s1:c1:0", [])).rejects.toThrow("favorite page not found");
  });

  test("deleting a collection strips it from members but KEEPS the favorites", async () => {
    const { lib } = makeLibrary();
    const a = await lib.createFavoriteCollection("A");
    const b = await lib.createFavoriteCollection("B");
    const p1 = await lib.favoritePage(coord({ pageIndex: 0 }), { seriesTitle: "S" });
    const p2 = await lib.favoritePage(coord({ pageIndex: 1 }), { seriesTitle: "S" });
    await lib.setFavoritePageCollections(p1.id, [a.id, b.id]);
    await lib.setFavoritePageCollections(p2.id, [a.id]);

    await lib.deleteFavoriteCollection(a.id);

    expect((await lib.getFavoriteCollections()).map((c) => c.id)).toEqual([b.id]);
    expect(await lib.getFavoritePages()).toHaveLength(2); // nothing deleted
    expect((await lib.getFavoritePage(p1.id))?.collectionIds).toEqual([b.id]);
    expect((await lib.getFavoritePage(p2.id))?.collectionIds).toEqual([]);
    // ...and they now show up as uncollected rather than vanishing from the browser.
    expect((await lib.getFavoritePages({ collection: UNCOLLECTED })).map((p) => p.id)).toEqual([p2.id]);
  });

  test("deleting an unknown collection is a no-op", async () => {
    const { lib } = makeLibrary();
    await lib.createFavoriteCollection("A");
    await lib.deleteFavoriteCollection("ghost");
    expect(await lib.getFavoriteCollections()).toHaveLength(1);
  });
});

describe("independence from the library", () => {
  test("a page can be favorited from a series that was never added to the library", async () => {
    const { lib } = makeLibrary();
    await lib.favoritePage(coord(), { seriesTitle: "Never Added" });
    expect(await lib.isInLibrary("demo:s1")).toBe(false);
    expect(await lib.getFavoritePages()).toHaveLength(1);
  });

  test("removing the series from the library leaves its favorites alone", async () => {
    const { lib } = makeLibrary();
    await lib.addSeries({ bridgeId: "demo", seriesId: "s1", title: "Series One" });
    await lib.favoritePage(coord(), { seriesTitle: "Series One" });
    await lib.removeSeries("demo:s1");
    expect(await lib.getFavoritePages()).toHaveLength(1);
  });
});

/**
 * Chapter drift. A favorite is located by `(bridge, series, chapter, pageIndex)` and sources mutate
 * chapters underneath it — a page inserted at the front shifts every index after it, a re-upload can
 * replace the chapter wholesale. `reconcileChapterFavorites` is what stops those favorites from
 * silently pointing at the wrong page.
 */
describe("reconcileChapterFavorites", () => {
  const p = (sourceUrl: string, contentHash?: string) => ({ sourceUrl, ...(contentHash && { contentHash }) });

  /** Page 2 of a 4-page chapter, with both re-anchor signals recorded. Callers pass a narrower
   *  snapshot to test what happens when a signal is missing. */
  const BOTH_SIGNALS: FavoritePageSnapshot = {
    seriesTitle: "S",
    pageCount: 4,
    sourceUrl: "https://cdn/p2.png",
    contentHash: "hash-p2",
  };
  const URL_ONLY: FavoritePageSnapshot = { seriesTitle: "S", pageCount: 4, sourceUrl: "https://cdn/p2.png" };
  const NO_SIGNALS: FavoritePageSnapshot = { seriesTitle: "S", pageCount: 4 };

  async function seedFavorite(snap: FavoritePageSnapshot = BOTH_SIGNALS) {
    const { lib } = makeLibrary();
    const fav = await lib.favoritePage(coord({ pageIndex: 2 }), snap);
    return { lib, fav };
  }

  test("an unchanged chapter verifies every favorite and repairs nothing", async () => {
    const { lib } = await seedFavorite();
    const res = await lib.reconcileChapterFavorites("demo", "s1", "c1", [
      p("https://cdn/p0.png", "hash-p0"),
      p("https://cdn/p1.png", "hash-p1"),
      p("https://cdn/p2.png", "hash-p2"),
      p("https://cdn/p3.png", "hash-p3"),
    ]);
    expect(res).toEqual({ indices: [2], repaired: 0, stale: 0 });
  });

  test("a page inserted at the front shifts the favorite, and the hash relocates it", async () => {
    const { lib, fav } = await seedFavorite();
    const res = await lib.reconcileChapterFavorites("demo", "s1", "c1", [
      p("https://cdn/new.png", "hash-new"),
      p("https://cdn/p0.png", "hash-p0"),
      p("https://cdn/p1.png", "hash-p1"),
      p("https://cdn/p2.png", "hash-p2"), // was index 2, now 3
      p("https://cdn/p3.png", "hash-p3"),
    ]);
    expect(res).toEqual({ indices: [3], repaired: 1, stale: 0 });

    // The record is RE-KEYED, because the id is derived from the coordinates.
    expect(await lib.getFavoritePage(fav.id)).toBeUndefined();
    const moved = await lib.getFavoritePage(favoritePageId(coord({ pageIndex: 3 })));
    expect(moved).toMatchObject({ pageIndex: 3, pageCount: 5, contentHash: "hash-p2" });
  });

  test("the hash relocates a page even when its URL has rotted", async () => {
    const { lib } = await seedFavorite();
    const res = await lib.reconcileChapterFavorites("demo", "s1", "c1", [
      p("https://cdn2/signed?a=1", "hash-p0"),
      p("https://cdn2/signed?a=2", "hash-p2"), // same bytes, brand new URL, moved to index 1
      p("https://cdn2/signed?a=3", "hash-p3"),
    ]);
    expect(res).toEqual({ indices: [1], repaired: 1, stale: 0 });
    // The rotted URL is refreshed from the fresh list, so the cheap signal works next time too.
    expect((await lib.getFavoritePage(favoritePageId(coord({ pageIndex: 1 }))))?.sourceUrl).toBe(
      "https://cdn2/signed?a=2",
    );
  });

  test("without a hash, a matching URL still relocates the favorite for free", async () => {
    const { lib } = await seedFavorite(URL_ONLY);
    const res = await lib.reconcileChapterFavorites("demo", "s1", "c1", [
      p("https://cdn/new.png"),
      p("https://cdn/p0.png"),
      p("https://cdn/p1.png"),
      p("https://cdn/p2.png"),
    ]);
    expect(res).toEqual({ indices: [3], repaired: 1, stale: 0 });
  });

  test("a favorite with no hash adopts one, so the NEXT reconcile survives URL rot", async () => {
    const { lib } = await seedFavorite(URL_ONLY);
    await lib.reconcileChapterFavorites("demo", "s1", "c1", [
      p("https://cdn/p0.png", "hash-p0"),
      p("https://cdn/p1.png", "hash-p1"),
      p("https://cdn/p2.png", "hash-p2"),
      p("https://cdn/p3.png", "hash-p3"),
    ]);
    expect((await lib.getFavoritePage(favoritePageId(coord({ pageIndex: 2 }))))?.contentHash).toBe("hash-p2");
  });

  test("a re-encoded re-upload can't be matched — the favorite goes stale, not deleted", async () => {
    const { lib, fav } = await seedFavorite();
    const res = await lib.reconcileChapterFavorites("demo", "s1", "c1", [
      p("https://cdn/v2-p0.png", "hash-v2-p0"),
      p("https://cdn/v2-p1.png", "hash-v2-p1"),
      p("https://cdn/v2-p2.png", "hash-v2-p2"), // same page, re-encoded → different bytes
    ]);
    expect(res).toEqual({ indices: [], repaired: 0, stale: 1 });

    // Kept, with its snapshot intact — the user favorited it deliberately.
    const kept = await lib.getFavoritePage(fav.id);
    expect(kept).toMatchObject({ stale: true, seriesTitle: "S" });
    expect(await lib.getFavoritePages()).toHaveLength(1);
  });

  test("a stale favorite stops being reported as a favorited index", async () => {
    const { lib } = await seedFavorite();
    await lib.reconcileChapterFavorites("demo", "s1", "c1", [p("https://cdn/other.png", "hash-other")]);
    // The reader must not highlight or navigate to a page we can't vouch for.
    expect(await lib.getFavoritePageIndices("demo", "s1", "c1")).toEqual([]);
  });

  test("a source reverting a bad re-upload heals the favorite", async () => {
    const { lib, fav } = await seedFavorite();
    await lib.reconcileChapterFavorites("demo", "s1", "c1", [p("https://cdn/v2.png", "hash-v2")]);
    expect((await lib.getFavoritePage(fav.id))?.stale).toBe(true);

    await lib.reconcileChapterFavorites("demo", "s1", "c1", [
      p("https://cdn/p0.png", "hash-p0"),
      p("https://cdn/p1.png", "hash-p1"),
      p("https://cdn/p2.png", "hash-p2"),
    ]);
    const healed = await lib.getFavoritePage(fav.id);
    expect(healed?.stale).toBeUndefined();
    expect(await lib.getFavoritePageIndices("demo", "s1", "c1")).toEqual([2]);
  });

  test("an empty page list is treated as a failed fetch, never as an emptied chapter", async () => {
    // Trusting it would mark the user's entire chapter stale on one transient network error.
    const { lib } = await seedFavorite();
    const res = await lib.reconcileChapterFavorites("demo", "s1", "c1", []);
    expect(res).toEqual({ indices: [2], repaired: 0, stale: 0 });
    expect((await lib.getFavoritePage(favoritePageId(coord({ pageIndex: 2 }))))?.stale).toBeUndefined();
  });

  test("with no signals at all, the index is trusted only while the page count holds", async () => {
    const { lib } = await seedFavorite(NO_SIGNALS);
    // Same length → assume unchanged.
    expect(await lib.reconcileChapterFavorites("demo", "s1", "c1", [{}, {}, {}, {}])).toEqual({
      indices: [2],
      repaired: 0,
      stale: 0,
    });
    // Different length → "unknown" must not read as "unchanged".
    expect(await lib.reconcileChapterFavorites("demo", "s1", "c1", [{}, {}])).toEqual({
      indices: [],
      repaired: 0,
      stale: 1,
    });
  });

  test("only the named chapter is touched", async () => {
    const { lib } = await seedFavorite();
    const other = await lib.favoritePage(coord({ chapterId: "c2", pageIndex: 0 }), {
      seriesTitle: "S",
      contentHash: "hash-other",
    });
    await lib.reconcileChapterFavorites("demo", "s1", "c1", [p("https://cdn/x.png", "hash-x")]);
    expect((await lib.getFavoritePage(other.id))?.stale).toBeUndefined();
  });

  test("reconciling a chapter with no favorites is a no-op", async () => {
    const { lib } = makeLibrary();
    expect(await lib.reconcileChapterFavorites("demo", "s1", "c1", [p("https://cdn/p0.png")])).toEqual({
      indices: [],
      repaired: 0,
      stale: 0,
    });
  });

  test("two favorites relocating onto one page merge instead of colliding", async () => {
    // A chapter that de-duplicated a repeated page: both favorites now name the same index, and the
    // derived id means they'd overwrite each other. The merge must not drop either's collections.
    const { lib } = makeLibrary();
    const dupes = await lib.createFavoriteCollection("Dupes");
    const keep = await lib.createFavoriteCollection("Keep");
    const a = await lib.favoritePage(coord({ pageIndex: 1 }), { seriesTitle: "S", contentHash: "same" });
    const b = await lib.favoritePage(coord({ pageIndex: 2 }), { seriesTitle: "S", contentHash: "same" });
    await lib.setFavoritePageCollections(a.id, [dupes.id]);
    await lib.setFavoritePageCollections(b.id, [keep.id]);

    const res = await lib.reconcileChapterFavorites("demo", "s1", "c1", [p("https://cdn/p0.png", "same")]);
    expect(res.indices).toEqual([0]);

    const merged = await lib.getFavoritePages();
    expect(merged).toHaveLength(1);
    expect(merged[0]!.collectionIds.sort()).toEqual([dupes.id, keep.id].sort());
    expect(merged[0]!.favoritedAt).toBe(1_000); // the earlier of the two
  });
});
