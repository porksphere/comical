/**
 * Conformance cases for a `LibraryStore` that sync records over — the same list for every store, so
 * each platform's suite runs it under its own runner:
 *
 *   for (const c of libraryStoreConformance(() => new MyStore())) test(c.name, c.run);
 *
 * Framework-free on purpose (a case throws on failure), and Node-free like the rest of this package,
 * so the app can run it against its own store.
 *
 * Two properties, both of which a store once broke — `FileLibraryStore` handed out its cached
 * records, and a collected series' resume point never synced from the desktop:
 *
 *  - ISOLATION: a record a store returns, or is handed, is the caller's from then on. `Library` edits
 *    what it reads before writing it back, and sync's recording store compares a record before and
 *    after each write; sharing one object between the caller and the store makes both sides the same.
 *  - RECORDING: driving a `Library` over `wrapLibraryStore`, every synced record an operation changes
 *    is recorded. This is isolation checked end to end, and it also catches a `Library` write path
 *    that changes a synced record somewhere the recorder doesn't look.
 *
 * A new `LibraryStore` method doesn't typecheck until `COVERAGE` says which probe covers it, and a new
 * `Library` write path is covered once it has a step in `OPERATIONS`.
 */
import {
  collectionItemId,
  entryKey,
  InMemoryLibraryStore,
  Library,
  parseEntryKey,
  type ActivityItem,
  type CollectionItem,
  type CollectionSeriesItem,
  type LibraryStore,
} from "@comical/library";
import type { Chapter } from "@comical/contract";
import type { SyncEngine } from "./engine.ts";
import { adoptLibrary, librarySyncStore, wrapLibraryStore } from "./library.ts";
import { stableJson } from "./store.ts";
import type { TableId } from "./tables.ts";

export interface ConformanceCase {
  name: string;
  run: () => Promise<void>;
}

type MakeStore = () => LibraryStore | Promise<LibraryStore>;

export function libraryStoreConformance(make: MakeStore): ConformanceCase[] {
  return [
    ...Object.entries(PROBES).map(([name, probe]) => ({
      name: `isolation: ${name}`,
      run: async () => probe(await make()),
    })),
    ...OPERATIONS.map((op) => ({
      name: `recording: ${op.name}`,
      run: () => checkRecording(make, op),
    })),
  ];
}

// ── Isolation ────────────────────────────────────────────────────────────────────────────────────

const KEY = entryKey("conformance", "s1");
const KEY2 = entryKey("conformance", "s2");

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Edit a record the way a careless caller would: top level, and one level down. */
function scribble(v: unknown, depth = 0): void {
  if (Array.isArray(v)) {
    if (depth > 0) v.push("scribbled");
    for (const x of v) scribble(x, depth + 1);
    return;
  }
  if (v === null || typeof v !== "object" || depth > 2) return;
  for (const x of Object.values(v)) scribble(x, depth + 1);
  (v as Record<string, unknown>).scribbled = true;
}

/**
 * Write `value`, then edit the copy that was written and every copy read back, re-reading through
 * each of `reads` after each edit: none of it may reach the store.
 */
async function isolated<T>(
  what: string,
  value: T,
  write: (v: T) => Promise<unknown>,
  reads: Record<string, () => Promise<T | undefined>>,
): Promise<void> {
  const handed = clone(value);
  await write(handed);
  const want: Record<string, string> = {};
  for (const [name, read] of Object.entries(reads)) {
    const got = await read();
    if (got === undefined) throw new Error(`${what}: ${name} doesn't return the record just written`);
    want[name] = stableJson(got);
  }
  const check = async (after: string): Promise<void> => {
    for (const [name, read] of Object.entries(reads)) {
      if (stableJson(await read()) !== want[name]) throw new Error(`${what}: ${after} changed what ${name} returns`);
    }
  };
  scribble(handed);
  await check("editing the value it was handed");
  for (const [name, read] of Object.entries(reads)) {
    scribble(await read());
    await check(`editing what ${name} returned`);
  }
}

