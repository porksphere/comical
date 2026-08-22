/** The Library domain service over the in-memory store: collection, read state, sync, lists. */
import { describe, expect, test } from "bun:test";
import type { Chapter } from "@comical/contract";
import { entryKey, InMemoryLibraryStore, Library, normalizeTitle } from "../src/index.ts";

const SERIES = { bridgeId: "demo", seriesId: "s1", title: "Series One" };
const COORD = { bridgeId: SERIES.bridgeId, seriesId: SERIES.seriesId };
const SNAP = { seriesTitle: SERIES.title };
const KEY = entryKey(SERIES.bridgeId, SERIES.seriesId);

/** A monotonic clock so history/order assertions are deterministic. */
function fakeClock() {
  let t = 1_000;
  return () => ++t;
}

const ch = (id: string, number: number): Chapter => ({ id, name: `Ch ${number}`, number });

/** A chapter from a specific scanlation group + language — for multi-copy ("logical chapter") tests. */
const chg = (id: string, number: number, group: string, languageCode: string): Chapter => ({
  id,
  name: `Ch ${number} [${group}]`,
  number,
  group,
  languageCode,
});

function makeLibrary() {
  return new Library(new InMemoryLibraryStore(), { now: fakeClock() });
}

describe("collection", () => {
  test("collect / isCollected / remove (progress survives the removal)", async () => {
    const lib = makeLibrary();
    expect(await lib.isCollected(KEY)).toBe(false);
    await lib.collectSeries(COORD, SNAP);
    expect(await lib.isCollected(KEY)).toBe(true);

    await lib.markRead(KEY, "c1", true);
    expect(await lib.getProgress(KEY)).toHaveLength(1);

    await lib.removeSeries(KEY);
    expect(await lib.isCollected(KEY)).toBe(false);
    // Read state outlives the collection — only resetProgress destroys it.
    expect(await lib.getProgress(KEY)).toHaveLength(1);
    await lib.resetProgress(KEY);
    expect(await lib.getProgress(KEY)).toHaveLength(0);
  });

  test("re-collecting keeps the original collectedAt but refreshes the title", async () => {
    const lib = makeLibrary();
    const first = await lib.collectSeries(COORD, SNAP);
    const again = await lib.collectSeries(COORD, { seriesTitle: "Renamed" });
    expect(again.item.collectedAt).toBe(first.item.collectedAt);
    expect(again.item.seriesTitle).toBe("Renamed");
  });
});

describe("offline metadata cache", () => {
  test("cacheSeriesDetail stores the full SeriesInfo for a library entry; no-op otherwise", async () => {
    const lib = makeLibrary();
    const info = { id: "s1", title: "Series One", description: "A tale.", author: "A. Author", genres: ["Fantasy"] };

    await lib.cacheSeriesDetail(KEY, info); // not in library yet
    await lib.collectSeries(COORD, SNAP);
    expect(await lib.getCachedDetail(KEY)).toBeUndefined();

    await lib.cacheSeriesDetail(KEY, info);
    const cached = await lib.getCachedDetail(KEY);
    expect(cached?.info.description).toBe("A tale.");
    expect(cached?.cachedAt).toBeGreaterThan(0);
  });

  test("syncChapters writes the full renderable chapter list through to the cache", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2)]);

    const cached = await lib.getCachedChapters(KEY);
    expect(cached?.chapters.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(cached?.chapters[0]?.name).toBe("Ch 1"); // full Chapter, not the slim KnownChapter projection
  });

  test("a detail refresh preserves the coverFile pointer; setCachedCover records it", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.cacheSeriesDetail(KEY, { id: "s1", title: "Series One" });

    await lib.setCachedCover(KEY, "demo/s1.jpg");
    expect((await lib.getCachedDetail(KEY))?.coverFile).toBe("demo/s1.jpg");

    // Browsing rewrites the detail doc — the captured cover must survive it.
    await lib.cacheSeriesDetail(KEY, { id: "s1", title: "Series One", description: "fresh" });
    const after = await lib.getCachedDetail(KEY);
    expect(after?.info.description).toBe("fresh");
    expect(after?.coverFile).toBe("demo/s1.jpg");
  });

  test("setCachedCover records the source URL; cacheSeriesDetail preserves both cover fields", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.cacheSeriesDetail(KEY, { id: "s1", title: "Series One" });
    await lib.setCachedCover(KEY, "demo/s1.jpg", "https://cdn.example/cover-v1.jpg");

    await lib.cacheSeriesDetail(KEY, { id: "s1", title: "Series One", description: "fresh" });
    const after = await lib.getCachedDetail(KEY);
    expect(after?.coverFile).toBe("demo/s1.jpg");
    expect(after?.coverSourceUrl).toBe("https://cdn.example/cover-v1.jpg");
  });

  test("refreshSnapshot reconciles changed display fields and merges externalIds", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, { seriesTitle: "Old Title", author: "Old Author", externalIds: { anilist: 1 } });

    await lib.refreshSnapshot(KEY, {
      id: "s1",
      title: "New Title",
      thumbnailUrl: "https://cdn.example/new-cover.jpg",
      author: "New Author",
      externalIds: { mal: 42 },
    });
    const entry = await lib.getSeries(KEY);
    expect(entry?.seriesTitle).toBe("New Title");
    expect(entry?.thumbnailUrl).toBe("https://cdn.example/new-cover.jpg");
    expect(entry?.author).toBe("New Author");
    expect(entry?.externalIds).toEqual({ anilist: 1, mal: 42 }); // merged, never removed
  });

  test("refreshSnapshot is a no-op when nothing changed (updatedAt untouched) or not in library", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, { ...SNAP, author: "A. Author" });
    const before = await lib.getSeries(KEY);

    await lib.refreshSnapshot(KEY, { id: "s1", title: SERIES.title, author: "A. Author" });
    expect((await lib.getSeries(KEY))?.updatedAt).toBe(before!.updatedAt);

    await lib.refreshSnapshot("demo:not-added", { id: "x", title: "X" }); // must not throw or create
    expect(await lib.getSeries("demo:not-added")).toBeUndefined();
  });

  test("setCachedCover is a no-op without a detail doc", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.setCachedCover(KEY, "demo/s1.jpg");
    expect(await lib.getCachedDetail(KEY)).toBeUndefined();
  });

  test("removeSeries cascades away both cached docs", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.cacheSeriesDetail(KEY, { id: "s1", title: "Series One" });
    await lib.syncChapters(KEY, [ch("c1", 1)]);

    await lib.removeSeries(KEY);
    expect(await lib.getCachedDetail(KEY)).toBeUndefined();
    expect(await lib.getCachedChapters(KEY)).toBeUndefined();
  });

  test("a schema-drifted persisted doc is discarded, not served", async () => {
    const store = new InMemoryLibraryStore();
    const lib = new Library(store, { now: fakeClock() });
    await lib.collectSeries(COORD, SNAP);
    // Simulate an old/corrupt doc written by a previous version.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await store.putSeriesDetail(KEY, { info: { notATitle: true }, cachedAt: "soon" } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await store.putCachedChapters(KEY, { chapters: [{ bogus: 1 }] } as any);

    expect(await lib.getCachedDetail(KEY)).toBeUndefined();
    expect(await lib.getCachedChapters(KEY)).toBeUndefined();
  });
});

