/** The Library domain service over the in-memory store: collection, read state, sync, lists. */
import { describe, expect, test } from "bun:test";
import type { Chapter } from "@comical/contract";
import { entryKey, InMemoryLibraryStore, Library } from "../src/index.ts";

const SERIES = { bridgeId: "demo", seriesId: "s1", title: "Series One" };
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
  test("add / isInLibrary / remove (clears progress)", async () => {
    const lib = makeLibrary();
    expect(await lib.isInLibrary(KEY)).toBe(false);
    await lib.addSeries(SERIES);
    expect(await lib.isInLibrary(KEY)).toBe(true);

    await lib.markRead(KEY, "c1", true);
    expect(await lib.getProgress(KEY)).toHaveLength(1);

    await lib.removeSeries(KEY);
    expect(await lib.isInLibrary(KEY)).toBe(false);
    expect(await lib.getProgress(KEY)).toHaveLength(0);
  });

  test("re-adding keeps the original addedAt but refreshes title", async () => {
    const lib = makeLibrary();
    const first = await lib.addSeries(SERIES);
    const again = await lib.addSeries({ ...SERIES, title: "Renamed" });
    expect(again.entry.addedAt).toBe(first.entry.addedAt);
    expect(again.entry.title).toBe("Renamed");
  });
});

describe("read state", () => {
  test("markReadUpTo marks all earlier chapters in reading order, regardless of input order", async () => {
    const lib = makeLibrary();
    await lib.addSeries(SERIES);
    // Supplied newest-first, as many backends do.
    const chapters = [ch("c3", 3), ch("c2", 2), ch("c1", 1)];
    await lib.markReadUpTo(KEY, chapters, "c2");
    const read = new Set((await lib.getProgress(KEY)).filter((p) => p.read).map((p) => p.chapterId));
    expect(read).toEqual(new Set(["c1", "c2"]));
  });

  test("setProgress auto-marks read at the last page only", async () => {
    const lib = makeLibrary();
    await lib.addSeries(SERIES);

    await lib.setProgress(KEY, "c1", 5, 20);
    expect((await lib.getProgress(KEY)).find((p) => p.chapterId === "c1")?.read).toBe(false);

    await lib.setProgress(KEY, "c1", 19, 20);
    expect((await lib.getProgress(KEY)).find((p) => p.chapterId === "c1")?.read).toBe(true);
  });

  test("getResume points at the last-read chapter and page", async () => {
    const lib = makeLibrary();
    await lib.addSeries(SERIES);
    await lib.setProgress(KEY, "c1", 7, 20);
    expect(await lib.getResume(KEY)).toEqual({ chapterId: "c1", lastPage: 7 });
  });
});

describe("reconcileRead (external pull)", () => {
  test("marks read flags WITHOUT moving the resume pointer or recency", async () => {
    const lib = makeLibrary();
    await lib.addSeries(SERIES);
    // User is reading locally at chapter 1 (page 3, not finished → c1 not yet read).
    await lib.setProgress(KEY, "c1", 3, 20, "Ch 1");
    const before = await lib.getEntry(KEY);

    // A tracker says chapters 1–3 are read — reconcile them in.
    const marked = await lib.reconcileRead(KEY, [
      { chapterId: "c1", number: 1 },
      { chapterId: "c2", number: 2 },
      { chapterId: "c3", number: 3 },
    ]);
    expect(marked.marked).toBe(3);

    const after = await lib.getEntry(KEY);
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
    await lib.addSeries(SERIES);
    await lib.markRead(KEY, "c5", true, "Ch 5", 5);
    // A pull that doesn't include c5 must leave it read.
    await lib.reconcileRead(KEY, [{ chapterId: "c1", number: 1 }]);
    const read = new Set((await lib.getProgress(KEY)).filter((p) => p.read).map((p) => p.chapterId));
    expect(read).toEqual(new Set(["c1", "c5"]));
  });

  test("maxReadChapterNumber returns the highest read number, decimals and out-of-order included", async () => {
    const lib = makeLibrary();
    await lib.addSeries(SERIES);
    await lib.reconcileRead(KEY, [
      { chapterId: "c10", number: 10 },
      { chapterId: "c2", number: 2 },
      { chapterId: "c10_5", number: 10.5 },
    ]);
    expect(await lib.maxReadChapterNumber(KEY)).toBe(10.5);
  });

  test("maxReadChapterNumber falls back to the read count when no numbers are recorded", async () => {
    const lib = makeLibrary();
    await lib.addSeries(SERIES);
    await lib.markRead(KEY, "c1", true); // no number supplied
    await lib.markRead(KEY, "c2", true);
    expect(await lib.maxReadChapterNumber(KEY)).toBe(2);
  });
});

