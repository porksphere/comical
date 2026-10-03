/**
 * The library backup: what an export carries, and what a restore does to a store that already has
 * things in it. The restore is a merge in which the backup wins, and most of what is locked down
 * here is the "merge" half — a restore must never cost the user something the backup didn't know
 * about.
 */
import { describe, expect, test } from "bun:test";
import {
  entryKey,
  exportLibrary,
  InMemoryLibraryStore,
  Library,
  LIBRARY_BACKUP_FORMAT,
  LIBRARY_BACKUP_VERSION,
  LibraryBackupError,
  readLibraryBackup,
  type LibraryBackup,
} from "../src/index.ts";

function makeLibrary() {
  let t = 1_000;
  const store = new InMemoryLibraryStore();
  return { store, lib: new Library(store, { now: () => (t += 1_000) }) };
}

const COLLECTED = entryKey("demo", "collected");
const UNCOLLECTED = entryKey("demo", "uncollected");
const MUTED = entryKey("quiet", "unlisted");

/** A library with one of everything a backup carries, plus the things it must leave out. */
async function seeded() {
  const made = makeLibrary();
  const { lib } = made;
  const reading = await lib.createCollection("Reading");
  await lib.collectSeries({ bridgeId: "demo", seriesId: "collected" }, { seriesTitle: "Collected", collectionIds: [reading.id] });
  await lib.collectSeries({ bridgeId: "other", seriesId: "twin" }, { seriesTitle: "Collected", collectionIds: [reading.id] });
  await lib.createGroup([COLLECTED, entryKey("other", "twin")], COLLECTED);
  await lib.syncChapters(COLLECTED, [{ id: "c1", name: "Chapter 1", number: 1 }, { id: "c2", name: "Chapter 2", number: 2 }]);
  await lib.setProgress(COLLECTED, "c1", 9, 10, "Chapter 1");
  await lib.linkTracker(COLLECTED, "anilist", 42);
  await lib.collectPage(
    { bridgeId: "demo", seriesId: "collected", chapterId: "c1", pageIndex: 3 },
    { seriesTitle: "Collected", chapterName: "Chapter 1", pageCount: 10, sourceUrl: "https://cdn.example/c1/3.png" },
  );

  // Read, never collected: a history row and progress, no item.
  await lib.recordRead({ bridgeId: "demo", seriesId: "uncollected", title: "Uncollected", lastReadChapterId: "u1", lastReadAt: 5 });
  await lib.setProgress(UNCOLLECTED, "u1", 4, 20, "U1");

  // Read on a bridge with history off: progress and nothing else to find it by.
  await lib.setBridgePrefs("quiet", { historyDisabled: true });
  await lib.recordRead({ bridgeId: "quiet", seriesId: "unlisted", title: "Unlisted", lastReadAt: 6 });
  await lib.setProgress(MUTED, "m1", 2, 8);

  return { ...made, reading };
}

/** A backup with its timestamp and ordering taken out, so two stores can be compared. */
function comparable(backup: LibraryBackup) {
  const byId = <T extends { id: string }>(list: T[]) => [...list].sort((a, b) => a.id.localeCompare(b.id));
  return {
    collections: byId(backup.collections),
    items: byId(backup.items),
    groups: byId(backup.groups),
    readingLog: [...backup.readingLog].sort((a, b) => a.seriesId.localeCompare(b.seriesId)),
    progress: Object.fromEntries(
      Object.entries(backup.progress)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, list]) => [key, [...list].sort((a, b) => a.chapterId.localeCompare(b.chapterId))]),
    ),
    trackerLinks: backup.trackerLinks,
    bridgePrefs: [...backup.bridgePrefs].sort((a, b) => a.bridgeId.localeCompare(b.bridgeId)),
  };
}

/** What a client sends: the document after a trip through a file. */
const fromFile = (backup: LibraryBackup) => readLibraryBackup(JSON.parse(JSON.stringify(backup)));