describe("read state", () => {
  test("markReadUpTo marks all earlier chapters in reading order, regardless of input order", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    // Supplied newest-first, as many backends do.
    const chapters = [ch("c3", 3), ch("c2", 2), ch("c1", 1)];
    await lib.markReadUpTo(KEY, chapters, "c2");
    const read = new Set((await lib.getProgress(KEY)).filter((p) => p.read).map((p) => p.chapterId));
    expect(read).toEqual(new Set(["c1", "c2"]));
  });

  test("setProgress auto-marks read at the last page only", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);

    await lib.setProgress(KEY, "c1", 5, 20);
    expect((await lib.getProgress(KEY)).find((p) => p.chapterId === "c1")?.read).toBe(false);

    await lib.setProgress(KEY, "c1", 19, 20);
    expect((await lib.getProgress(KEY)).find((p) => p.chapterId === "c1")?.read).toBe(true);
  });

  test("getResume points at the last-read chapter and page", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.setProgress(KEY, "c1", 7, 20);
    expect(await lib.getResume(KEY)).toEqual({ chapterId: "c1", lastPage: 7 });
  });
});

describe("reconcileRead (external pull)", () => {
  test("marks read flags WITHOUT moving the resume pointer or recency", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    // User is reading locally at chapter 1 (page 3, not finished → c1 not yet read).
    await lib.setProgress(KEY, "c1", 3, 20, "Ch 1");
    const before = await lib.getSeries(KEY);

    // A tracker says chapters 1–3 are read — reconcile them in.
    const marked = await lib.reconcileRead(KEY, [
      { chapterId: "c1", number: 1 },
      { chapterId: "c2", number: 2 },
      { chapterId: "c3", number: 3 },
    ]);
    expect(marked.marked).toBe(3);

    const after = await lib.getSeries(KEY);
    // Resume + recency are sacred: even reconciling chapters AHEAD must not move the pointer.
    expect(after?.lastReadChapterId).toBe("c1");
    expect(after?.lastReadChapterId).toBe(before?.lastReadChapterId);
    expect(after?.lastReadAt).toBe(before?.lastReadAt);
    expect(await lib.getResume(KEY)).toEqual({ chapterId: "c1", lastPage: 3 });
    // But the read flags ARE now set, and c1's page progress is preserved.
    const read = new Set((await lib.getProgress(KEY)).filter((p) => p.read).map((p) => p.chapterId));
    expect(read).toEqual(new Set(["c1", "c2", "c3"]));
  });

  test("is union — never un-reads an already-read chapter", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.markRead(KEY, "c5", true, "Ch 5", 5);
    // A pull that doesn't include c5 must leave it read.
    await lib.reconcileRead(KEY, [{ chapterId: "c1", number: 1 }]);
    const read = new Set((await lib.getProgress(KEY)).filter((p) => p.read).map((p) => p.chapterId));
    expect(read).toEqual(new Set(["c1", "c5"]));
  });

  test("maxReadChapterNumber returns the highest read number, decimals and out-of-order included", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.reconcileRead(KEY, [
      { chapterId: "c10", number: 10 },
      { chapterId: "c2", number: 2 },
      { chapterId: "c10_5", number: 10.5 },
    ]);
    expect(await lib.maxReadChapterNumber(KEY)).toBe(10.5);
  });

  test("maxReadChapterNumber falls back to the read count when no numbers are recorded", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.markRead(KEY, "c1", true); // no number supplied
    await lib.markRead(KEY, "c2", true);
    expect(await lib.maxReadChapterNumber(KEY)).toBe(2);
  });
});

describe("getSeriesCompletion", () => {
  /** Add the series, sync `chapters`, cache a detail with `status`, and mark `read` chapters read. */
  async function seed(opts: { chapters: Chapter[]; status?: string; read?: Chapter[] }) {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, opts.chapters);
    if (opts.status) {
      await lib.cacheSeriesDetail(KEY, { id: "s1", title: "Series One", status: opts.status as never });
    }
    for (const c of opts.read ?? []) await lib.markRead(KEY, c.id, true, c.name, c.number);
    return lib;
  }

  test("the BLAME! shape: fractional extras don't stop a fully-read completed series", async () => {
    // The reported bug's exact data: 67 rows numbered 1–65 plus 3.5 and 7.5, all read. The highest
    // read NUMBER is 65 while the tracker's own total is 66, so any number-based completion check
    // fails here. Completion is decided by unread count, which is 0.
    const chapters = [
      ...Array.from({ length: 65 }, (_, i) => ch(`c${i + 1}`, i + 1)),
      ch("c3_5", 3.5),
      ch("c7_5", 7.5),
    ];
    const lib = await seed({ chapters, status: "completed", read: chapters });

    expect(await lib.maxReadChapterNumber(KEY)).toBe(65);
    expect(await lib.getSeriesCompletion(KEY)).toEqual({
      fullyRead: true,
      seriesStatus: "completed",
      seriesFinished: true,
    });
  });

  test("fully read but still ongoing is caught up, not finished", async () => {
    const chapters = [ch("c1", 1), ch("c2", 2)];
    const lib = await seed({ chapters, status: "ongoing", read: chapters });
    expect(await lib.getSeriesCompletion(KEY)).toEqual({
      fullyRead: true,
      seriesStatus: "ongoing",
      seriesFinished: false,
    });
  });

  test("hiatus is not finished — a paused series can resume", async () => {
    const chapters = [ch("c1", 1)];
    const lib = await seed({ chapters, status: "hiatus", read: chapters });
    expect(await lib.getSeriesCompletion(KEY)).toMatchObject({ fullyRead: true, seriesFinished: false });
  });

  test("cancelled counts as finished — it will gain no more chapters", async () => {
    const chapters = [ch("c1", 1)];
    const lib = await seed({ chapters, status: "cancelled", read: chapters });
    expect(await lib.getSeriesCompletion(KEY)).toMatchObject({ fullyRead: true, seriesFinished: true });
  });

  test("one unread chapter is not fully read", async () => {
    const chapters = [ch("c1", 1), ch("c2", 2)];
    const lib = await seed({ chapters, status: "completed", read: [chapters[0]!] });
    expect(await lib.getSeriesCompletion(KEY)).toMatchObject({ fullyRead: false, seriesFinished: true });
  });

  test("no cached detail reads as unknown status, never finished", async () => {
    const chapters = [ch("c1", 1)];
    const lib = await seed({ chapters, read: chapters });
    expect(await lib.getSeriesCompletion(KEY)).toEqual({
      fullyRead: true,
      seriesStatus: "unknown",
      seriesFinished: false,
    });
  });

  test("an entry with no synced chapters is NOT fully read, even though 0 are unread", async () => {
    // The dangerous false positive: a favourites import seeds an entry with an empty chapter list,
    // which would otherwise read as "nothing left to read" the instant it's added.
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.cacheSeriesDetail(KEY, { id: "s1", title: "Series One", status: "completed" });
    expect(await lib.getSeriesCompletion(KEY)).toMatchObject({ fullyRead: false, seriesFinished: true });

    // An explicit sync of an empty list is still not evidence of a finished read.
    await lib.syncChapters(KEY, []);
    expect(await lib.getSeriesCompletion(KEY)).toMatchObject({ fullyRead: false });
  });

  test("two scanlation copies of one chapter count as read when either is read", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, [chg("a5", 5, "GroupA", "en"), chg("b5", 5, "GroupB", "en")]);
    await lib.cacheSeriesDetail(KEY, { id: "s1", title: "Series One", status: "completed" });
    await lib.markRead(KEY, "a5", true, "Ch 5", 5);
    expect(await lib.getSeriesCompletion(KEY)).toMatchObject({ fullyRead: true, seriesFinished: true });
  });

  test("a series not in the library resolves rather than throwing", async () => {
    const lib = makeLibrary();
    expect(await lib.getSeriesCompletion(KEY)).toEqual({
      fullyRead: false,
      seriesStatus: "unknown",
      seriesFinished: false,
    });
  });
});

