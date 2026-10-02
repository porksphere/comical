/**
 * A library written out as one document and read back in — the copy to fall back on before
 * something rewrites the library wholesale (a first sync, a new device, a reinstall).
 *
 * It holds what the user did: what they collected and where they filed it, what they read (series
 * they never collected included), what they linked and grouped. It leaves out what can be fetched
 * again (cached details and chapter lists, covers, downloads) and what a device derives for itself
 * (the activity feed). Logins never come near it — bridge settings and tracker tokens live outside
 * the library altogether.
 *
 * Records are carried as the store held them, checked only as far as their identity. A backup
 * exists to put back exactly what was there, and validating against today's model would drop a
 * record an older build wrote — one the library still reads (`hydrateSeriesItem`), and the user's
 * all the same.
 */
import { z } from "zod";
import {
  entryKey,
  parseCollectionItemId,
  type BridgePrefs,
  type ChapterProgress,
  type Collection,
  type CollectionItem,
  type HistoryItem,
  type SeriesGroup,
  type TrackerLink,
} from "./models.ts";
import type { LibraryStore } from "./store.ts";

export const LIBRARY_BACKUP_FORMAT = "comical-library-backup";
export const LIBRARY_BACKUP_VERSION = 1;

/**
 * Where the library's series came from: the registries a host had saved and what it had installed
 * from them. The library knows nothing of registries — a host adds this on the way out and acts on
 * it on the way in — but it belongs in the same file, since a restored series whose bridge is
 * missing can't be opened.
 */
export interface LibraryBackupSources {
  registries: Array<{ url: string; requireSignature?: boolean | undefined }>;
  bridges: Array<{ id: string; registryUrl: string }>;
  trackers: Array<{ id: string; registryUrl: string }>;
}

export interface LibraryBackup {
  format: typeof LIBRARY_BACKUP_FORMAT;
  version: number;
  exportedAt: number;
  collections: Collection[];
  items: CollectionItem[];
  groups: SeriesGroup[];
  readingLog: HistoryItem[];
  /** By `entryKey`. Covers every series with read state, collected or not. */
  progress: Record<string, ChapterProgress[]>;
  /** By `entryKey`. */
  trackerLinks: Record<string, TrackerLink[]>;
  bridgePrefs: BridgePrefs[];
  sources?: LibraryBackupSources;
}

/** Records written, by kind. One already identical to the backup's copy isn't written or counted. */
export interface LibraryRestoreCounts {
  collections: number;
  items: number;
  progress: number;
  groups: number;
  trackerLinks: number;
  readingLog: number;
  bridgePrefs: number;
}

/** The input isn't a backup this build can read. The message is written for the user. */
export class LibraryBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryBackupError";
  }
}

const id = z.string().min(1);
const installed = z.array(z.object({ id, registryUrl: id }));

const envelopeSchema = z.object({
  format: z.literal(LIBRARY_BACKUP_FORMAT),
  version: z.number().int().positive(),
  exportedAt: z.number(),
  collections: z.array(z.unknown()).default([]),
  items: z.array(z.unknown()).default([]),
  groups: z.array(z.unknown()).default([]),
  readingLog: z.array(z.unknown()).default([]),
  progress: z.record(z.string(), z.array(z.unknown())).default({}),
  trackerLinks: z.record(z.string(), z.array(z.unknown())).default({}),
  bridgePrefs: z.array(z.unknown()).default([]),
  sources: z
    .object({
      registries: z.array(z.object({ url: id, requireSignature: z.boolean().optional() })).default([]),
      bridges: installed.default([]),
      trackers: installed.default([]),
    })
    .optional(),
});

