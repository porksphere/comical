/**
 * The local-library data model, as zod schemas with inferred TS types.
 *
 * Unlike `@comical/contract` (what *bridges* produce), this is app-side state: the user's own
 * collection and reading progress. It spans every installed bridge — an entry is keyed by the pair
 * `(bridgeId, seriesId)` — and is deliberately independent of any bridge's backend `favorites`.
 *
 * A `LibraryEntry` caches a small display snapshot (title/thumbnail/author) of the series so the
 * library and history render without re-hitting the bridge, and so entries survive a bridge being
 * uninstalled (they grey out rather than vanish).
 */
import { z } from "zod";
import { chapterSchema, seriesInfoSchema } from "@comical/contract";

/** Stable, cross-bridge key for a tracked series. */
export function entryKey(bridgeId: string, seriesId: string): string {
  return `${bridgeId}:${seriesId}`;
}

/** Split a key back into its parts. `bridgeId` is `[a-z0-9-]` so the first `:` is the separator. */
export function parseEntryKey(key: string): { bridgeId: string; seriesId: string } {
  const i = key.indexOf(":");
  if (i === -1) return { bridgeId: key, seriesId: "" };
  return { bridgeId: key.slice(0, i), seriesId: key.slice(i + 1) };
}

/** Stable key for a single activity event: a series' entry key plus the chapter it concerns. */
export function activityKey(bridgeId: string, seriesId: string, chapterId: string): string {
  return `${bridgeId}:${seriesId}:${chapterId}`;
}

/**
 * A chapter known at the last `syncChapters`, with the metadata needed to collapse it to a logical
 * chapter `(number, languageCode)`. Multiple scanlation groups produce separate chapters that share
 * a `(number, languageCode)`; the library treats them as one chapter for unread counts and
 * new-chapter detection.
 */
export const knownChapterSchema = z.object({
  id: z.string().min(1),
  number: z.number().optional(),
  languageCode: z.string().optional(),
});
export type KnownChapter = z.infer<typeof knownChapterSchema>;

/**
 * The full series detail captured for offline rendering — everything the series page needs when the
 * bridge is unreachable (device offline, LAN-only server, bridge uninstalled). Fed by data the
 * system already fetches (add-to-library, browsing, background sync); never re-requested on its own.
 */
export const cachedSeriesDetailSchema = z.object({
  info: seriesInfoSchema,
  cachedAt: z.number().int(),
  /** Relative path of the captured cover bytes under the host's covers blob root — the manifest
   *  pointer for guaranteed-offline covers (the bytes themselves live in a host `BlobStore`).
   *  Absent until the host captures the cover. */
  coverFile: z.string().optional(),
});
export type CachedSeriesDetail = z.infer<typeof cachedSeriesDetailSchema>;

/**
 * The full renderable chapter list for offline serving. Lives BESIDE the entry (its own store doc):
 * it's the bulk of the metadata, and `knownChapters` on the entry stays the slim unread-count
 * projection it always was.
 */
export const cachedChaptersSchema = z.object({
  chapters: z.array(chapterSchema),
  cachedAt: z.number().int(),
});
export type CachedChapters = z.infer<typeof cachedChaptersSchema>;

/** A user-defined list the library groups entries into (e.g. "Reading", "Plan to Read"). */
export const libraryListSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Sort position among lists (ascending). */
  order: z.number(),
});
export type LibraryList = z.infer<typeof libraryListSchema>;

/** One tracked series in the library. */
export const libraryEntrySchema = z.object({
  bridgeId: z.string().min(1),
  seriesId: z.string().min(1),
  /** Cached display snapshot so the library/history render offline and survive bridge removal. */
  title: z.string().min(1),
  thumbnailUrl: z.string().url().optional(),
  author: z.string().optional(),
  /** List memberships (ids into `LibraryList`). Empty = unlisted. */
  listIds: z.array(z.string()).default([]),
  addedAt: z.number().int(),
  updatedAt: z.number().int(),
  /** Resume cache, updated on every read so history/resume need no progress scan. */
  lastReadChapterId: z.string().optional(),
  lastReadChapterName: z.string().optional(),
  lastReadAt: z.number().int().optional(),
  /**
   * Chapters known at the last `syncChapters`, for new-chapter detection + unread counts. Carries
   * each chapter's `number`/`languageCode` so both collapse by logical chapter `(number, language)`.
   */
  knownChapters: z.array(knownChapterSchema).default([]),
  chaptersSyncedAt: z.number().int().optional(),
  /**
   * If set, this entry belongs to a `SeriesGroup` (same title from a different bridge). The group
   * id is the UUID of the group; use the store to resolve it to a `SeriesGroup`.
   */
  seriesGroupId: z.string().optional(),
  /**
   * Cross-service identifiers persisted from `SeriesInfo.externalIds` at add-time. Keyed by
   * tracker id (e.g. "anilist", "mal"). Used for auto-linking groups and for tracker sync matching.
   */
  externalIds: z.record(z.string(), z.union([z.string().min(1), z.number().int().positive()])).optional(),
});
export type LibraryEntry = z.infer<typeof libraryEntrySchema>;