describe("new-chapter detection", () => {
  test("first sync establishes a baseline (no 'added'); later syncs report new chapters", async () => {
    const lib = makeLibrary();
    await lib.addSeries(SERIES);

    const first = await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2)]);
    expect(first.added).toHaveLength(0);

    const second = await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2), ch("c3", 3)]);
    expect(second.added.map((c) => c.id)).toEqual(["c3"]);
  });

  test("unreadCount = known chapters without a read record", async () => {
    const lib = makeLibrary();
    await lib.addSeries(SERIES);
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2), ch("c3", 3)]);
    await lib.markRead(KEY, "c1", true);

    const view = (await lib.getLibrary()).find((e) => e.seriesId === "s1");
    expect(view?.unreadCount).toBe(2);
  });
});

describe("activity feed", () => {
  test("the baseline sync records nothing; later syncs record one item per new chapter", async () => {
    const lib = makeLibrary();
    await lib.addSeries(SERIES);

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
    await lib.addSeries(SERIES); // addedAt = 1001 (fakeClock)

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
    await lib.addSeries(SERIES);
    await lib.syncChapters(KEY, [ch("c1", 1)]); // baseline (ch() omits publishedAt)
    const { added } = await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2)]);
    expect(added.map((c) => c.id)).toEqual(["c2"]);
    expect((await lib.getActivity()).map((a) => a.chapterId)).toEqual(["c2"]);
  });

  test("feed is newest-first across syncs", async () => {
    const lib = makeLibrary();
    await lib.addSeries(SERIES);
    await lib.syncChapters(KEY, [ch("c1", 1)]); // baseline
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2)]); // c2 detected first
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2), ch("c3", 3)]); // c3 detected later
    expect((await lib.getActivity()).map((a) => a.chapterId)).toEqual(["c3", "c2"]);
  });

  test("reading a chapter flips its item to read and drops the unread count", async () => {
    const lib = makeLibrary();
    await lib.addSeries(SERIES);
    await lib.syncChapters(KEY, [ch("c1", 1)]);
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2), ch("c3", 3)]);
    expect(await lib.unreadActivityCount()).toBe(2);

    await lib.markRead(KEY, "c2", true);
    expect(await lib.unreadActivityCount()).toBe(1);
    expect((await lib.getActivity()).find((a) => a.chapterId === "c2")?.read).toBe(true);
  });

  test("unreadOnly and limit filter the feed", async () => {
    const lib = makeLibrary();
    await lib.addSeries(SERIES);
    await lib.syncChapters(KEY, [ch("c1", 1)]);
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2), ch("c3", 3), ch("c4", 4)]);
    await lib.markRead(KEY, "c2", true);

    expect((await lib.getActivity({ unreadOnly: true })).map((a) => a.chapterId).sort()).toEqual(["c3", "c4"]);
    expect(await lib.getActivity({ limit: 1 })).toHaveLength(1);
  });

  test("removeSeries purges its activity; clearActivity empties the feed", async () => {
    const lib = makeLibrary();
    await lib.addSeries(SERIES);
    await lib.syncChapters(KEY, [ch("c1", 1)]);
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2)]);
    expect(await lib.getActivity()).toHaveLength(1);

    await lib.removeSeries(KEY);
    expect(await lib.getActivity()).toHaveLength(0);

    // And clearActivity wipes whatever remains.
    await lib.addSeries(SERIES);
    await lib.syncChapters(KEY, [ch("c1", 1)]);
    await lib.syncChapters(KEY, [ch("c1", 1), ch("c2", 2)]);
    expect(await lib.getActivity()).toHaveLength(1);
    await lib.clearActivity();
    expect(await lib.getActivity()).toHaveLength(0);
  });
});