describe("new-chapter detection", () => {
  test("first sync establishes a baseline (no 'added'); later syncs report new chapters", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);

    const first = await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2)]);
    expect(first.added).toHaveLength(0);

    const second = await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2), ch("c3", 3)]);
    expect(second.added.map((c) => c.id)).toEqual(["c3"]);
  });

  test("unreadCount = known chapters without a read record", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2), ch("c3", 3)]);
    await lib.markRead(KEY, "c1", true);

    const view = (await lib.getLibrary()).find((e) => e.seriesId === "s1");
    expect(view?.unreadCount).toBe(2);
  });
});

describe("source revision (batch update-check baseline)", () => {
  const entryOf = async (lib: Library) => (await lib.getLibrary()).find((e) => e.seriesId === "s1")!;

  test("syncChapters stores the revision the list came with", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, [ch("c1", 1)], { latestChapterId: "c1", chapterCount: 1 });

    expect((await entryOf(lib)).revision).toEqual({ latestChapterId: "c1", chapterCount: 1 });
  });

  test("a sync with no revision clears any stored one", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, [ch("c1", 1)], { latestChapterId: "c1" });
    // A later sync through a path that doesn't know the revision (a series-page refresh, a bridge
    // that dropped the capability): the stored fingerprint no longer describes what we hold, so
    // keeping it could make a future check match and skip a fetch that never happened.
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2)]);

    expect((await entryOf(lib)).revision).toBeUndefined();
  });

  test("markChaptersUnchanged bumps the sync time without touching the chapter list", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2)], { chapterCount: 2 });
    const before = await entryOf(lib);

    // The suite's clock is monotonic per call, so the bump is observable without a real sleep.
    await lib.markChaptersUnchanged(KEY, { chapterCount: 2 });
    const after = await entryOf(lib);

    expect(after.chaptersSyncedAt!).toBeGreaterThan(before.chaptersSyncedAt!);
    expect(after.knownChapters.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(after.unreadCount).toBe(before.unreadCount);
  });

  test("markChaptersUnchanged records no activity — nothing happened", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, [ch("c1", 1)], { chapterCount: 1 });
    const before = (await lib.getActivity()).length;

    await lib.markChaptersUnchanged(KEY, { chapterCount: 1 });
    expect((await lib.getActivity()).length).toBe(before);
  });
});

