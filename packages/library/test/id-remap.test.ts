/** Id migrations: what the library reports it holds for a bridge, and moving all of it onto new ids. */
import { describe, expect, test } from "bun:test";
import type { Chapter } from "@comical/contract";
import { entryKey, InMemoryLibraryStore, Library, type IdRemap } from "../src/index.ts";

function fakeClock() {
  let t = 1_000;
  return () => ++t;
}

const ch = (id: string, number: number): Chapter => ({ id, name: `Ch ${number}`, number });

function makeLibrary() {
  const store = new InMemoryLibraryStore();
  return { store, lib: new Library(store, { now: fakeClock() }) };
}

const OLD = entryKey("demo", "old");
const NEW = entryKey("demo", "new");

function remap(series: Record<string, string>, chapters: Record<string, Record<string, string>> = {}): IdRemap {
  return {
    series: new Map(Object.entries(series)),
    chapters: new Map(Object.entries(chapters).map(([s, m]) => [s, new Map(Object.entries(m))])),
  };
}

/** A collected series with a chapter baseline, a new-chapter event, progress, a link and caches. */
async function seed(lib: Library) {
  await lib.collectSeries({ bridgeId: "demo", seriesId: "old" }, { seriesTitle: "Old" });
  await lib.syncChapters(OLD, [ch("c1", 1)]);
  await lib.syncChapters(OLD, [ch("c1", 1), ch("c2", 2)]);
  await lib.markRead(OLD, "c1", true, "Ch 1", 1);
  await lib.linkTracker(OLD, "anilist", 42);
  await lib.cacheSeriesDetail(OLD, { id: "old", title: "Old" });
}

describe("idReferences", () => {
  test("names every series and chapter the library holds for the bridge, and nothing else", async () => {
    const { lib } = makeLibrary();
    await seed(lib);
    await lib.collectSeries({ bridgeId: "other", seriesId: "x" }, { seriesTitle: "X" });
    await lib.recordRead({ bridgeId: "demo", seriesId: "log", title: "Log", lastReadChapterId: "l1", lastReadAt: 5 });

    const refs = await lib.idReferences("demo");
    expect([...refs.keys()].sort()).toEqual(["log", "old"]);
    expect([...refs.get("old")!].sort()).toEqual(["c1", "c2"]);
    expect([...refs.get("log")!]).toEqual(["l1"]);
  });

  test("an empty library holds nothing", async () => {
    const { lib } = makeLibrary();
    expect((await lib.idReferences("demo")).size).toBe(0);
  });
});

