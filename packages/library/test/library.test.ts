/** The Library domain service over the in-memory store: collection, read state, sync, categories. */
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

describe("categories", () => {
  test("create / filter library by category", async () => {
    const lib = makeLibrary();
    const reading = await lib.createCategory("Reading");
    await lib.addSeries({ ...SERIES, categoryIds: [reading.id] });
    await lib.addSeries({ bridgeId: "demo", seriesId: "s2", title: "Two" });

    const inReading = await lib.getLibrary({ categoryId: reading.id });
    expect(inReading.map((e) => e.seriesId)).toEqual(["s1"]);
  });

  test("deleting a category strips it from every entry", async () => {
    const lib = makeLibrary();
    const cat = await lib.createCategory("Temp");
    await lib.addSeries({ ...SERIES, categoryIds: [cat.id] });

    await lib.deleteCategory(cat.id);
    expect(await lib.listCategories()).toHaveLength(0);
    expect((await lib.getEntry(KEY))?.categoryIds).toEqual([]);
  });

  test("createCategory assigns increasing order; reorder updates it", async () => {
    const lib = makeLibrary();
    const a = await lib.createCategory("A");
    const b = await lib.createCategory("B");
    expect([a.order, b.order]).toEqual([0, 1]);

    await lib.reorderCategories([b.id, a.id]);
    const ordered = await lib.listCategories();
    expect(ordered.map((c) => c.name)).toEqual(["B", "A"]);
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
      bridgeId: "example-bridge",
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