describe("activity feed", () => {
  test("the baseline sync records nothing; later syncs record one item per new chapter", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);

    await lib.syncChapters(KEY, [ch("c1", 1)]);
    expect(await lib.getActivity()).toHaveLength(0);

    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2), ch("c3", 3)]);
    const feed = await lib.getActivity();
    // Newest first by detectedAt (both detected in the same sync — stable by detection order is fine,
    // here both share the sync timestamp so just assert the set of chapters and snapshot fields).
    expect(feed.map((a) => a.chapterId).sort()).toEqual(["c2", "c3"]);
    const c2 = feed.find((a) => a.chapterId === "c2")!;
    expect(c2).toMatchObject({ bridgeId: "demo", seriesId: "s1", title: "Series One", chapterName: "Ch 2", number: 2 });
    expect(c2.detectedAt).toBeGreaterThan(0);
    expect(c2.read).toBe(false);
  });

  test("a partial baseline does not flood the feed with the back-catalogue", async () => {
    // Reproduces the real bug: the first sync sees an incomplete list (here, empty), so the diff
    // alone would flag every pre-existing chapter as "new" on the next fuller sync. Gating on
    // publish time keeps the back-catalogue (published before the series was added) out of the feed.
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP); // addedAt = 1001 (fakeClock)

    await lib.syncChapters(KEY, []); // partial/empty baseline
    // Fuller sync arrives: many old chapters (published long before add) plus one fresh release.
    const old = [1, 2, 3].map((n) => ({ id: `c${n}`, name: `Ch ${n}`, number: n, publishedAt: 500 }));
    const fresh = { id: "c4", name: "Ch 4", number: 4, publishedAt: 9_000 };
    const { added } = await lib.syncChapters(KEY, [...old, fresh]);

    expect(added.map((c) => c.id)).toEqual(["c4"]);
    expect((await lib.getActivity()).map((a) => a.chapterId)).toEqual(["c4"]);
    // The back-catalogue is still tracked for unread counts — just not surfaced as activity.
    expect((await lib.getLibrary())[0]?.unreadCount).toBe(4);
  });

  test("chapters without a publish date fall back to the diff (still detected)", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, [ch("c1", 1)]); // baseline (ch() omits publishedAt)
    const { added } = await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2)]);
    expect(added.map((c) => c.id)).toEqual(["c2"]);
    expect((await lib.getActivity()).map((a) => a.chapterId)).toEqual(["c2"]);
  });

  test("feed is newest-first across syncs", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, [ch("c1", 1)]); // baseline
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2)]); // c2 detected first
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2), ch("c3", 3)]); // c3 detected later
    expect((await lib.getActivity()).map((a) => a.chapterId)).toEqual(["c3", "c2"]);
  });

  test("reading a chapter flips its item to read and drops the unread count", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, [ch("c1", 1)]);
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2), ch("c3", 3)]);
    expect(await lib.unreadActivityCount()).toBe(2);

    await lib.markRead(KEY, "c2", true);
    expect(await lib.unreadActivityCount()).toBe(1);
    expect((await lib.getActivity()).find((a) => a.chapterId === "c2")?.read).toBe(true);
  });

  test("unreadOnly and limit filter the feed", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, [ch("c1", 1)]);
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2), ch("c3", 3), ch("c4", 4)]);
    await lib.markRead(KEY, "c2", true);

    expect((await lib.getActivity({ unreadOnly: true })).map((a) => a.chapterId).sort()).toEqual(["c3", "c4"]);
    expect(await lib.getActivity({ limit: 1 })).toHaveLength(1);
  });

  test("removeSeries purges its activity; clearActivity empties the feed", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, [ch("c1", 1)]);
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2)]);
    expect(await lib.getActivity()).toHaveLength(1);

    await lib.removeSeries(KEY);
    expect(await lib.getActivity()).toHaveLength(0);

    // And clearActivity wipes whatever remains.
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, [ch("c1", 1)]);
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2)]);
    expect(await lib.getActivity()).toHaveLength(1);
    await lib.clearActivity();
    expect(await lib.getActivity()).toHaveLength(0);
  });

  test("clearActivityForEntry drops one series' feed items, leaving others", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.collectSeries({ bridgeId: "demo", seriesId: "s2" }, { seriesTitle: "Series Two" });
    // s1 gets two new chapters (coalesced into one Activity row), s2 gets one.
    await lib.syncChapters(KEY, [ch("c1", 1)]);
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2), ch("c3", 3)]);
    await lib.syncChapters(entryKey("demo", "s2"), [ch("b1", 1)]);
    await lib.syncChapters(entryKey("demo", "s2"), [ch("b1", 1), ch("b2", 2)]);
    expect(await lib.getActivity()).toHaveLength(3); // c2, c3, b2

    await lib.clearActivityForEntry("demo", "s1");
    const remaining = await lib.getActivity();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.seriesId).toBe("s2");
  });

  test("markActivityRead flips one series' feed items read without touching resume/history", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.collectSeries({ bridgeId: "demo", seriesId: "s2" }, { seriesTitle: "Series Two" });
    await lib.syncChapters(KEY, [ch("c1", 1)]);
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2), ch("c3", 3)]);
    await lib.syncChapters(entryKey("demo", "s2"), [ch("b1", 1)]);
    await lib.syncChapters(entryKey("demo", "s2"), [ch("b1", 1), ch("b2", 2)]);
    expect(await lib.unreadActivityCount()).toBe(3);

    const { marked } = await lib.markActivityRead("demo", "s1");
    expect(marked).toBe(2);

    // s1's items stay in the feed, now read; s2's item is untouched.
    const feed = await lib.getActivity();
    expect(feed.filter((a) => a.seriesId === "s1").every((a) => a.read)).toBe(true);
    expect(feed.find((a) => a.seriesId === "s2")?.read).toBe(false);
    expect(await lib.unreadActivityCount()).toBe(1);

    // Dismissing is not reading: no resume point, no history entry.
    expect(await lib.getResume(KEY)).toBeUndefined();
    expect(await lib.getHistory()).toHaveLength(0);

    // Union semantics: a second pass has nothing left to mark.
    expect((await lib.markActivityRead("demo", "s1")).marked).toBe(0);
  });

  test("since keeps only items detected strictly after the watermark", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, [ch("c1", 1)]); // baseline
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2)]);
    const c2At = (await lib.getActivity()).find((a) => a.chapterId === "c2")!.detectedAt;
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2), ch("c3", 3)]);

    // Watermark exactly at c2's detection: c2 is "seen" (boundary excluded), only c3 is newer.
    expect((await lib.getActivity({ since: c2At })).map((a) => a.chapterId)).toEqual(["c3"]);
    expect(await lib.unreadActivityCount(c2At)).toBe(1);
    // Reading c3 empties the since-window count while the plain count still sees c2.
    await lib.markRead(KEY, "c3", true);
    expect(await lib.unreadActivityCount(c2At)).toBe(0);
    expect(await lib.unreadActivityCount()).toBe(1);
  });

  test("pruneActivity caps the feed at the newest N", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, [ch("c1", 1)]); // baseline
    for (let n = 2; n <= 5; n++) {
      // One sync per chapter so each item gets its own (monotonic) detectedAt.
      await lib.syncChapters(KEY, Array.from({ length: n }, (_, i) => ch(`c${i + 1}`, i + 1)));
    }
    expect(await lib.getActivity()).toHaveLength(4);

    expect(await lib.pruneActivity(2)).toBe(2);
    expect((await lib.getActivity()).map((a) => a.chapterId)).toEqual(["c5", "c4"]);
    // Under the cap: no-op.
    expect(await lib.pruneActivity(2)).toBe(0);
    expect(await lib.getActivity()).toHaveLength(2);
  });
});

describe("logical chapters (multi-scanlator / multi-language)", () => {
  test("unreadCount collapses scanlator copies of one (number, language) but counts languages apart", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, [
      chg("c1-a", 1, "A", "en"), // ch1 EN, group A
      chg("c1-b", 1, "B", "en"), // ch1 EN, group B — same logical chapter as c1-a
      chg("c2-a", 2, "A", "en"), // ch2 EN
      chg("c1-es", 1, "A", "es"), // ch1 ES — a distinct logical chapter
    ]);

    const unread = async () => (await lib.getLibrary()).find((e) => e.seriesId === "s1")?.unreadCount;
    // Logical chapters: (1,en), (2,en), (1,es) → 3 unread despite 4 raw chapters.
    expect(await unread()).toBe(3);

    // Reading ONE scanlator copy of ch1 EN marks the whole logical chapter read.
    await lib.markRead(KEY, "c1-a", true);
    expect(await unread()).toBe(2); // ch1 EN now read; ch2 EN + ch1 ES remain
  });

  test("syncChapters: a new scanlator copy of a known chapter is not 'new'; a new number/language is", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, [chg("c1-a", 1, "A", "en")]); // baseline

    const r1 = await lib.syncChapters(KEY, [
      chg("c1-a", 1, "A", "en"),
      chg("c1-b", 1, "B", "en"), // same logical (1,en) — not new
      chg("c2-a", 2, "A", "en"), // new number — new
    ]);
    expect(r1.added.map((c) => c.id)).toEqual(["c2-a"]);

    const r2 = await lib.syncChapters(KEY, [
      chg("c1-a", 1, "A", "en"),
      chg("c1-b", 1, "B", "en"),
      chg("c2-a", 2, "A", "en"),
      chg("c1-es", 1, "A", "es"), // same number, different language — new logical chapter
    ]);
    expect(r2.added.map((c) => c.id)).toEqual(["c1-es"]);
  });

  test("activity: reading any scanlator copy flips the logical chapter's feed item to read", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, [chg("c1-a", 1, "A", "en")]); // baseline
    await lib.syncChapters(KEY, [
      chg("c1-a", 1, "A", "en"),
      chg("c2-a", 2, "A", "en"),
      chg("c2-b", 2, "B", "en"), // same logical (2,en) as c2-a — not a separate feed item
    ]);

    const feed = await lib.getActivity();
    expect(feed.map((a) => a.chapterId)).toEqual(["c2-a"]);
    expect(feed[0]?.read).toBe(false);

    // Reading the OTHER group's copy still clears the item — it's the same logical chapter.
    await lib.markRead(KEY, "c2-b", true);
    expect((await lib.getActivity()).find((a) => a.chapterId === "c2-a")?.read).toBe(true);
    expect(await lib.unreadActivityCount()).toBe(0);
  });

  test("markReadUpTo stays within the target's language and covers every group of those chapters", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    const chapters = [
      chg("c1-en", 1, "A", "en"),
      chg("c1b-en", 1, "B", "en"), // second group of ch1 EN
      chg("c2-en", 2, "A", "en"),
      chg("c1-es", 1, "A", "es"), // different language — must stay untouched
    ];
    await lib.markReadUpTo(KEY, chapters, "c2-en");
    const read = new Set((await lib.getProgress(KEY)).filter((p) => p.read).map((p) => p.chapterId));
    expect(read).toEqual(new Set(["c1-en", "c1b-en", "c2-en"]));
  });

  test("a chapter with no number stays its own logical unit", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.syncChapters(KEY, [
      { id: "x1", name: "Oneshot" },
      { id: "x2", name: "Extra" },
    ]);
    const unread = async () => (await lib.getLibrary()).find((e) => e.seriesId === "s1")?.unreadCount;
    expect(await unread()).toBe(2);
    await lib.markRead(KEY, "x1", true);
    expect(await unread()).toBe(1);
  });
});