const seriesItem = (seriesId: string, extra: Partial<CollectionSeriesItem> = {}): CollectionSeriesItem => ({
  type: "series",
  bridgeId: "conformance",
  seriesId,
  id: collectionItemId({ type: "series", bridgeId: "conformance", seriesId }),
  collectedAt: 1,
  collectionIds: ["c1"],
  seriesTitle: "Conformance",
  updatedAt: 1,
  knownChapters: [{ id: "ch1", number: 1 }],
  externalIds: { anilist: 1 },
  lastReadChapterId: "ch1",
  lastReadAt: 1,
  ...extra,
});

const find = <T>(list: T[], match: (x: T) => boolean): T | undefined => list.find(match);

const PROBES = {
  "series detail": (s: LibraryStore) =>
    isolated("series detail", { info: { id: "s1", title: "One", altTitles: ["Uno"] }, cachedAt: 1, coverFile: "c" }, (v) => s.putSeriesDetail(KEY, v), {
      getSeriesDetail: () => s.getSeriesDetail(KEY),
    }),
  "cached chapters": (s: LibraryStore) =>
    isolated("cached chapters", { chapters: [{ id: "ch1", name: "One", number: 1 }], cachedAt: 1 }, (v) => s.putCachedChapters(KEY, v), {
      getCachedChapters: () => s.getCachedChapters(KEY),
    }),
  progress: (s: LibraryStore) =>
    isolated("progress", { chapterId: "ch1", read: false, lastPage: 3, pageCount: 9, updatedAt: 1 }, (v) => s.putProgress(KEY, v), {
      listProgress: async () => find(await s.listProgress(KEY), (p) => p.chapterId === "ch1"),
    }),
  groups: (s: LibraryStore) =>
    isolated("group", { id: "g1", title: "G", primaryKey: KEY, memberKeys: [KEY, KEY2], createdAt: 1 }, (v) => s.putGroup(v), {
      listGroups: async () => find(await s.listGroups(), (g) => g.id === "g1"),
    }),
  "collection items": (s: LibraryStore) => {
    const item = seriesItem("s1");
    return isolated<CollectionItem>("collection item", item, (v) => s.putCollectionItems([v]), {
      getCollectionItem: () => s.getCollectionItem(item.id),
      listCollectionItems: async () => find(await s.listCollectionItems(), (i) => i.id === item.id),
      "listCollectionItems(scope)": async () =>
        find(await s.listCollectionItems({ bridgeId: "conformance", seriesId: "s1" }), (i) => i.id === item.id),
    });
  },
  collections: async (s: LibraryStore) => {
    // `next` is handed the current list: keeping hold of it and editing it later is the caller's
    // business, and must not be the store's.
    let seen: unknown;
    await s.updateCollections(() => [{ id: "c0", name: "Zero", order: 0 }]);
    await isolated(
      "collection",
      { id: "c1", name: "One", order: 1 },
      (v) =>
        s.updateCollections((current) => {
          seen = current;
          return [...current, v];
        }),
      { listCollections: async () => find(await s.listCollections(), (c) => c.id === "c1") },
    );
    const want = stableJson(await s.listCollections());
    scribble(seen);
    if (stableJson(await s.listCollections()) !== want) {
      throw new Error("collections: editing the list updateCollections handed `next` changed the store");
    }
  },
  "tracker links": (s: LibraryStore) =>
    isolated("tracker link", { trackerId: "anilist", externalId: 7, status: "reading" as const, chaptersRead: 3 }, (v) => s.putTrackerLink(KEY, v), {
      listTrackerLinks: async () => find(await s.listTrackerLinks(KEY), (l) => l.trackerId === "anilist"),
    }),
  "reading log": (s: LibraryStore) =>
    isolated("reading log", { bridgeId: "conformance", seriesId: "s1", title: "One", lastReadChapterId: "ch1", lastReadAt: 1 }, (v) => s.upsertReadingLog(v), {
      listReadingLog: async () => find(await s.listReadingLog(), (h) => h.seriesId === "s1"),
    }),
  "bridge prefs": (s: LibraryStore) =>
    isolated("bridge prefs", { bridgeId: "conformance", trackersDisabled: true, historyDisabled: false }, (v) => s.setBridgePrefs("conformance", v), {
      getBridgePrefs: () => s.getBridgePrefs("conformance"),
      listBridgePrefs: async () => find(await s.listBridgePrefs(), (p) => p.bridgeId === "conformance"),
    }),
  activity: (s: LibraryStore) =>
    isolated<ActivityItem>("activity", { bridgeId: "conformance", seriesId: "s1", chapterId: "ch2", title: "One", detectedAt: 1 }, (v) => s.putActivity(v), {
      listActivity: async () => find(await s.listActivity(), (a) => a.chapterId === "ch2"),
    }),
};

