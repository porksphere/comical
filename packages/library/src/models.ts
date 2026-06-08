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

/** A user-defined shelf the library groups entries into (e.g. "Reading", "Plan to Read"). */
export const categorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Sort position among categories (ascending). */
  order: z.number(),
});
export type Category = z.infer<typeof categorySchema>;

/** One tracked series in the library. */
export const libraryEntrySchema = z.object({
  bridgeId: z.string().min(1),
  seriesId: z.string().min(1),
  /** Cached display snapshot so the library/history render offline and survive bridge removal. */
  title: z.string().min(1),
  thumbnailUrl: z.string().url().optional(),
  author: z.string().optional(),
  /** Category memberships (ids into `Category`). Empty = uncategorized. */
  categoryIds: z.array(z.string()).default([]),
  addedAt: z.number().int(),
  updatedAt: z.number().int(),
  /** Resume cache, updated on every read so history/resume need no progress scan. */
  lastReadChapterId: z.string().optional(),
  lastReadChapterName: z.string().optional(),
  lastReadAt: z.number().int().optional(),
  /** Chapter ids known at the last `syncChapters`, for new-chapter detection + unread counts. */
  knownChapterIds: z.array(z.string()).default([]),
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
  updatedAt: z.number().int(),
});
export type ChapterProgress = z.infer<typeof chapterProgressSchema>;

/**
 * A library entry augmented with derived, non-persisted fields a host renders directly.
 * `unreadCount` = known chapters that have no `read` progress record.
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
  lastReadAt: number;
}

/** Where to resume a series: its last-read chapter and page. */
export interface ResumePoint {
  chapterId: string;
  lastPage: number;
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
});
export type BridgePrefs = z.infer<typeof bridgePrefsSchema>;
