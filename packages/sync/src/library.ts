/**
 * Sync over `@comical/library`'s `LibraryStore`, in both directions: `librarySyncStore` is what the
 * engine reads from and applies into, and `wrapLibraryStore` is the store a host hands its `Library`
 * so every local write is recorded as it happens.
 *
 * What a synced record holds is a PROJECTION of the stored one, and the same projection serves both
 * the push and the "did this write change anything" test, so a write that only moves device-local
 * fields sends nothing:
 *
 *   - A series item drops its chapter baseline (`knownChapters`, `chaptersSyncedAt`, `revision`):
 *     each device refreshes its own, and a long series' list is tens of KB.
 *   - Its resume point travels separately as `seriesResume`. A page turn rewrites it, and as part of
 *     one last-write-wins item that page turn would undo a collection edit made elsewhere.
 *   - `updatedAt` and a tracker link's `lastSyncAt` are this device's bookkeeping, not the user's.
 *
 * Applying keeps the local side of each split and validates the remote side, dropping a record that
 * doesn't parse rather than wedging sync on it.
 */
import {
  bridgePrefsSchema,
  chapterProgressSchema,
  collectionItemId,
  collectionItemSchema,
  collectionSchema,
  entryKey,
  parseEntryKey,
  seriesGroupSchema,
  trackerLinkSchema,
  type ChapterProgress,
  type CollectionItem,
  type CollectionSeriesItem,
  type HistoryItem,
  type LibraryStore,
} from "@comical/library";
import { z } from "zod";
import type { SyncEngine } from "./engine.ts";
import { stableJson, type ProgressValue, type SyncStore } from "./store.ts";
import { compositeId, splitCompositeId, type TableId } from "./tables.ts";

export const LIBRARY_TABLES = [
  "bridgePrefs",
  "groups",
  "collections",
  "collectionItems",
  "seriesResume",
  "progress",
  "readingLog",
  "trackerLinks",
] as const satisfies readonly TableId[];

const SERIES_LOCAL = ["knownChapters", "chaptersSyncedAt", "revision", "updatedAt"] as const;
const RESUME = ["lastReadChapterId", "lastReadChapterName", "lastReadAt"] as const;

const resumeSchema = z.object({
  lastReadChapterId: z.string().optional(),
  lastReadChapterName: z.string().optional(),
  lastReadAt: z.number().int(),
});

const readingLogSchema = z
  .object({
    bridgeId: z.string().min(1),
    seriesId: z.string().min(1),
    title: z.string(),
    lastReadAt: z.number(),
  })
  .passthrough();

function omit<T extends object>(obj: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (!keys.includes(k) && v !== undefined) out[k] = v;
  return out;
}

function pick<T extends object>(obj: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (keys.includes(k) && v !== undefined) out[k] = v;
  return out;
}

const seriesItemIdOf = (key: string): string => collectionItemId({ type: "series", ...parseEntryKey(key) });

function projectItem(item: CollectionItem): Record<string, unknown> {
  return item.type === "series" ? omit(item, [...SERIES_LOCAL, ...RESUME]) : omit(item, []);
}

function resumeOf(item: CollectionSeriesItem): Record<string, unknown> | undefined {
  return item.lastReadAt === undefined ? undefined : pick(item, RESUME);
}

function progressValue(p: ChapterProgress): ProgressValue {
  return {
    read: p.read,
    lastPage: p.lastPage ?? 0,
    pageCount: p.pageCount ?? 0,
    ...(p.number !== undefined && { number: p.number }),
    ...(p.languageCode !== undefined && { languageCode: p.languageCode }),
  };
}