describe("history", () => {
  test("getHistory is newest-first and one row per series", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.collectSeries({ bridgeId: "demo", seriesId: "s2" }, { seriesTitle: "Series Two" });

    await lib.markRead(entryKey("demo", "s2"), "x1", true);
    await lib.markRead(KEY, "c1", true); // s1 read more recently
    await lib.markRead(KEY, "c2", true);

    const history = await lib.getHistory();
    expect(history.map((h) => h.seriesId)).toEqual(["s1", "s2"]);
  });
});

describe("collections filter the library", () => {
  // The old library "lists" retired into collections: memberships live on SERIES favorite items,
  // and getLibrary reads through them. Filing a series = collectSeries + collection membership.
  const file = (lib: Library, seriesId: string, collectionIds: string[]) =>
    lib.collectSeries({ bridgeId: "demo", seriesId }, { seriesTitle: seriesId, collectionIds });

  test("filing a series into a collection filters the library by it", async () => {
    const lib = makeLibrary();
    const reading = await lib.createCollection("Reading");
    await lib.collectSeries(COORD, SNAP);
    await lib.collectSeries({ bridgeId: "demo", seriesId: "s2" }, { seriesTitle: "Two" });
    await file(lib, "s1", [reading.id]);

    const inReading = await lib.getLibrary({ collection: reading.id });
    expect(inReading.map((e) => e.seriesId)).toEqual(["s1"]);
  });

  test("deleting a collection un-files its members, and the empty series item is pruned", async () => {
    const lib = makeLibrary();
    const temp = await lib.createCollection("Temp");
    await lib.collectSeries(COORD, SNAP);
    await file(lib, "s1", [temp.id]);

    await lib.deleteCollection(temp.id);
    expect(await lib.getCollections()).toHaveLength(0);
    expect(await lib.getLibrary({ collection: temp.id })).toHaveLength(0);
    // The series existed only as a member, so losing its last one removes it outright — under
    // pure collections there is no library entry left behind to hold it.
    expect(await lib.getCollectionItems({ type: "series" })).toHaveLength(0);
    expect(await lib.getSeries(KEY)).toBeUndefined();
    // And the cascade took its satellites with it (see Library.removeSeries).
    expect(await lib.getProgress(KEY)).toHaveLength(0);
  });
});

describe("getLibrary query (search / sort / filters)", () => {
  /**
   * Three series with distinct titles/authors/collections/unread counts, added in s1→s2→s3 order:
   *  - s1 "Naruto"  (Kishimoto) — Action           — 2 unread
   *  - s2 "Bleach"             — Action + Romance  — 0 unread (only chapter read)
   *  - s3 "Berserk" (Miura)    — uncollected       — 1 unread
   */
  async function seeded() {
    const lib = makeLibrary();
    const action = await lib.createCollection("Action");
    const romance = await lib.createCollection("Romance");
    const file = (seriesId: string, title: string, collectionIds: string[]) =>
      lib.collectSeries({ bridgeId: "demo", seriesId }, { seriesTitle: title, collectionIds });

    await lib.collectSeries({ bridgeId: "demo", seriesId: "s1" }, { seriesTitle: "Naruto", author: "Kishimoto" });
    await file("s1", "Naruto", [action.id]);
    await lib.syncChapters(entryKey("demo", "s1"), [ch("a1", 1), ch("a2", 2)]);

    await lib.collectSeries({ bridgeId: "demo", seriesId: "s2" }, { seriesTitle: "Bleach" });
    await file("s2", "Bleach", [action.id, romance.id]);
    await lib.syncChapters(entryKey("demo", "s2"), [ch("b1", 1)]);
    await lib.markRead(entryKey("demo", "s2"), "b1", true);

    await lib.collectSeries({ bridgeId: "demo", seriesId: "s3" }, { seriesTitle: "Berserk", author: "Miura" });
    await lib.syncChapters(entryKey("demo", "s3"), [ch("k1", 1)]);

    return { lib, action, romance };
  }
  const ids = (entries: { seriesId: string }[]) => entries.map((e) => e.seriesId);

  test("q matches title (case-insensitive substring)", async () => {
    const { lib } = await seeded();
    expect(ids(await lib.getLibrary({ q: "BER" }))).toEqual(["s3"]);
  });

  test("q also matches author", async () => {
    const { lib } = await seeded();
    expect(ids(await lib.getLibrary({ q: "miura" }))).toEqual(["s3"]);
  });

  test("unreadOnly drops fully-read entries", async () => {
    const { lib } = await seeded();
    expect(ids(await lib.getLibrary({ unreadOnly: true })).sort()).toEqual(["s1", "s3"]);
  });

  test("sort=title is ascending A–Z", async () => {
    const { lib } = await seeded();
    expect((await lib.getLibrary({ sort: "title" })).map((e) => e.seriesTitle)).toEqual(["Berserk", "Bleach", "Naruto"]);
  });

  test("sort=unread defaults to descending (most unread first)", async () => {
    const { lib } = await seeded();
    expect(ids(await lib.getLibrary({ sort: "unread" }))).toEqual(["s1", "s3", "s2"]);
  });

  test("dir overrides the default direction", async () => {
    const { lib } = await seeded();
    expect(ids(await lib.getLibrary({ sort: "added", dir: "asc" }))).toEqual(["s1", "s2", "s3"]);
  });

  test("collections filters to ANY of the given collections", async () => {
    const { lib, action, romance } = await seeded();
    expect(ids(await lib.getLibrary({ collections: [romance.id] }))).toEqual(["s2"]);
    expect(ids(await lib.getLibrary({ collections: [action.id, romance.id], sort: "title" }))).toEqual(["s2", "s1"]);
  });

  test("uncollected returns only entries in no collection, taking precedence over collections", async () => {
    const { lib, action } = await seeded();
    expect(ids(await lib.getLibrary({ uncollected: true }))).toEqual(["s3"]);
    expect(ids(await lib.getLibrary({ uncollected: true, collections: [action.id] }))).toEqual(["s3"]);
  });

  test("filters compose (search + unreadOnly + sort)", async () => {
    const { lib } = await seeded();
    // "e" matches Berserk + Bleach; unreadOnly drops fully-read Bleach.
    expect(ids(await lib.getLibrary({ q: "e", unreadOnly: true, sort: "title" }))).toEqual(["s3"]);
  });
});