describe("remapIds", () => {
  test("moves the item, its chapters, progress, activity, link and caches onto the new ids", async () => {
    const { lib, store } = makeLibrary();
    await seed(lib);

    await lib.remapIds("demo", remap({ old: "new" }, { old: { c1: "n1", c2: "n2" } }));

    expect(await lib.getSeries(OLD)).toBeUndefined();
    const moved = await lib.getSeries(NEW);
    expect(moved?.seriesTitle).toBe("Old");
    expect(moved?.knownChapters.map((k) => k.id).sort()).toEqual(["n1", "n2"]);
    expect((await lib.getProgress(NEW)).map((p) => p.chapterId)).toEqual(["n1"]);
    expect(await lib.getProgress(OLD)).toHaveLength(0);
    expect((await lib.getActivity()).map((a) => [a.seriesId, a.chapterId])).toEqual([["new", "n2"]]);
    expect((await lib.getTrackerLink(NEW, "anilist"))?.externalId).toBe(42);
    expect(await lib.getTrackerLink(OLD, "anilist")).toBeUndefined();
    expect((await lib.getCachedDetail(NEW))?.info.id).toBe("new");
    expect(await lib.getCachedDetail(OLD)).toBeUndefined();
    expect((await lib.getCachedChapters(NEW))?.chapters.map((c) => c.id)).toEqual(["n1", "n2"]);
    expect(await store.getCachedChapters(OLD)).toBeUndefined();
  });

  test("chapter ids alone move within the same series", async () => {
    const { lib } = makeLibrary();
    await seed(lib);

    await lib.remapIds("demo", remap({}, { old: { c1: "n1" } }));

    const item = await lib.getSeries(OLD);
    expect(item?.knownChapters.map((k) => k.id).sort()).toEqual(["c2", "n1"]);
    expect((await lib.getProgress(OLD)).map((p) => p.chapterId)).toEqual(["n1"]);
  });

  test("applying the same remap twice changes nothing more", async () => {
    const { lib } = makeLibrary();
    await seed(lib);
    const r = remap({ old: "new" }, { old: { c1: "n1" } });
    await lib.remapIds("demo", r);
    const once = await lib.exportBackup();
    await lib.remapIds("demo", r);
    expect({ ...(await lib.exportBackup()), exportedAt: 0 }).toEqual({ ...once, exportedAt: 0 });
  });

  test("merges into a series already collected under the new id, keeping the earlier collect and the later read", async () => {
    const { lib } = makeLibrary();
    await seed(lib);
    await lib.collectSeries({ bridgeId: "demo", seriesId: "new" }, { seriesTitle: "New" });
    // The newer progress on the new id wins over the old id's copy of the same chapter.
    await lib.setProgress(NEW, "n1", 3, 10);
    const oldCollected = (await lib.getSeries(OLD))!.collectedAt;

    await lib.remapIds("demo", remap({ old: "new" }, { old: { c1: "n1" } }));

    const merged = (await lib.getSeries(NEW))!;
    expect(merged.collectedAt).toBe(oldCollected);
    expect(merged.knownChapters.map((k) => k.id).sort()).toEqual(["c2", "n1"]);
    expect((await lib.getProgress(NEW)).find((p) => p.chapterId === "n1")?.lastPage).toBe(3);
    expect(await lib.getSeries(OLD)).toBeUndefined();
  });

  test("a newer unread row on the old id never un-reads the new one", async () => {
    const { lib, store } = makeLibrary();
    await store.putProgress(OLD, { chapterId: "n1", read: true, lastPage: 7, pageCount: 9, updatedAt: 10 });
    await store.putProgress(OLD, { chapterId: "c1", read: false, lastPage: 0, pageCount: 0, updatedAt: 20 });

    await lib.remapIds("demo", remap({}, { old: { c1: "n1" } }));

    expect(await store.listProgress(OLD)).toEqual([{ chapterId: "n1", read: true, lastPage: 7, pageCount: 9, updatedAt: 20 }]);
  });

  test("a reading-log entry moves with its chapter", async () => {
    const { lib } = makeLibrary();
    await lib.recordRead({ bridgeId: "demo", seriesId: "old", title: "Old", lastReadChapterId: "c1", lastReadAt: 5 });

    await lib.remapIds("demo", remap({ old: "new" }, { old: { c1: "n1" } }));

    const history = await lib.getHistory();
    expect(history.map((h) => [h.seriesId, h.lastReadChapterId])).toEqual([["new", "n1"]]);
  });

  test("a group whose two members turn out to be one series is dissolved", async () => {
    const { lib } = makeLibrary();
    await lib.collectSeries({ bridgeId: "demo", seriesId: "old" }, { seriesTitle: "Same" });
    await lib.collectSeries({ bridgeId: "demo", seriesId: "new" }, { seriesTitle: "Same" });
    await lib.createGroup([OLD, NEW], NEW);

    await lib.remapIds("demo", remap({ old: "new" }));

    expect(await lib.listGroups()).toHaveLength(0);
    expect((await lib.getSeries(NEW))?.seriesGroupId).toBeUndefined();
  });

  test("a group across bridges keeps its member under the new key", async () => {
    const { lib } = makeLibrary();
    await lib.collectSeries({ bridgeId: "demo", seriesId: "old" }, { seriesTitle: "Same" });
    await lib.collectSeries({ bridgeId: "other", seriesId: "x" }, { seriesTitle: "Same" });
    const other = entryKey("other", "x");
    await lib.createGroup([OLD, other], OLD);

    await lib.remapIds("demo", remap({ old: "new" }));

    const [group] = await lib.listGroups();
    expect(group?.primaryKey).toBe(NEW);
    expect(group?.memberKeys.sort()).toEqual([NEW, other].sort());
    expect((await lib.getSeries(NEW))?.seriesGroupId).toBe(group!.id);
  });

  test("another bridge's records with the same ids are untouched", async () => {
    const { lib } = makeLibrary();
    await lib.collectSeries({ bridgeId: "other", seriesId: "old" }, { seriesTitle: "Other" });

    await lib.remapIds("demo", remap({ old: "new" }));

    expect(await lib.getSeries(entryKey("other", "old"))).toBeDefined();
    expect(await lib.getSeries(entryKey("other", "new"))).toBeUndefined();
  });
});

describe("migration marks", () => {
  test("are stored per bridge", async () => {
    const { lib } = makeLibrary();
    expect(await lib.idMigrationMark("demo")).toBeUndefined();
    await lib.setIdMigrationMark("demo", "1.2.0");
    expect(await lib.idMigrationMark("demo")).toBe("1.2.0");
    expect(await lib.idMigrationMark("other")).toBeUndefined();
  });

  test("a restore forgets every mark and bumps the generation", async () => {
    const { lib } = makeLibrary();
    await lib.setIdMigrationMark("demo", "1.2.0");
    const before = lib.idMigrationGeneration;
    await lib.restoreBackup(await lib.exportBackup());
    expect(await lib.idMigrationMark("demo")).toBeUndefined();
    expect(lib.idMigrationGeneration).toBe(before + 1);
  });

  test("are not part of a backup", async () => {
    const { lib } = makeLibrary();
    await lib.setIdMigrationMark("demo", "1.2.0");
    expect(JSON.stringify(await lib.exportBackup())).not.toContain("1.2.0");
  });
});