/**
 * A user-created or auto-detected grouping of library entries that represent the same series
 * across different bridges. One entry is the `primary` (preferred source for reading); all are
 * `members`. Progress propagation and library grid deduplication use the group.
 */
export const seriesGroupSchema = z.object({
  id: z.string().min(1),
  /** Display title (snapshot from the primary entry at group creation time). */
  title: z.string().min(1),
  /** `entryKey` of the preferred source for reading. Must be in `memberKeys`. */
  primaryKey: z.string().min(1),
  /** All `entryKey` values in this group (includes primary). */
  memberKeys: z.array(z.string().min(1)).min(2),
  createdAt: z.number().int(),
});
export type SeriesGroup = z.infer<typeof seriesGroupSchema>;

/** Read state for a single chapter of a tracked series. */
export const chapterProgressSchema = z.object({
  chapterId: z.string().min(1),
  read: z.boolean(),
  /** Last page index viewed (0-based) — the resume point within the chapter. */
  lastPage: z.number().int().nonnegative().optional(),
  pageCount: z.number().int().nonnegative().optional(),
  /**
   * Decimal chapter number (mirrors `Chapter.number`), recorded when known. Lets tracker pushes
   * compute the highest read chapter number — the value trackers expect as `chaptersRead` — without
   * keeping a separate chapter store.
   */
  number: z.number().optional(),
  /**
   * Language of the chapter this progress belongs to (mirrors `Chapter.languageCode`), recorded so
   * read state collapses by logical chapter `(number, languageCode)`. Auto-filled from the entry's
   * `knownChapters` when not supplied explicitly.
   */
  languageCode: z.string().optional(),
  updatedAt: z.number().int(),
});
export type ChapterProgress = z.infer<typeof chapterProgressSchema>;

/**
 * A library entry augmented with derived, non-persisted fields a host renders directly.
 * `unreadCount` = logical chapters `(number, language)` with no read copy in any scanlation group.
 */
export interface LibraryEntryView extends LibraryEntry {
  unreadCount: number;
}

/** A recently-read series (one row per series for v1), newest first. Derived from entries. */
export interface HistoryItem {
  bridgeId: string;
  seriesId: string;
  title: string;
  thumbnailUrl?: string;
  lastReadChapterId?: string;
  lastReadChapterName?: string;
  /**
   * Resume page within `lastReadChapterId` (0-based) and the chapter's total page count, for
   * rendering "page X / N" in history. Reading-log (non-library) entries persist these directly;
   * for library entries `getHistory` fills them in from the chapter's `ChapterProgress`.
   */
  lastPage?: number;
  pageCount?: number;
  lastReadAt: number;
}

/** Where to resume a series: its last-read chapter and page. */
export interface ResumePoint {
  chapterId: string;
  lastPage: number;
}

/**
 * A newly-detected chapter — one event in the activity feed (the "new chapters" news feed).
 * Recorded by `syncChapters` when a chapter appears that wasn't known at the previous sync. Carries a
 * display snapshot of its series so the feed renders offline and survives the bridge being removed.
 */
export const activityItemSchema = z.object({
  bridgeId: z.string().min(1),
  seriesId: z.string().min(1),
  chapterId: z.string().min(1),
  /** Series display snapshot at detection time. */
  title: z.string().min(1),
  thumbnailUrl: z.string().url().optional(),
  /** Chapter display snapshot. */
  chapterName: z.string().optional(),
  /** Decimal chapter number (mirrors `Chapter.number`), when known. */
  number: z.number().optional(),
  /** Language of the chapter (mirrors `Chapter.languageCode`), snapshot so read state collapses logically. */
  languageCode: z.string().optional(),
  /** When the source published the chapter (epoch ms), when known. */
  publishedAt: z.number().int().optional(),
  /** When `syncChapters` first observed this chapter (epoch ms) — the feed sorts on this, newest first. */
  detectedAt: z.number().int(),
});
export type ActivityItem = z.infer<typeof activityItemSchema>;

/**
 * An activity item augmented with derived read state. `read` is computed by cross-referencing the
 * series' chapter progress, so it is never persisted: it flips to true once the user reads the chapter,
 * which is what clears the item from the unread badge.
 */
export interface ActivityItemView extends ActivityItem {
  read: boolean;
}

/**
 * Association between a library entry and a tracker service entry. Persisted per-series
 * so the runtime can push read state to the tracker after each chapter mark.
 */
export const trackerLinkSchema = z.object({
  trackerId: z.string().min(1),
  externalId: z.union([z.string().min(1), z.number().int().positive()]),
  status: z.enum(["reading", "completed", "on_hold", "dropped", "planning", "rereading"]).optional(),
  chaptersRead: z.number().optional(),
  lastSyncAt: z.number().int().optional(),
});
export type TrackerLink = z.infer<typeof trackerLinkSchema>;

/** Per-bridge user preferences stored in the library. */
export const bridgePrefsSchema = z.object({
  bridgeId: z.string().min(1),
  /** When true, tracker sync (push and pull) is skipped for all series from this bridge. */
  trackersDisabled: z.boolean().default(false),
  /** When true, reads from this bridge are excluded from reading history. */
  historyDisabled: z.boolean().default(false),
});
export type BridgePrefs = z.infer<typeof bridgePrefsSchema>;