describe("guards", () => {
  test("mutating a series that is not collected throws", async () => {
    const lib = makeLibrary();
    await expect(lib.markRead(KEY, "c1", true)).rejects.toThrow("series not collected");
  });
});

describe("series grouping via generic externalIds", () => {
  test("adding two entries with the same externalId auto-links them", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, { ...SNAP, externalIds: { mal: 12345 } });
    const r2 = await lib.collectSeries({ bridgeId: "example-bridge", seriesId: "md-1" }, { seriesTitle: "Series One", externalIds: { mal: 12345 } });
    expect(r2.autoLinked).toBeDefined();
    expect(r2.autoLinked?.sharedId.service).toBe("mal");
    expect(r2.autoLinked?.sharedId.value).toBe(12345);
  });

  test("entries with different externalIds do not auto-link", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, { ...SNAP, externalIds: { mal: 1 } });
    const r2 = await lib.collectSeries({ bridgeId: "alt", seriesId: "s2" }, { seriesTitle: "Other", externalIds: { mal: 2 } });
    expect(r2.autoLinked).toBeUndefined();
  });
});

describe("title matching (normalizeTitle / titleIndex)", () => {
  test("case, punctuation, whitespace and diacritics all fold away", () => {
    expect(normalizeTitle("Chainsaw-Man!")).toBe(normalizeTitle("Chainsaw Man"));
    expect(normalizeTitle("  SPY×FAMILY  ")).toBe(normalizeTitle("Spy x Family"));
    expect(normalizeTitle("Pokémon")).toBe(normalizeTitle("Pokemon"));
  });

  test("distinguishing suffixes are NOT stripped — a false merge is worse than a miss", () => {
    expect(normalizeTitle("Berserk (2016)")).not.toBe(normalizeTitle("Berserk"));
    expect(normalizeTitle("Fruits Basket: Another")).not.toBe(normalizeTitle("Fruits Basket"));
  });

  test("fullwidth forms fold to their halfwidth equivalents", () => {
    expect(normalizeTitle("Ｃｈａｉｎｓａｗ　Ｍａｎ")).toBe(normalizeTitle("Chainsaw Man"));
  });

  test("non-latin scripts keep their characters — including dakuten", () => {
    expect(normalizeTitle("「ベルセルク」")).toBe("ベルセルク");
    // The NFKD decomposition would otherwise strip the voiced-sound marks and merge these.
    expect(normalizeTitle("ベルセルク")).not.toBe(normalizeTitle("ヘルセルク"));
    expect(normalizeTitle("パンプン")).not.toBe(normalizeTitle("ハンフン"));
  });

  test("a title with no alphanumeric content yields no key", () => {
    expect(normalizeTitle("!!! ---")).toBe("");
  });

  test("titleIndex buckets entries across bridges and omits keyless titles", async () => {
    const lib = makeLibrary();
    await lib.collectSeries({ bridgeId: "a", seriesId: "1" }, { seriesTitle: "Chainsaw Man" });
    await lib.collectSeries({ bridgeId: "b", seriesId: "2" }, { seriesTitle: "chainsaw-man" });
    await lib.collectSeries({ bridgeId: "a", seriesId: "3" }, { seriesTitle: "Berserk" });
    await lib.collectSeries({ bridgeId: "a", seriesId: "4" }, { seriesTitle: "???" });

    const index = await lib.titleIndex();
    expect(index.get(normalizeTitle("Chainsaw Man"))?.map((e) => e.bridgeId).sort()).toEqual(["a", "b"]);
    expect(index.get(normalizeTitle("Berserk"))).toHaveLength(1);
    expect(index.has("")).toBe(false);
  });
});

describe("linkEntries", () => {
  const A = { bridgeId: "a", seriesId: "1" };
  const B = { bridgeId: "b", seriesId: "2" };
  const C = { bridgeId: "c", seriesId: "3" };
  const SHARED = { seriesTitle: "Shared" };
  const kA = entryKey(A.bridgeId, A.seriesId);
  const kB = entryKey(B.bridgeId, B.seriesId);
  const kC = entryKey(C.bridgeId, C.seriesId);

  test("creates a group with the EXISTING entry as primary", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(A, SHARED);
    await lib.collectSeries(B, SHARED);
    await lib.linkEntries(kA, kB);

    const group = await lib.getGroup(kB);
    expect(group?.primaryKey).toBe(kA);
    expect(group?.memberKeys.sort()).toEqual([kA, kB].sort());
    // Both entries carry the back-pointer.
    expect((await lib.getSeries(kA))?.seriesGroupId).toBe(group!.id);
  });

  test("a third source joins the existing group rather than starting a new one", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(A, SHARED);
    await lib.collectSeries(B, SHARED);
    await lib.collectSeries(C, SHARED);
    await lib.linkEntries(kA, kB);
    await lib.linkEntries(kA, kC);

    expect(await lib.listGroups()).toHaveLength(1);
    const group = await lib.getGroup(kC);
    expect(group?.memberKeys.sort()).toEqual([kA, kB, kC].sort());
    expect(group?.primaryKey).toBe(kA);
  });

  test("linking a key to itself is a no-op; an unknown target throws", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(A, SHARED);
    await lib.linkEntries(kA, kA);
    expect(await lib.listGroups()).toHaveLength(0);
    await expect(lib.linkEntries("nope:1", kA)).rejects.toThrow("series not collected");
  });
});