type Probe = keyof typeof PROBES;

/**
 * Which probe covers each method — `null` for one that takes and returns no record. Exhaustive by
 * type: a method added to `LibraryStore` fails the typecheck here until it is placed.
 */
const COVERAGE: { [K in keyof Required<LibraryStore>]: Probe | null } = {
  diskUsage: null,
  getSeriesDetail: "series detail",
  putSeriesDetail: "series detail",
  deleteSeriesDetail: null,
  getCachedChapters: "cached chapters",
  putCachedChapters: "cached chapters",
  deleteCachedChapters: null,
  listProgress: "progress",
  listProgressKeys: null,
  putProgress: "progress",
  deleteProgressForEntry: null,
  deleteProgress: null,
  listGroups: "groups",
  putGroup: "groups",
  deleteGroup: null,
  listCollectionItems: "collection items",
  getCollectionItem: "collection items",
  putCollectionItems: "collection items",
  deleteCollectionItems: null,
  listCollections: "collections",
  updateCollections: "collections",
  listTrackerLinks: "tracker links",
  putTrackerLink: "tracker links",
  deleteTrackerLink: null,
  listReadingLog: "reading log",
  upsertReadingLog: "reading log",
  deleteReadingLog: null,
  getBridgePrefs: "bridge prefs",
  listBridgePrefs: "bridge prefs",
  setBridgePrefs: "bridge prefs",
  listActivity: "activity",
  putActivity: "activity",
  deleteActivityForEntry: null,
  clearActivity: null,
  dropActivity: null,
  getIdMigrationMark: null,
  setIdMigrationMark: null,
  clearIdMigrationMarks: null,
};
void COVERAGE;

// ── Recording ────────────────────────────────────────────────────────────────────────────────────

interface Operation {
  name: string;
  /** Brings the library to where `run` starts; not checked. */
  setup?: (lib: Library) => Promise<unknown>;
  run: (lib: Library) => Promise<unknown>;
}

const S1 = { bridgeId: "conformance", seriesId: "s1" };
const S2 = { bridgeId: "conformance", seriesId: "s2" };
const chapters = (n: number): Chapter[] =>
  Array.from({ length: n }, (_, i) => ({ id: `ch${i + 1}`, name: `Chapter ${i + 1}`, number: i + 1 }));

/** A collected series with a chapter baseline — the shape the desktop's missed resume points had. */
async function collected(lib: Library, seriesId = "s1"): Promise<void> {
  await lib.collectSeries({ bridgeId: "conformance", seriesId }, { seriesTitle: `Series ${seriesId}`, thumbnailUrl: "https://example.com/a.jpg" });
  await lib.syncChapters(entryKey("conformance", seriesId), chapters(3));
}

const reading = async (lib: Library): Promise<void> => {
  await collected(lib);
  await lib.setProgress(KEY, "ch1", 2, 10, "Chapter 1", 1);
};