describe("exportBackup", () => {
  test("carries collections, items of every type, groups, tracker links and bridge prefs", async () => {
    const { lib, reading } = await seeded();
    const backup = await lib.exportBackup();

    expect(backup.format).toBe(LIBRARY_BACKUP_FORMAT);
    expect(backup.version).toBe(LIBRARY_BACKUP_VERSION);
    expect(backup.collections).toEqual([reading]);
    expect(backup.items.map((i) => i.type).sort()).toEqual(["page", "series", "series"]);
    expect(backup.groups).toHaveLength(1);
    expect(backup.trackerLinks[COLLECTED]?.[0]).toMatchObject({ trackerId: "anilist", externalId: 42 });
    expect(backup.bridgePrefs).toEqual([{ bridgeId: "quiet", trackersDisabled: false, historyDisabled: true }]);
  });

  test("keeps a collected series' chapter baseline, so a restore doesn't re-announce every chapter", async () => {
    const { lib } = await seeded();
    const item = (await lib.exportBackup()).items.find((i) => i.id === "series:demo:collected");
    expect(item?.type === "series" && item.knownChapters.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  test("carries read progress for series that were never collected", async () => {
    const { lib } = await seeded();
    const backup = await lib.exportBackup();

    expect(backup.progress[COLLECTED]?.[0]).toMatchObject({ chapterId: "c1", read: true, lastPage: 9 });
    expect(backup.progress[UNCOLLECTED]?.[0]).toMatchObject({ chapterId: "u1", lastPage: 4, pageCount: 20 });
    expect(backup.readingLog.map((h) => h.seriesId)).toEqual(["uncollected"]);
  });

  test("carries progress that has no history row or item to find it by", async () => {
    const { lib } = await seeded();
    const backup = await lib.exportBackup();

    expect(backup.readingLog.some((h) => h.bridgeId === "quiet")).toBe(false);
    expect(backup.progress[MUTED]?.[0]).toMatchObject({ chapterId: "m1", lastPage: 2 });
  });

  test("leaves out a series whose progress was reset", async () => {
    const { lib } = await seeded();
    await lib.resetProgress(COLLECTED);
    expect(Object.keys((await lib.exportBackup()).progress).sort()).toEqual([UNCOLLECTED, MUTED].sort());
  });

  test("an empty library exports an empty, restorable backup", async () => {
    const { lib } = makeLibrary();
    const backup = await lib.exportBackup();
    expect(comparable(backup)).toEqual({ collections: [], items: [], groups: [], readingLog: [], progress: {}, trackerLinks: {}, bridgePrefs: [] });
    expect(fromFile(backup).skipped).toBe(0);
  });
});

describe("restoreBackup", () => {
  test("rebuilds an empty library to match the one exported", async () => {
    const source = await seeded();
    const backup = await source.lib.exportBackup();
    const target = makeLibrary();

    const counts = await target.lib.restoreBackup(fromFile(backup).backup);

    expect(comparable(await target.lib.exportBackup())).toEqual(comparable(backup));
    expect(counts).toEqual({ collections: 1, items: 3, progress: 3, groups: 1, trackerLinks: 1, readingLog: 1, bridgePrefs: 1 });
    // The restored library is a working one, not just matching documents.
    expect((await target.lib.getLibrary()).map((s) => s.seriesId).sort()).toEqual(["collected", "twin"]);
    expect((await target.lib.getHistory()).map((h) => h.seriesId)).toContain("uncollected");
    expect((await target.lib.getProgress(UNCOLLECTED))[0]).toMatchObject({ chapterId: "u1", lastPage: 4 });
  });

  test("writes nothing the second time", async () => {
    const source = await seeded();
    const { backup } = fromFile(await source.lib.exportBackup());
    const target = makeLibrary();
    await target.lib.restoreBackup(backup);

    expect(await target.lib.restoreBackup(backup)).toEqual({ collections: 0, items: 0, progress: 0, groups: 0, trackerLinks: 0, readingLog: 0, bridgePrefs: 0 });
  });

  test("keeps what was added since the backup", async () => {
    const { lib } = await seeded();
    const { backup } = fromFile(await lib.exportBackup());

    const later = await lib.createCollection("Later");
    await lib.collectSeries({ bridgeId: "demo", seriesId: "newer" }, { seriesTitle: "Newer", collectionIds: [later.id] });
    await lib.setProgress(entryKey("demo", "newer"), "n1", 1, 5);
    await lib.setProgress(COLLECTED, "c2", 3, 10, "Chapter 2");
    await lib.restoreBackup(backup);

    expect((await lib.getCollections()).map((c) => c.name)).toEqual(["Reading", "Later"]);
    expect((await lib.getLibrary()).map((s) => s.seriesId).sort()).toEqual(["collected", "newer", "twin"]);
    expect(await lib.getProgress(entryKey("demo", "newer"))).toHaveLength(1);
    // A chapter the backup never saw is left as it is.
    expect((await lib.getProgress(COLLECTED)).find((p) => p.chapterId === "c2")).toMatchObject({ lastPage: 3 });
  });

  test("the backup's copy wins over a record changed since", async () => {
    const { lib, reading } = await seeded();
    const { backup } = fromFile(await lib.exportBackup());

    await lib.renameCollection(reading.id, "Renamed");
    const elsewhere = await lib.createCollection("Elsewhere");
    await lib.setItemCollections("series:demo:collected", [elsewhere.id]);
    await lib.markRead(COLLECTED, "c1", false);
    const counts = await lib.restoreBackup(backup);

    expect((await lib.getCollections())[0]?.name).toBe("Reading");
    expect((await lib.getSeries(COLLECTED))?.collectionIds).toEqual([reading.id]);
    expect((await lib.getProgress(COLLECTED)).find((p) => p.chapterId === "c1")?.read).toBe(true);
    expect(counts).toMatchObject({ collections: 1, items: 1, progress: 1 });
  });

  test("brings back a series removed since, with its read state", async () => {
    const { lib } = await seeded();
    const { backup } = fromFile(await lib.exportBackup());

    await lib.removeSeries(COLLECTED);
    await lib.resetProgress(COLLECTED);
    await lib.restoreBackup(backup);

    expect(await lib.isCollected(COLLECTED)).toBe(true);
    expect((await lib.getProgress(COLLECTED))[0]).toMatchObject({ chapterId: "c1", read: true });
  });

  test("files items into a collection recreated under the same name instead of duplicating it", async () => {
    const source = await seeded();
    const { backup } = fromFile(await source.lib.exportBackup());
    const target = makeLibrary();
    const recreated = await target.lib.createCollection("Reading");

    const counts = await target.lib.restoreBackup(backup);

    expect(await target.lib.getCollections()).toEqual([recreated]);
    expect((await target.lib.getSeries(COLLECTED))?.collectionIds).toEqual([recreated.id]);
    expect(counts.collections).toBe(0);
  });

  test("doesn't give a series collected since the backup a history row as well", async () => {
    const { lib, store } = await seeded();
    const { backup } = fromFile(await lib.exportBackup());

    await lib.collectSeries({ bridgeId: "demo", seriesId: "uncollected" }, { seriesTitle: "Uncollected" });
    expect(await store.listReadingLog()).toEqual([]);
    await lib.restoreBackup(backup);

    expect(await store.listReadingLog()).toEqual([]);
    expect(await lib.isCollected(UNCOLLECTED)).toBe(true);
  });

  test("drops the history row of a series the backup collects", async () => {
    const source = await seeded();
    const { backup } = fromFile(await source.lib.exportBackup());
    const target = makeLibrary();
    await target.lib.recordRead({ bridgeId: "demo", seriesId: "collected", title: "Collected", lastReadAt: 9 });

    await target.lib.restoreBackup(backup);

    expect((await target.store.listReadingLog()).map((h) => h.seriesId)).toEqual(["uncollected"]);
    expect((await target.lib.getHistory()).filter((h) => h.seriesId === "collected")).toHaveLength(1);
  });

  test("restores a record an older build wrote, as it was", async () => {
    const source = await seeded();
    const backup = JSON.parse(JSON.stringify(await source.lib.exportBackup())) as LibraryBackup;
    const item = backup.items.find((i) => i.id === "series:demo:collected")!;
    // No `updatedAt` or `knownChapters` — how sync writes an item it received.
    Reflect.deleteProperty(item, "updatedAt");
    Reflect.deleteProperty(item, "knownChapters");
    const target = makeLibrary();

    const { backup: read, skipped } = readLibraryBackup(backup);
    await target.lib.restoreBackup(read);

    expect(skipped).toBe(0);
    expect((await target.lib.getSeries(COLLECTED))?.knownChapters).toEqual([]);
  });
});

describe("readLibraryBackup", () => {
  test("rejects anything that isn't a backup", () => {
    for (const input of [undefined, null, "text", [], {}, { format: "something-else", version: 1, exportedAt: 0 }]) {
      expect(() => readLibraryBackup(input)).toThrow(LibraryBackupError);
    }
  });

  test("rejects a backup from a newer build rather than half-reading it", () => {
    const newer = { format: LIBRARY_BACKUP_FORMAT, version: LIBRARY_BACKUP_VERSION + 1, exportedAt: 0 };
    expect(() => readLibraryBackup(newer)).toThrow(/newer version/);
  });

  test("reads a backup with sections missing as empty ones", () => {
    const { backup, skipped } = readLibraryBackup({ format: LIBRARY_BACKUP_FORMAT, version: 1, exportedAt: 7 });
    expect(skipped).toBe(0);
    expect(backup).toMatchObject({ collections: [], items: [], progress: {}, bridgePrefs: [] });
    expect(backup.sources).toBeUndefined();
  });

  test("drops and counts records it can't identify, keeping the rest", async () => {
    const source = await seeded();
    const raw = JSON.parse(JSON.stringify(await source.lib.exportBackup()));
    raw.collections.push({ name: "No id" });
    raw.items.push({ id: "series:demo:mismatch", type: "series", bridgeId: "demo", seriesId: "another" }, "not a record");
    raw.progress[COLLECTED].push({ read: true });
    raw.progress["demo:broken"] = [{ chapterId: 5 }];
    raw.readingLog.push({ bridgeId: "demo" });

    const { backup, skipped } = readLibraryBackup(raw);

    expect(skipped).toBe(6);
    expect(backup.collections).toHaveLength(1);
    expect(backup.items).toHaveLength(3);
    expect(backup.progress[COLLECTED]).toHaveLength(1);
    expect(backup.progress["demo:broken"]).toBeUndefined();
    expect(backup.readingLog).toHaveLength(1);
  });

  test("keeps the sources a host added, and no trust setting a file carries", () => {
    const sources = {
      registries: [{ url: "https://example.com/index.json", requireSignature: false }],
      bridges: [{ id: "demo", registryUrl: "https://example.com/index.json" }],
      trackers: [],
    };
    const { backup } = readLibraryBackup({ format: LIBRARY_BACKUP_FORMAT, version: 1, exportedAt: 0, sources });
    expect(backup.sources).toEqual({ ...sources, registries: [{ url: "https://example.com/index.json" }] });
  });
});

describe("exportLibrary", () => {
  test("stamps the time it is given", async () => {
    expect((await exportLibrary(new InMemoryLibraryStore(), 1234)).exportedAt).toBe(1234);
  });
});