describe("reading log (non-library history)", () => {
  test("recordRead appears in getHistory when series is not in library", async () => {
    const lib = makeLibrary();
    await lib.recordRead({ bridgeId: "demo", seriesId: "ext1", title: "External Series", lastReadAt: 1000 });

    const history = await lib.getHistory();
    expect(history.some((h) => h.seriesId === "ext1")).toBe(true);
  });

  test("library entry takes precedence over log for same series", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.markRead(KEY, "c1", true);
    await lib.recordRead({ bridgeId: SERIES.bridgeId, seriesId: SERIES.seriesId, title: SERIES.title, lastReadAt: 9999 });

    const history = await lib.getHistory();
    expect(history.filter((h) => h.seriesId === SERIES.seriesId)).toHaveLength(1);
  });

  test("recordRead is a no-op when series is already in library", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.markRead(KEY, "c1", true); // gives it a lastReadAt so it appears in history
    await lib.recordRead({ bridgeId: SERIES.bridgeId, seriesId: SERIES.seriesId, title: SERIES.title, lastReadAt: 9999 });

    // Exactly one entry — library wins, log entry is not persisted separately
    const history = await lib.getHistory();
    expect(history.filter((h) => h.seriesId === SERIES.seriesId)).toHaveLength(1);
  });

  test("getResume reads the page from the reading log for a non-library series", async () => {
    const lib = makeLibrary();
    await lib.recordRead({
      bridgeId: "demo", seriesId: "ext1", title: "External Series",
      lastReadChapterId: "c2", lastReadChapterName: "Ch 2", lastPage: 12, lastReadAt: 1000,
    });
    expect(await lib.getResume(entryKey("demo", "ext1"))).toEqual({ chapterId: "c2", lastPage: 12 });
  });

  test("getResume falls back to page 0 when the log entry has no recorded page", async () => {
    const lib = makeLibrary();
    await lib.recordRead({
      bridgeId: "demo", seriesId: "ext1", title: "External Series",
      lastReadChapterId: "c2", lastReadAt: 1000,
    });
    expect(await lib.getResume(entryKey("demo", "ext1"))).toEqual({ chapterId: "c2", lastPage: 0 });
  });

  test("getHistory carries the page and page count for a non-library read", async () => {
    const lib = makeLibrary();
    await lib.recordRead({
      bridgeId: "demo", seriesId: "ext1", title: "External Series",
      lastReadChapterId: "c2", lastPage: 13, pageCount: 20, lastReadAt: 1000,
    });
    const item = (await lib.getHistory()).find((h) => h.seriesId === "ext1");
    expect(item?.lastPage).toBe(13);
    expect(item?.pageCount).toBe(20);
  });

  test("getHistory fills the page and page count from progress for a library read", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.setProgress(KEY, "c1", 5, 20, "Ch 1");
    const item = (await lib.getHistory()).find((h) => h.seriesId === SERIES.seriesId);
    expect(item?.lastReadChapterId).toBe("c1");
    expect(item?.lastPage).toBe(5);
    expect(item?.pageCount).toBe(20);
  });

  test("re-recording a non-library read updates the resume page", async () => {
    const lib = makeLibrary();
    await lib.recordRead({
      bridgeId: "demo", seriesId: "ext1", title: "External Series",
      lastReadChapterId: "c1", lastPage: 3, lastReadAt: 1000,
    });
    await lib.recordRead({
      bridgeId: "demo", seriesId: "ext1", title: "External Series",
      lastReadChapterId: "c1", lastPage: 9, lastReadAt: 2000,
    });
    expect(await lib.getResume(entryKey("demo", "ext1"))).toEqual({ chapterId: "c1", lastPage: 9 });
  });

  test("getResume returns undefined for an unknown series", async () => {
    const lib = makeLibrary();
    expect(await lib.getResume(entryKey("demo", "nope"))).toBeUndefined();
  });

  test("clearHistoryEntry removes a log-only series from history", async () => {
    const lib = makeLibrary();
    await lib.recordRead({ bridgeId: "demo", seriesId: "ext1", title: "External Series", lastReadAt: 1000 });
    await lib.clearHistoryEntry("demo", "ext1");

    const history = await lib.getHistory();
    expect(history.some((h) => h.seriesId === "ext1")).toBe(false);
  });

  test("clearHistoryEntry removes a library series from history without removing it from library", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.markRead(KEY, "c1", true);
    await lib.clearHistoryEntry(SERIES.bridgeId, SERIES.seriesId);

    const history = await lib.getHistory();
    expect(history.some((h) => h.seriesId === SERIES.seriesId)).toBe(false);

    const library = await lib.getLibrary();
    expect(library.some((e) => e.seriesId === SERIES.seriesId)).toBe(true);
  });
});

describe("tracker links", () => {
  test("link / list / update / unlink", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);

    await lib.linkTracker(KEY, "anilist", 98765);
    const links = await lib.listTrackerLinks(KEY);
    expect(links).toHaveLength(1);
    expect(links[0]?.trackerId).toBe("anilist");
    expect(links[0]?.externalId).toBe(98765);

    await lib.updateTrackerLink(KEY, "anilist", { chaptersRead: 5, lastSyncAt: 2000 });
    const updated = await lib.getTrackerLink(KEY, "anilist");
    expect(updated?.chaptersRead).toBe(5);

    await lib.unlinkTracker(KEY, "anilist");
    expect(await lib.listTrackerLinks(KEY)).toHaveLength(0);
  });

  test("linking a different tracker id adds a second link", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.linkTracker(KEY, "anilist", 1);
    await lib.linkTracker(KEY, "mal", 2);
    expect(await lib.listTrackerLinks(KEY)).toHaveLength(2);
  });

  test("relinking the same tracker updates the externalId", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.linkTracker(KEY, "anilist", 1);
    await lib.linkTracker(KEY, "anilist", 99);
    const links = await lib.listTrackerLinks(KEY);
    expect(links).toHaveLength(1);
    expect(links[0]?.externalId).toBe(99);
  });
});

describe("bridge prefs", () => {
  test("returns defaults when no prefs stored", async () => {
    const lib = makeLibrary();
    const prefs = await lib.getBridgePrefs("demo");
    expect(prefs.bridgeId).toBe("demo");
    expect(prefs.trackersDisabled).toBe(false);
    expect(prefs.historyDisabled).toBe(false);
  });

  test("set trackersDisabled then read it back", async () => {
    const lib = makeLibrary();
    await lib.setBridgePrefs("demo", { trackersDisabled: true });
    expect((await lib.getBridgePrefs("demo")).trackersDisabled).toBe(true);
  });

  test("set historyDisabled then read it back", async () => {
    const lib = makeLibrary();
    await lib.setBridgePrefs("demo", { historyDisabled: true });
    expect((await lib.getBridgePrefs("demo")).historyDisabled).toBe(true);
  });

  test("a partial update leaves the other flag untouched", async () => {
    const lib = makeLibrary();
    await lib.setBridgePrefs("demo", { trackersDisabled: true });
    await lib.setBridgePrefs("demo", { historyDisabled: true });
    const prefs = await lib.getBridgePrefs("demo");
    expect(prefs.trackersDisabled).toBe(true);
    expect(prefs.historyDisabled).toBe(true);
  });

  test("prefs are per-bridge — different bridges are independent", async () => {
    const lib = makeLibrary();
    await lib.setBridgePrefs("bridge-a", { trackersDisabled: true });
    expect((await lib.getBridgePrefs("bridge-b")).trackersDisabled).toBe(false);
  });
});

describe("history tracking opt-out", () => {
  test("recordRead is suppressed for a bridge with history disabled", async () => {
    const lib = makeLibrary();
    await lib.setBridgePrefs("demo", { historyDisabled: true });
    await lib.recordRead({ bridgeId: "demo", seriesId: "ext1", title: "External Series", lastReadAt: 1000 });
    expect(await lib.getHistory()).toHaveLength(0);
  });

  test("getHistory hides library reads from a bridge with history disabled", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.markRead(KEY, "c1", true);
    expect((await lib.getHistory()).some((h) => h.seriesId === SERIES.seriesId)).toBe(true);

    await lib.setBridgePrefs(SERIES.bridgeId, { historyDisabled: true });
    expect(await lib.getHistory()).toHaveLength(0);
  });

  test("disabling history for one bridge leaves another bridge's history intact", async () => {
    const lib = makeLibrary();
    await lib.recordRead({ bridgeId: "muted", seriesId: "a", title: "A", lastReadAt: 1000 });
    await lib.recordRead({ bridgeId: "kept", seriesId: "b", title: "B", lastReadAt: 2000 });
    await lib.setBridgePrefs("muted", { historyDisabled: true });

    const history = await lib.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.bridgeId).toBe("kept");
  });

  test("re-enabling history restores previously-hidden library reads", async () => {
    const lib = makeLibrary();
    await lib.collectSeries(COORD, SNAP);
    await lib.markRead(KEY, "c1", true);
    await lib.setBridgePrefs(SERIES.bridgeId, { historyDisabled: true });
    expect(await lib.getHistory()).toHaveLength(0);

    await lib.setBridgePrefs(SERIES.bridgeId, { historyDisabled: false });
    expect((await lib.getHistory()).some((h) => h.seriesId === SERIES.seriesId)).toBe(true);
  });
});