describe("logical chapters (multi-scanlator / multi-language)", () => {
  test("unreadCount collapses scanlator copies of one (number, language) but counts languages apart", async () => {
    const lib = makeLibrary();
    await lib.addSeries(SERIES);
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
    await lib.addSeries(SERIES);
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
    await lib.addSeries(SERIES);
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
    await lib.addSeries(SERIES);
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
    await lib.addSeries(SERIES);
    await lib.syncChapters(KEY, [
      { id: "x1", name: "Oneshot" },
      { id: "x2", name: "Extra" },
    ]);
    const unread = async () => (await lib.getLibrary()).find((e) => e.seriesId === "s1")?.unreadCount;
    expect(await unread()).toBe(2);
    await lib.markRead(KEY, "x1", true);
    expect(await unread()).toBe(1);
  });

  test("a legacy entry with no knownChapters field doesn't crash derivations", async () => {
    // Pre-`knownChapters` documents (persisted before the schema change, never re-validated by the
    // file store) lack the field entirely. Reading them must degrade gracefully, not throw.
    const store = new InMemoryLibraryStore();
    const lib = new Library(store, { now: fakeClock() });
    await store.putEntry({
      bridgeId: SERIES.bridgeId,
      seriesId: SERIES.seriesId,
      title: SERIES.title,
      addedAt: 1,
      updatedAt: 1,
      listIds: [],
      // knownChapters intentionally omitted (legacy shape)
    } as unknown as Parameters<typeof store.putEntry>[0]);

    // toView / unread derivation tolerates the missing field.
    const view = (await lib.getLibrary()).find((e) => e.seriesId === "s1");
    expect(view?.unreadCount).toBe(0);

    // A first sync then populates it and subsequent counts are logical.
    await lib.syncChapters(KEY, [chg("c1-a", 1, "A", "en"), chg("c1-b", 1, "B", "en"), chg("c2-a", 2, "A", "en")]);
    const unread = async () => (await lib.getLibrary()).find((e) => e.seriesId === "s1")?.unreadCount;
    expect(await unread()).toBe(2); // (1,en) and (2,en)
    await lib.markRead(KEY, "c1-a", true);
    expect(await unread()).toBe(1);
  });
});

describe("history", () => {
  test("getHistory is newest-first and one row per series", async () => {
    const lib = makeLibrary();
    await lib.addSeries(SERIES);
    await lib.addSeries({ bridgeId: "demo", seriesId: "s2", title: "Series Two" });

    await lib.markRead(entryKey("demo", "s2"), "x1", true);
    await lib.markRead(KEY, "c1", true); // s1 read more recently
    await lib.markRead(KEY, "c2", true);

    const history = await lib.getHistory();
    expect(history.map((h) => h.seriesId)).toEqual(["s1", "s2"]);
  });
});

describe("lists", () => {
  test("create / filter library by list", async () => {
    const lib = makeLibrary();
    const reading = await lib.createList("Reading");
    await lib.addSeries({ ...SERIES, listIds: [reading.id] });
    await lib.addSeries({ bridgeId: "demo", seriesId: "s2", title: "Two" });

    const inReading = await lib.getLibrary({ listId: reading.id });
    expect(inReading.map((e) => e.seriesId)).toEqual(["s1"]);
  });

  test("deleting a list strips it from every entry", async () => {
    const lib = makeLibrary();
    const list = await lib.createList("Temp");
    await lib.addSeries({ ...SERIES, listIds: [list.id] });

    await lib.deleteList(list.id);
    expect(await lib.getLists()).toHaveLength(0);
    expect((await lib.getEntry(KEY))?.listIds).toEqual([]);
  });

  test("createList assigns increasing order; reorder updates it", async () => {
    const lib = makeLibrary();
    const a = await lib.createList("A");
    const b = await lib.createList("B");
    expect([a.order, b.order]).toEqual([0, 1]);

    await lib.reorderLists([b.id, a.id]);
    const ordered = await lib.getLists();
    expect(ordered.map((c) => c.name)).toEqual(["B", "A"]);
  });
});