const OPERATIONS: Operation[] = [
  { name: "collect a series", run: (lib) => collected(lib) },
  { name: "collect it again under a new title", setup: collected, run: (lib) => lib.collectSeries(S1, { seriesTitle: "Renamed" }) },
  { name: "read a page of a collected series", setup: collected, run: (lib) => lib.setProgress(KEY, "ch2", 4, 10, "Chapter 2", 2) },
  { name: "keep reading the same chapter", setup: reading, run: (lib) => lib.setProgress(KEY, "ch1", 5, 10, "Chapter 1", 1) },
  { name: "mark a chapter read", setup: collected, run: (lib) => lib.markRead(KEY, "ch3", true, "Chapter 3", 3) },
  { name: "mark a chapter unread", setup: reading, run: (lib) => lib.markRead(KEY, "ch1", false) },
  { name: "mark read up to a chapter", setup: collected, run: (lib) => lib.markReadUpTo(KEY, chapters(3), "ch2") },
  { name: "reconcile read state from a tracker", setup: collected, run: (lib) => lib.reconcileRead(KEY, [{ chapterId: "ch1", number: 1 }]) },
  { name: "reset progress", setup: reading, run: (lib) => lib.resetProgress(KEY) },
  {
    name: "refresh the series snapshot",
    setup: collected,
    run: (lib) =>
      lib.refreshSnapshot(KEY, { id: "s1", title: "New Title", thumbnailUrl: "https://example.com/b.jpg", author: "Someone", externalIds: { anilist: 5 } }),
  },
  { name: "record the series gone", setup: collected, run: (lib) => lib.recordSeriesGone(KEY, "404", { checked: true }) },
  {
    name: "clear the series' gone mark",
    setup: async (lib) => {
      await collected(lib);
      await lib.recordSeriesGone(KEY, "404");
    },
    run: (lib) => lib.clearSeriesGone(KEY),
  },
  { name: "new chapters land in the feed", setup: collected, run: (lib) => lib.syncChapters(KEY, chapters(5)) },
  {
    name: "mark the feed read",
    setup: async (lib) => {
      await collected(lib);
      await lib.syncChapters(KEY, chapters(5));
    },
    run: (lib) => lib.markActivityRead("conformance", "s1"),
  },
  {
    name: "clear the feed",
    setup: async (lib) => {
      await collected(lib);
      await lib.syncChapters(KEY, chapters(5));
    },
    run: (lib) => lib.clearActivity(),
  },
  { name: "clear a collected series from history", setup: reading, run: (lib) => lib.clearHistoryEntry("conformance", "s1") },
  { name: "read a series that isn't collected", run: (lib) => lib.recordRead({ ...S1, title: "One", lastReadChapterId: "ch1", lastReadAt: 5 }) },
  {
    name: "collect a series read before",
    setup: (lib) => lib.recordRead({ ...S1, title: "One", lastReadChapterId: "ch1", lastReadAt: 5 }),
    run: (lib) => lib.collectSeries(S1, { seriesTitle: "One" }),
  },
  { name: "create a collection", run: (lib) => lib.createCollection("Reading") },
  {
    name: "file a series in a collection",
    setup: async (lib) => {
      await collected(lib);
      await lib.createCollection("Reading");
    },
    run: async (lib) => lib.setItemCollections(collectionItemId({ type: "series", ...S1 }), [(await lib.getCollections())[0]!.id]),
  },
  {
    name: "rename, reorder and delete collections",
    setup: async (lib) => {
      await lib.createCollection("A");
      await lib.createCollection("B");
    },
    run: async (lib) => {
      const [a, b] = await lib.getCollections();
      await lib.renameCollection(a!.id, "A2");
      await lib.reorderCollections([b!.id, a!.id]);
      await lib.deleteCollection(b!.id);
    },
  },
  {
    name: "group two series",
    setup: async (lib) => {
      await collected(lib, "s1");
      await collected(lib, "s2");
    },
    run: (lib) => lib.createGroup([KEY, KEY2], KEY),
  },
  {
    name: "leave a group",
    setup: async (lib) => {
      await collected(lib, "s1");
      await collected(lib, "s2");
      await lib.createGroup([KEY, KEY2], KEY);
    },
    run: (lib) => lib.leaveGroup(KEY2),
  },
  { name: "link a tracker", setup: collected, run: (lib) => lib.linkTracker(KEY, "anilist", 7) },
  {
    name: "update and unlink a tracker",
    setup: async (lib) => {
      await collected(lib);
      await lib.linkTracker(KEY, "anilist", 7);
    },
    run: async (lib) => {
      await lib.updateTrackerLink(KEY, "anilist", { status: "reading", chaptersRead: 2 });
      await lib.unlinkTracker(KEY, "anilist");
    },
  },
  { name: "change bridge prefs", run: (lib) => lib.setBridgePrefs("conformance", { historyDisabled: true }) },
  {
    name: "collect and uncollect a chapter and a page",
    setup: collected,
    run: async (lib) => {
      const chapter = { ...S1, chapterId: "ch1" };
      await lib.collectChapter(chapter, { seriesTitle: "One", chapterName: "Chapter 1" });
      await lib.collectPage({ ...chapter, pageIndex: 2 }, { seriesTitle: "One", pageCount: 10 });
      await lib.uncollectItem({ type: "chapter", ...chapter });
    },
  },
  { name: "remove a series", setup: reading, run: (lib) => lib.removeSeries(KEY) },
  {
    name: "restore a backup",
    run: async (lib) => lib.restoreBackup(await backupOf(reading)),
  },
];