const identity = {
  collection: z.object({ id, name: id, order: z.number() }).passthrough(),
  item: z
    .object({ id, type: z.enum(["series", "chapter", "page"]), bridgeId: id, seriesId: id, collectionIds: z.array(z.string()).default([]) })
    .passthrough()
    .refine((item) => {
      const coord = parseCollectionItemId(item.id);
      return coord?.type === item.type && coord.bridgeId === item.bridgeId && coord.seriesId === item.seriesId;
    }),
  group: z.object({ id, primaryKey: id, memberKeys: z.array(id) }).passthrough(),
  readingLog: z.object({ bridgeId: id, seriesId: id, title: z.string(), lastReadAt: z.number() }).passthrough(),
  progress: z.object({ chapterId: id, read: z.boolean() }).passthrough(),
  trackerLink: z.object({ trackerId: id }).passthrough(),
  bridgePrefs: z.object({ bridgeId: id }).passthrough(),
};

/**
 * Read a parsed backup file. Throws `LibraryBackupError` when it isn't one, or is from a newer
 * build; a record inside it that can't be identified is dropped and counted in `skipped` instead,
 * so one damaged row doesn't cost the rest.
 */
export function readLibraryBackup(input: unknown): { backup: LibraryBackup; skipped: number } {
  const envelope = envelopeSchema.safeParse(input);
  if (!envelope.success) throw new LibraryBackupError("This isn't a Comical library backup.");
  const raw = envelope.data;
  if (raw.version > LIBRARY_BACKUP_VERSION) {
    throw new LibraryBackupError("This backup was made by a newer version of Comical. Update, then restore it.");
  }

  let skipped = 0;
  const keep = <T>(schema: z.ZodTypeAny, records: unknown[]): T[] =>
    records.flatMap((record) => {
      const parsed = schema.safeParse(record);
      if (parsed.success) return [parsed.data as T];
      skipped++;
      return [];
    });
  const keepByKey = <T>(schema: z.ZodTypeAny, byKey: Record<string, unknown[]>): Record<string, T[]> =>
    Object.fromEntries(
      Object.entries(byKey)
        .map(([key, records]) => [key, keep<T>(schema, records)] as const)
        .filter(([, records]) => records.length > 0),
    );

  const backup: LibraryBackup = {
    format: LIBRARY_BACKUP_FORMAT,
    version: raw.version,
    exportedAt: raw.exportedAt,
    collections: keep(identity.collection, raw.collections),
    items: keep(identity.item, raw.items),
    groups: keep(identity.group, raw.groups),
    readingLog: keep(identity.readingLog, raw.readingLog),
    progress: keepByKey(identity.progress, raw.progress),
    trackerLinks: keepByKey(identity.trackerLink, raw.trackerLinks),
    bridgePrefs: keep(identity.bridgePrefs, raw.bridgePrefs),
    ...(raw.sources && { sources: raw.sources }),
  };
  return { backup, skipped };
}

export async function exportLibrary(store: LibraryStore, exportedAt: number): Promise<LibraryBackup> {
  const items = await store.listCollectionItems();

  const progress: Record<string, ChapterProgress[]> = {};
  for (const key of (await store.listProgressKeys()).sort()) {
    const list = await store.listProgress(key);
    if (list.length > 0) progress[key] = list;
  }

  const trackerLinks: Record<string, TrackerLink[]> = {};
  for (const item of items) {
    if (item.type !== "series") continue;
    const key = entryKey(item.bridgeId, item.seriesId);
    const links = await store.listTrackerLinks(key);
    if (links.length > 0) trackerLinks[key] = links;
  }

  return {
    format: LIBRARY_BACKUP_FORMAT,
    version: LIBRARY_BACKUP_VERSION,
    exportedAt,
    collections: await store.listCollections(),
    items,
    groups: await store.listGroups(),
    readingLog: await store.listReadingLog(),
    progress,
    trackerLinks,
    bridgePrefs: await store.listBridgePrefs(),
  };
}

/**
 * Put a backup's records back. A MERGE in which the backup wins: every record it holds replaces
 * the store's copy, and whatever the store has that the backup doesn't is left alone — restoring
 * never removes a series collected since. Writes go through the store handed in, so over a store
 * that records its changes for sync a restore travels to the other devices like any other edit.
 */