describe("getLibrary query (search / sort / filters)", () => {
  /**
   * Three series with distinct titles/authors/lists/unread counts, added in s1→s2→s3 order:
   *  - s1 "Naruto"  (Kishimoto) — Action          — 2 unread
   *  - s2 "Bleach"             — Action + Romance — 0 unread (only chapter read)
   *  - s3 "Berserk" (Miura)    — unlisted         — 1 unread
   */
  async function seeded() {
    const lib = makeLibrary();
    const action = await lib.createList("Action");
    const romance = await lib.createList("Romance");

    await lib.addSeries({ bridgeId: "demo", seriesId: "s1", title: "Naruto", author: "Kishimoto", listIds: [action.id] });
    await lib.syncChapters(entryKey("demo", "s1"), [ch("a1", 1), ch("a2", 2)]);

    await lib.addSeries({ bridgeId: "demo", seriesId: "s2", title: "Bleach", listIds: [action.id, romance.id] });
    await lib.syncChapters(entryKey("demo", "s2"), [ch("b1", 1)]);
    await lib.markRead(entryKey("demo", "s2"), "b1", true);

    await lib.addSeries({ bridgeId: "demo", seriesId: "s3", title: "Berserk", author: "Miura" });
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
    expect((await lib.getLibrary({ sort: "title" })).map((e) => e.title)).toEqual(["Berserk", "Bleach", "Naruto"]);
  });

  test("sort=unread defaults to descending (most unread first)", async () => {
    const { lib } = await seeded();
    expect(ids(await lib.getLibrary({ sort: "unread" }))).toEqual(["s1", "s3", "s2"]);
  });

  test("dir overrides the default direction", async () => {
    const { lib } = await seeded();
    expect(ids(await lib.getLibrary({ sort: "added", dir: "asc" }))).toEqual(["s1", "s2", "s3"]);
  });

  test("listIds filters to ANY of the given lists", async () => {
    const { lib, action, romance } = await seeded();
    expect(ids(await lib.getLibrary({ listIds: [romance.id] }))).toEqual(["s2"]);
    expect(ids(await lib.getLibrary({ listIds: [action.id, romance.id], sort: "title" }))).toEqual(["s2", "s1"]);
  });

  test("unlisted returns only entries with no lists, taking precedence over listIds", async () => {
    const { lib, action } = await seeded();
    expect(ids(await lib.getLibrary({ unlisted: true }))).toEqual(["s3"]);
    expect(ids(await lib.getLibrary({ unlisted: true, listIds: [action.id] }))).toEqual(["s3"]);
  });

  test("filters compose (search + unreadOnly + sort)", async () => {
    const { lib } = await seeded();
    // "e" matches Berserk + Bleach; unreadOnly drops fully-read Bleach.
    expect(ids(await lib.getLibrary({ q: "e", unreadOnly: true, sort: "title" }))).toEqual(["s3"]);
  });
});

describe("guards", () => {
  test("mutating a series not in the library throws", async () => {
    const lib = makeLibrary();
    await expect(lib.markRead(KEY, "c1", true)).rejects.toThrow("not in library");
  });
});

describe("series grouping via generic externalIds", () => {
  test("adding two entries with the same externalId auto-links them", async () => {
    const lib = makeLibrary();
    await lib.addSeries({ ...SERIES, externalIds: { mal: 12345 } });
    const r2 = await lib.addSeries({
      bridgeId: "mangadex",
      seriesId: "md-1",
      title: "Series One",
      externalIds: { mal: 12345 },
    });
    expect(r2.autoLinked).toBeDefined();
    expect(r2.autoLinked?.sharedId.service).toBe("mal");
    expect(r2.autoLinked?.sharedId.value).toBe(12345);
  });

  test("entries with different externalIds do not auto-link", async () => {
    const lib = makeLibrary();
    await lib.addSeries({ ...SERIES, externalIds: { mal: 1 } });
    const r2 = await lib.addSeries({ bridgeId: "alt", seriesId: "s2", title: "Other", externalIds: { mal: 2 } });
    expect(r2.autoLinked).toBeUndefined();
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
    await lib.addSeries(SERIES);
    await lib.markRead(KEY, "c1", true);
    await lib.recordRead({ bridgeId: SERIES.bridgeId, seriesId: SERIES.seriesId, title: SERIES.title, lastReadAt: 9999 });

    const history = await lib.getHistory();
    expect(history.filter((h) => h.seriesId === SERIES.seriesId)).toHaveLength(1);
  });

  test("recordRead is a no-op when series is already in library", async () => {
    const lib = makeLibrary();
    await lib.addSeries(SERIES);
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
    await lib.addSeries(SERIES);
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
    await lib.addSeries(SERIES);
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
    await lib.addSeries(SERIES);

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
    await lib.addSeries(SERIES);
    await lib.linkTracker(KEY, "anilist", 1);
    await lib.linkTracker(KEY, "mal", 2);
    expect(await lib.listTrackerLinks(KEY)).toHaveLength(2);
  });

  test("relinking the same tracker updates the externalId", async () => {
    const lib = makeLibrary();
    await lib.addSeries(SERIES);
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
    await lib.addSeries(SERIES);
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
    await lib.addSeries(SERIES);
    await lib.markRead(KEY, "c1", true);
    await lib.setBridgePrefs(SERIES.bridgeId, { historyDisabled: true });
    expect(await lib.getHistory()).toHaveLength(0);

    await lib.setBridgePrefs(SERIES.bridgeId, { historyDisabled: false });
    expect((await lib.getHistory()).some((h) => h.seriesId === SERIES.seriesId)).toBe(true);
  });
});