/** A backup of a library `setup` built, from a store of its own. */
async function backupOf(setup: (lib: Library) => Promise<unknown>): Promise<Awaited<ReturnType<Library["exportBackup"]>>> {
  const lib = new Library(new InMemoryLibraryStore(), { now: clock() });
  await setup(lib);
  return lib.exportBackup();
}

function clock(): () => number {
  let t = 1_700_000_000_000;
  return () => (t += 1000);
}

/** Every synced record in `store`, as its projection: what each device holds. */
async function syncedState(store: LibraryStore, also: Iterable<string> = []): Promise<Map<string, string>> {
  const keys = new Set(also);
  const lister = {
    exclusive: <T>(fn: () => Promise<T>) => fn(),
    knows: () => false,
    adopt: (table: TableId, id: string) => void keys.add(recordKey(table, id)),
  } as unknown as SyncEngine;
  await adoptLibrary(store, lister);
  const view = librarySyncStore(store);
  const out = new Map<string, string>();
  for (const key of keys) {
    const [table, id] = splitRecordKey(key);
    out.set(key, stableJson((await view.read(table, id)) ?? null));
  }
  return out;
}

const recordKey = (table: TableId, id: string): string => `${table} ${id}`;
const splitRecordKey = (key: string): [TableId, string] => {
  const at = key.indexOf(" ");
  return [key.slice(0, at) as TableId, key.slice(at + 1)];
};

async function checkRecording(make: MakeStore, op: Operation): Promise<void> {
  const store = await make();
  const touched = new Set<string>();
  const recorder = {
    exclusive: <T>(fn: () => Promise<T>) => fn(),
    knows: () => false,
    touch: (table: TableId, id: string) => void touched.add(recordKey(table, id)),
  } as unknown as SyncEngine;
  const lib = new Library(wrapLibraryStore(store, recorder), { now: clock() });
  await op.setup?.(lib);

  const before = await syncedState(store);
  touched.clear();
  await op.run(lib);
  const after = await syncedState(store, before.keys());

  const missed: string[] = [];
  for (const [key, value] of after) {
    if (before.get(key) === value || touched.has(key)) continue;
    // A series' resume point goes with its item: removing the item is the record that syncs.
    const [table, id] = splitRecordKey(key);
    if (table === "seriesResume" && value === "null") {
      const itemKey = recordKey("collectionItems", collectionItemId({ type: "series", ...parseEntryKey(id) }));
      if (touched.has(itemKey) && after.get(itemKey) === "null") continue;
    }
    missed.push(`${key}: ${before.get(key) ?? "null"} → ${value}`);
  }
  if (missed.length > 0) {
    throw new Error(`${op.name}: changed synced records without recording them:\n  ${missed.join("\n  ")}`);
  }
}