/**
 * The library dissolving into collections is the one place this project migrates data. It earns the
 * exception because everything a series owns EXCEPT its entry row is keyed by `entryKey` in a
 * separate document and survived untouched — so rebuilding the series items reattaches progress,
 * tracker links, caches and groups that are otherwise orphaned forever.
 */
describe("importLegacyEntries", () => {
  const legacy = (over: Record<string, unknown> = {}) => ({
    bridgeId: "demo",
    seriesId: "s1",
    title: "Series One",
    addedAt: 500,
    updatedAt: 600,
    knownChapters: [{ id: "c1", number: 1 }],
    ...over,
  });

  test("rebuilds a series item and reattaches the orphaned progress behind it", async () => {
    const store = new InMemoryLibraryStore();
    const lib = new Library(store, { now: fakeClock() });
    // Progress written before the dissolution outlives its entry — it is keyed by entryKey, not by
    // anything in the entries document.
    await store.putProgress(KEY, { chapterId: "c1", read: true, number: 1, updatedAt: 1 });

    const result = await lib.importLegacyEntries([legacy()]);
    expect(result).toMatchObject({ imported: 1, skipped: 0 });

    const item = await lib.getSeries(KEY);
    expect(item).toMatchObject({ seriesTitle: "Series One", collectedAt: 500, updatedAt: 600 });
    expect(item?.collectionIds).toEqual([result.collectionId]);
    // The whole point: the library renders again AND the read state is back on it.
    const view = (await lib.getLibrary()).find((v) => v.seriesId === "s1");
    expect(view?.unreadCount).toBe(0);
    expect(await lib.getProgress(KEY)).toHaveLength(1);
  });

  test("carries the tracking machinery across, not just the display fields", async () => {
    const lib = makeLibrary();
    await lib.importLegacyEntries([
      legacy({
        thumbnailUrl: "https://cdn.example/c.png",
        author: "A. Author",
        lastReadChapterId: "c1",
        lastReadChapterName: "Ch 1",
        lastReadAt: 550,
        chaptersSyncedAt: 540,
        externalIds: { anilist: 7 },
      }),
    ]);
    expect(await lib.getSeries(KEY)).toMatchObject({
      thumbnailUrl: "https://cdn.example/c.png",
      author: "A. Author",
      lastReadChapterId: "c1",
      lastReadAt: 550,
      chaptersSyncedAt: 540,
      externalIds: { anilist: 7 },
    });
    expect(await lib.getResume(KEY)).toBeDefined();
  });

  test("files everything into one collection, reused on a second run", async () => {
    const lib = makeLibrary();
    const first = await lib.importLegacyEntries([legacy()]);
    const second = await lib.importLegacyEntries([legacy({ seriesId: "s2" })]);
    expect(second.collectionId).toBe(first.collectionId);
    expect(await lib.getCollections()).toHaveLength(1);
    expect((await lib.getLibrary({ collection: first.collectionId })).map((v) => v.seriesId).sort()).toEqual(["s1", "s2"]);
  });

  // A series item written by the PRE-DISSOLUTION build: a thin membership pointer with no
  // `knownChapters` and no `updatedAt`, because the tracking state lived on `LibraryEntry` then.
  // Its id did not change, so it survives a version bump untouched.
  const preDissolutionItem = (over: Record<string, unknown> = {}) =>
    ({
      type: "series",
      id: "series:demo:s1",
      bridgeId: "demo",
      seriesId: "s1",
      seriesTitle: "Filed Before",
      collectedAt: 100,
      collectionIds: ["c-existing"],
      ...over,
    }) as never;

  test("upgrades a pre-dissolution series item instead of skipping it", async () => {
    const store = new InMemoryLibraryStore();
    const lib = new Library(store, { now: fakeClock() });
    await store.putCollections([{ id: "c-existing", name: "Reading", order: 0 }]);
    await store.putCollectionItems([preDissolutionItem()]);

    // "Already collected" would strand it forever: it predates every tracking field the entry
    // carries, so a skip means no unread baseline and no resume point, permanently.
    const result = await lib.importLegacyEntries([legacy({ lastReadChapterId: "c1", lastReadAt: 550 })]);
    expect(result).toMatchObject({ imported: 1, skipped: 0 });

    const item = await lib.getSeries(KEY);
    expect(item?.knownChapters).toEqual([{ id: "c1", number: 1 }]);
    expect(item?.lastReadChapterId).toBe("c1");
    // The memberships and collect time came from the NEWER build — real user data, kept.
    expect(item?.collectionIds).toEqual(["c-existing"]);
    expect(item?.collectedAt).toBe(100);
  });

  test("lists a pre-dissolution item the import can't reach, rather than failing the library", async () => {
    const store = new InMemoryLibraryStore();
    const lib = new Library(store, { now: fakeClock() });
    // Filed into a collection but never in the library — a legal state before the dissolution, so
    // there is no legacy entry row to upgrade it from. One of these used to 500 `GET /library`
    // outright, taking every other series down with it.
    await store.putCollectionItems([preDissolutionItem()]);

    const views = await lib.getLibrary({ sort: "lastRead" });
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ seriesId: "s1", unreadCount: 0, updatedAt: 100 });
    expect(views[0]?.knownChapters).toEqual([]);
  });

  test("is idempotent — a re-run never clobbers the live record", async () => {
    const lib = makeLibrary();
    await lib.importLegacyEntries([legacy()]);
    await lib.collectSeries(COORD, { seriesTitle: "Renamed Since" });

    const again = await lib.importLegacyEntries([legacy()]);
    expect(again).toMatchObject({ imported: 0, skipped: 1 });
    expect((await lib.getSeries(KEY))?.seriesTitle).toBe("Renamed Since");
  });

  test("skips unparseable rows rather than failing the whole migration", async () => {
    const lib = makeLibrary();
    const result = await lib.importLegacyEntries([legacy(), { bridgeId: "demo" }, null, legacy({ seriesId: "s3" })]);
    expect(result).toMatchObject({ imported: 2, skipped: 2 });
    expect((await lib.getLibrary()).map((v) => v.seriesId).sort()).toEqual(["s1", "s3"]);
  });

  test("a bad optional field doesn't cost the whole entry", async () => {
    const lib = makeLibrary();
    const result = await lib.importLegacyEntries([legacy({ thumbnailUrl: "not-a-url", externalIds: "nonsense" })]);
    expect(result).toMatchObject({ imported: 1, skipped: 0 });
    const item = await lib.getSeries(KEY);
    expect(item?.seriesTitle).toBe("Series One");
    expect(item?.thumbnailUrl).toBeUndefined();
  });
});