export function librarySyncStore(store: LibraryStore, now: () => number = Date.now): SyncStore {
  async function seriesItem(key: string): Promise<CollectionSeriesItem | undefined> {
    const item = await store.getCollectionItem(seriesItemIdOf(key));
    return item?.type === "series" ? item : undefined;
  }

  async function read(table: TableId, id: string): Promise<unknown> {
    switch (table) {
      case "collections":
        return (await store.listCollections()).find((c) => c.id === id);
      case "collectionItems": {
        const item = await store.getCollectionItem(id);
        return item && projectItem(item);
      }
      case "seriesResume": {
        const item = await seriesItem(id);
        return item && resumeOf(item);
      }
      case "progress": {
        const [key, chapterId] = splitCompositeId(id);
        const p = (await store.listProgress(key)).find((x) => x.chapterId === chapterId);
        return p && progressValue(p);
      }
      case "readingLog": {
        const { bridgeId, seriesId } = parseEntryKey(id);
        return (await store.listReadingLog()).find((i) => i.bridgeId === bridgeId && i.seriesId === seriesId);
      }
      case "trackerLinks": {
        const [key, trackerId] = splitCompositeId(id);
        const link = (await store.listTrackerLinks(key)).find((l) => l.trackerId === trackerId);
        return link && omit(link, ["lastSyncAt"]);
      }
      case "groups":
        return (await store.listGroups()).find((g) => g.id === id);
      case "bridgePrefs":
        return store.getBridgePrefs(id);
      default:
        return undefined;
    }
  }

  async function write(table: TableId, id: string, value: unknown): Promise<void> {
    switch (table) {
      case "collections": {
        const rest = (await store.listCollections()).filter((c) => c.id !== id);
        const parsed = value === undefined ? undefined : collectionSchema.safeParse(value);
        if (parsed && !parsed.success) return;
        await store.putCollections(parsed ? [...rest, parsed.data] : rest);
        return;
      }
      case "collectionItems": {
        const local = await store.getCollectionItem(id);
        if (value === undefined) {
          if (!local) return;
          await store.deleteCollectionItems([id]);
          if (local.type === "series") {
            // Device-local satellites of a series; the synced ones arrive as records of their own.
            const key = entryKey(local.bridgeId, local.seriesId);
            await store.deleteActivityForEntry(key);
            await store.deleteSeriesDetail(key);
            await store.deleteCachedChapters(key);
          }
          return;
        }
        const incoming = value as Record<string, unknown>;
        const kept = local?.type === "series" ? pick(local, [...SERIES_LOCAL, ...RESUME]) : {};
        const parsed = collectionItemSchema.safeParse({ ...incoming, ...kept, ...(incoming.type === "series" && { updatedAt: now() }) });
        if (!parsed.success || parsed.data.id !== id) return;
        await store.putCollectionItems([parsed.data]);
        return;
      }
      case "seriesResume": {
        const item = await seriesItem(id);
        if (!item) return;
        const parsed = value === undefined ? undefined : resumeSchema.safeParse(value);
        if (parsed && !parsed.success) return;
        await store.putCollectionItems([{ ...(omit(item, RESUME) as CollectionSeriesItem), ...parsed?.data }]);
        return;
      }
      case "progress": {
        const [key, chapterId] = splitCompositeId(id);
        const parsed = chapterProgressSchema.safeParse({ ...(value as object), chapterId, updatedAt: now() });
        if (parsed.success) await store.putProgress(key, parsed.data);
        return;
      }
      case "readingLog": {
        if (value === undefined) {
          const { bridgeId, seriesId } = parseEntryKey(id);
          await store.deleteReadingLog(bridgeId, seriesId);
          return;
        }
        const parsed = readingLogSchema.safeParse(value);
        if (!parsed.success || entryKey(parsed.data.bridgeId, parsed.data.seriesId) !== id) return;
        await store.upsertReadingLog(parsed.data as HistoryItem);
        return;
      }
      case "trackerLinks": {
        const [key, trackerId] = splitCompositeId(id);
        if (value === undefined) {
          await store.deleteTrackerLink(key, trackerId);
          return;
        }
        const local = (await store.listTrackerLinks(key)).find((l) => l.trackerId === trackerId);
        const parsed = trackerLinkSchema.safeParse({
          ...(value as object),
          ...(local?.lastSyncAt !== undefined && { lastSyncAt: local.lastSyncAt }),
        });
        if (parsed.success && parsed.data.trackerId === trackerId) await store.putTrackerLink(key, parsed.data);
        return;
      }
      case "groups": {
        if (value === undefined) {
          await store.deleteGroup(id);
          return;
        }
        const parsed = seriesGroupSchema.safeParse(value);
        if (parsed.success && parsed.data.id === id) await store.putGroup(parsed.data);
        return;
      }
      case "bridgePrefs": {
        // The store has no way to delete prefs, and "absent" reads as defaults anyway.
        const parsed = bridgePrefsSchema.safeParse(value ?? { bridgeId: id });
        if (parsed.success && parsed.data.bridgeId === id) await store.setBridgePrefs(id, parsed.data);
        return;
      }
      default:
        return;
    }
  }

  return { read, write };
}

type Target = readonly [TableId, string];

/**
 * The store to hand a `Library`: every write goes through to `inner` and is recorded with the engine
 * when it changed what syncs. The engine itself must be built over `librarySyncStore(inner)`, never
 * over this, or applying a remote change would record it as a local one.
 */