export async function restoreLibrary(store: LibraryStore, backup: LibraryBackup): Promise<LibraryRestoreCounts> {
  const count: LibraryRestoreCounts = { collections: 0, items: 0, progress: 0, groups: 0, trackerLinks: 0, readingLog: 0, bridgePrefs: 0 };

  // A collection made again under the same name since the backup is the same collection to the
  // user, under a new id. The backup's items are filed into it rather than into a second
  // collection of that name.
  const collections = await store.listCollections();
  const backupIds = new Set(backup.collections.map((c) => c.id));
  const twinByName = new Map(collections.filter((c) => !backupIds.has(c.id)).map((c) => [c.name, c.id]));
  const alias = new Map<string, string>();
  for (const collection of backup.collections) {
    const at = collections.findIndex((c) => c.id === collection.id);
    const twin = twinByName.get(collection.name);
    if (at !== -1) {
      if (same(collections[at], collection)) continue;
      collections[at] = collection;
    } else if (twin !== undefined) {
      alias.set(collection.id, twin);
      continue;
    } else {
      collections.push(collection);
    }
    count.collections++;
  }
  if (count.collections > 0) await store.putCollections(collections);

  const held = new Map((await store.listCollectionItems()).map((i) => [i.id, i]));
  const changed: CollectionItem[] = [];
  for (const raw of backup.items) {
    const item =
      alias.size === 0 ? raw : { ...raw, collectionIds: [...new Set(raw.collectionIds.map((c) => alias.get(c) ?? c))] };
    if (same(held.get(item.id), item)) continue;
    changed.push(item);
    held.set(item.id, item);
  }
  if (changed.length > 0) await store.putCollectionItems(changed);
  count.items = changed.length;

  for (const [key, list] of Object.entries(backup.progress)) {
    const have = new Map((await store.listProgress(key)).map((p) => [p.chapterId, p]));
    for (const progress of list) {
      if (same(have.get(progress.chapterId), progress)) continue;
      await store.putProgress(key, progress);
      count.progress++;
    }
  }

  const groups = new Map((await store.listGroups()).map((g) => [g.id, g]));
  for (const group of backup.groups) {
    if (same(groups.get(group.id), group)) continue;
    await store.putGroup(group);
    count.groups++;
  }

  for (const [key, list] of Object.entries(backup.trackerLinks)) {
    const have = new Map((await store.listTrackerLinks(key)).map((l) => [l.trackerId, l]));
    for (const link of list) {
      if (same(have.get(link.trackerId), link)) continue;
      await store.putTrackerLink(key, link);
      count.trackerLinks++;
    }
  }

  // A history row is the resume point of a series that ISN'T collected; collecting one drops its
  // row. So a row never goes back for a series that is collected now, and a row the store holds
  // for a series the backup collected goes the way it would have on collecting it.
  const collected = new Set<string>();
  for (const item of held.values()) if (item.type === "series") collected.add(entryKey(item.bridgeId, item.seriesId));
  const log = new Map((await store.listReadingLog()).map((h) => [entryKey(h.bridgeId, h.seriesId), h]));
  for (const item of backup.items) {
    if (item.type === "series" && log.has(entryKey(item.bridgeId, item.seriesId))) {
      await store.deleteReadingLog(item.bridgeId, item.seriesId);
    }
  }
  for (const row of backup.readingLog) {
    const key = entryKey(row.bridgeId, row.seriesId);
    if (collected.has(key) || same(log.get(key), row)) continue;
    await store.upsertReadingLog(row);
    count.readingLog++;
  }

  for (const prefs of backup.bridgePrefs) {
    if (same(await store.getBridgePrefs(prefs.bridgeId), prefs)) continue;
    await store.setBridgePrefs(prefs.bridgeId, prefs);
    count.bridgePrefs++;
  }

  return count;
}

const same = (a: unknown, b: unknown): boolean => stable(a) === stable(b);

/** Key order and absent-vs-undefined are the store's business, not a difference. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