export function wrapLibraryStore(inner: LibraryStore, engine: SyncEngine): LibraryStore {
  const view = librarySyncStore(inner);

  function recorded<T>(
    targets: readonly Target[] | (() => Promise<readonly Target[]>),
    write: () => Promise<T>,
  ): Promise<T> {
    return engine.exclusive(async () => {
      const keys = typeof targets === "function" ? await targets() : targets;
      const before = await Promise.all(keys.map(([t, id]) => view.read(t, id)));
      const result = await write();
      for (let i = 0; i < keys.length; i++) {
        const [table, id] = keys[i]!;
        const after = await view.read(table, id);
        if (stableJson(before[i]) === stableJson(after)) continue;
        const wasRead = (before[i] as ProgressValue | undefined)?.read === true;
        const isRead = (after as ProgressValue | undefined)?.read === true;
        const rewind = table === "progress" && ((wasRead && !isRead) || (before[i] !== undefined && after === undefined));
        engine.touch(table, id, { rewind });
      }
      return result;
    });
  }

  const itemTargets = (items: CollectionItem[]): Target[] =>
    items.flatMap((i): Target[] =>
      i.type === "series"
        ? [["collectionItems", i.id], ["seriesResume", entryKey(i.bridgeId, i.seriesId)]]
        : [["collectionItems", i.id]],
    );

  return {
    ...(inner.diskUsage && { diskUsage: () => inner.diskUsage!() }),
    getSeriesDetail: (key) => inner.getSeriesDetail(key),
    putSeriesDetail: (key, detail) => inner.putSeriesDetail(key, detail),
    deleteSeriesDetail: (key) => inner.deleteSeriesDetail(key),
    getCachedChapters: (key) => inner.getCachedChapters(key),
    putCachedChapters: (key, doc) => inner.putCachedChapters(key, doc),
    deleteCachedChapters: (key) => inner.deleteCachedChapters(key),

    listProgress: (key) => inner.listProgress(key),
    listProgressKeys: () => inner.listProgressKeys(),
    putProgress: (key, progress) =>
      recorded([["progress", compositeId.progress(key, progress.chapterId)]], () => inner.putProgress(key, progress)),
    deleteProgressForEntry: (key) =>
      recorded(
        async () => (await inner.listProgress(key)).map((p): Target => ["progress", compositeId.progress(key, p.chapterId)]),
        () => inner.deleteProgressForEntry(key),
      ),

    listGroups: () => inner.listGroups(),
    putGroup: (group) => recorded([["groups", group.id]], () => inner.putGroup(group)),
    deleteGroup: (id) => recorded([["groups", id]], () => inner.deleteGroup(id)),

    listCollectionItems: (scope) => inner.listCollectionItems(scope),
    getCollectionItem: (id) => inner.getCollectionItem(id),
    putCollectionItems: (items) => recorded(itemTargets(items), () => inner.putCollectionItems(items)),
    deleteCollectionItems: (ids) =>
      recorded(
        ids.map((id): Target => ["collectionItems", id]),
        () => inner.deleteCollectionItems(ids),
      ),

    listCollections: () => inner.listCollections(),
    putCollections: (collections) =>
      recorded(
        async () => {
          const ids = new Set([...(await inner.listCollections()).map((c) => c.id), ...collections.map((c) => c.id)]);
          return [...ids].map((id): Target => ["collections", id]);
        },
        () => inner.putCollections(collections),
      ),

    listTrackerLinks: (key) => inner.listTrackerLinks(key),
    putTrackerLink: (key, link) =>
      recorded([["trackerLinks", compositeId.trackerLink(key, link.trackerId)]], () => inner.putTrackerLink(key, link)),
    deleteTrackerLink: (key, trackerId) =>
      recorded([["trackerLinks", compositeId.trackerLink(key, trackerId)]], () => inner.deleteTrackerLink(key, trackerId)),

    listReadingLog: () => inner.listReadingLog(),
    upsertReadingLog: (item) =>
      recorded([["readingLog", entryKey(item.bridgeId, item.seriesId)]], () => inner.upsertReadingLog(item)),
    deleteReadingLog: (bridgeId, seriesId) =>
      recorded([["readingLog", entryKey(bridgeId, seriesId)]], () => inner.deleteReadingLog(bridgeId, seriesId)),

    getBridgePrefs: (bridgeId) => inner.getBridgePrefs(bridgeId),
    listBridgePrefs: () => inner.listBridgePrefs(),
    setBridgePrefs: (bridgeId, prefs) => recorded([["bridgePrefs", bridgeId]], () => inner.setBridgePrefs(bridgeId, prefs)),

    listActivity: () => inner.listActivity(),
    putActivity: (item) => inner.putActivity(item),
    deleteActivityForEntry: (key) => inner.deleteActivityForEntry(key),
    clearActivity: () => inner.clearActivity(),
  };
}

/**
 * Record everything already in the store that sync hasn't seen. Run it AFTER the first pull from a
 * backend, so records the other devices already hold keep their version (see `SyncEngine.adopt`).
 */
export async function adoptLibrary(store: LibraryStore, engine: SyncEngine): Promise<void> {
  await engine.exclusive(async () => {
    for (const c of await store.listCollections()) engine.adopt("collections", c.id);
    for (const g of await store.listGroups()) engine.adopt("groups", g.id);

    for (const item of await store.listCollectionItems()) {
      engine.adopt("collectionItems", item.id);
      if (item.type !== "series") continue;
      const key = entryKey(item.bridgeId, item.seriesId);
      if (item.lastReadAt !== undefined) engine.adopt("seriesResume", key);
      for (const l of await store.listTrackerLinks(key)) engine.adopt("trackerLinks", compositeId.trackerLink(key, l.trackerId));
    }
    for (const h of await store.listReadingLog()) engine.adopt("readingLog", entryKey(h.bridgeId, h.seriesId));
    // From the store's own list, not from the items above: an uncollected series keeps its read
    // state, and so does a bridge its preferences, with no item or history row to find it by.
    for (const key of await store.listProgressKeys()) {
      for (const p of await store.listProgress(key)) engine.adopt("progress", compositeId.progress(key, p.chapterId));
    }
    for (const p of await store.listBridgePrefs()) engine.adopt("bridgePrefs", p.bridgeId);
  });
}
