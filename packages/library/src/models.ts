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
import { chapterSchema, seriesInfoSchema, seriesRevisionSchema } from "@comical/contract";

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
  /** The URL `coverFile` was captured from. When the entry's live `thumbnailUrl` no longer matches
   *  (the source changed its cover art), the host re-captures on the next browse. */
  coverSourceUrl: z.string().optional(),
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

/** One tracked series in the library. */
export const libraryEntrySchema = z.object({
  bridgeId: z.string().min(1),
  seriesId: z.string().min(1),
  /** Cached display snapshot so the library/history render offline and survive bridge removal. */
  title: z.string().min(1),
  thumbnailUrl: z.string().url().optional(),
  author: z.string().optional(),
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
   * The source's revision fingerprint as of the last successful chapter sync, when the bridge
   * supports the batch update check. The next check compares against this and skips the full
   * `getChapters` only when they match exactly. Absent (bridge can't batch, or never synced) means
   * every check does the full fetch — the safe default, since "unknown" must never read as
   * "unchanged".
   */
  revision: seriesRevisionSchema.optional(),
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

// ── Collections & collection items ────────────────────────────────────────────
// Local user data. PURE COLLECTIONS: a collection ITEM anchors a series, a chapter, or a single
// page, and exists only as a member of user-named collections — an item whose memberships reach
// zero is removed (a fresh item may be transiently uncollected until its first filing). "Favorites"
// deliberately does not appear on this surface: that word belongs to the bridge-account per-series
// capability (`/bridges/{id}/favorites`), which is unrelated — nothing here ever touches a bridge.
//
// Every item is located by coordinates and its id is DERIVED from them (type-prefixed), which is
// what makes collecting idempotent and "is this collected" a keyed lookup rather than a scan.

export type CollectionItemType = "series" | "chapter" | "page";

export interface SeriesItemCoord {
  bridgeId: string;
  seriesId: string;
}
/** `chapterId` carries `__direct__` for chapterless series. */
export interface ChapterItemCoord extends SeriesItemCoord {
  chapterId: string;
}
export interface PageItemCoord extends ChapterItemCoord {
  /** 0-based index into the chapter's page list. */
  pageIndex: number;
}

/** Typed coordinates for any favoritable target. */
export type CollectionItemCoord =
  | ({ type: "series" } & SeriesItemCoord)
  | ({ type: "chapter" } & ChapterItemCoord)
  | ({ type: "page" } & PageItemCoord);

/**
 * Stable, derived id: the type token, then each coordinate URL-encoded, joined by `:`. Encoding is
 * what makes the join unambiguous — `encodeURIComponent` escapes `:` itself — and the type prefix
 * is what lets one keyspace hold all three shapes (`series:b:s`, `chapter:b:s:c`, `page:b:s:c:i`).
 */
export function collectionItemId(coord: CollectionItemCoord): string {
  const parts = [coord.bridgeId, coord.seriesId];
  if (coord.type !== "series") parts.push(coord.chapterId);
  if (coord.type === "page") parts.push(String(coord.pageIndex));
  return [coord.type, ...parts.map((s) => encodeURIComponent(s))].join(":");
}

/** Split a `collectionItemId` back into typed coordinates. `undefined` for anything malformed. */
export function parseCollectionItemId(id: string): CollectionItemCoord | undefined {
  const [type, ...rest] = id.split(":");
  const arity = type === "series" ? 2 : type === "chapter" ? 3 : type === "page" ? 4 : -1;
  if (arity === -1 || rest.length !== arity) return undefined;
  let decoded: string[];
  try {
    decoded = rest.map((p) => decodeURIComponent(p));
  } catch {
    return undefined; // invalid percent-escape
  }
  const [bridgeId, seriesId, chapterId, rawIndex] = decoded;
  if (!bridgeId || !seriesId) return undefined;
  if (type === "series") return { type, bridgeId, seriesId };
  if (!chapterId) return undefined;
  if (type === "chapter") return { type, bridgeId, seriesId, chapterId };
  const pageIndex = Number(rawIndex);
  if (rawIndex === "" || !Number.isInteger(pageIndex) || pageIndex < 0) return undefined;
  return { type: "page", bridgeId, seriesId, chapterId: chapterId!, pageIndex };
}

// Display snapshots, supplied by the client when favoriting. Denormalised for the same reason
// `LibraryEntry` caches one: a tile must render with the bridge uninstalled or the source down,
// long after the coordinates stop resolving.

export const seriesItemSnapshotSchema = z.object({
  seriesTitle: z.string().min(1),
  thumbnailUrl: z.string().url().optional(),
  author: z.string().optional(),
});
export type SeriesItemSnapshot = z.infer<typeof seriesItemSnapshotSchema>;

export const chapterItemSnapshotSchema = z.object({
  seriesTitle: z.string().min(1),
  chapterName: z.string().optional(),
  /**
   * Logical-chapter identity, mirroring `Chapter.number`/`languageCode` — the chapter's RE-ANCHOR
   * key. A chapter re-uploaded under a new id is relocated by matching `(number, languageCode)`
   * against the fresh chapter list inside `syncChapters`, the same collapse `knownChapters` uses.
   */
  number: z.number().optional(),
  languageCode: z.string().optional(),
});
export type ChapterItemSnapshot = z.infer<typeof chapterItemSnapshotSchema>;

export const pageItemSnapshotSchema = z.object({
  seriesTitle: z.string().min(1),
  chapterName: z.string().optional(),
  pageCount: z.number().int().nonnegative().optional(),
  /**
   * The page's image URL when it was collected. The cheap re-anchor key: matching it against a
   * freshly-fetched page list relocates a page that merely shifted, at NO network cost — the list is
   * one the reader already fetched to display the chapter. Expected to rot on sources that sign or
   * expire URLs, which is what `contentHash` is for.
   */
  sourceUrl: z.string().optional(),
  /**
   * Fingerprint of the page's image bytes — **lowercase hex SHA-256** — computed by the CLIENT from
   * bytes it already holds, so the host does no image work and stores no pixels. Free to capture
   * here: the user is looking at the page as they collect it.
   *
   * The strong re-anchor key. Unlike `sourceUrl` it survives URL rot and a chapter re-uploaded under
   * a new id. The algorithm is fixed rather than opaque because a hash written at collect time is
   * compared against hashes computed later, possibly by a different client against the same host.
   */
  contentHash: z.string().optional(),
});
export type PageItemSnapshot = z.infer<typeof pageItemSnapshotSchema>;

/** Fields every collection item carries regardless of target type. */
const collectionItemBase = {
  /** `collectionItemId(coord)` — derived, never random. */
  id: z.string().min(1),
  /** Epoch ms; the date sort axis. */
  collectedAt: z.number().int(),
  /** Collection memberships (ids into `Collection`). Empty = uncollected. */
  collectionIds: z.array(z.string()).default([]),
  seriesTitle: z.string().min(1),
  /**
   * Set when the item's target could no longer be located — a page a reconcile couldn't place, or a
   * chapter whose id vanished from a sync with no logical match. A stale item is NEVER deleted: the
   * user collected it deliberately, and the snapshot still renders. It is simply no longer trusted
   * as a pointer, so readers must not highlight or navigate to it. Clears itself when a later
   * reconcile/sync finds the target again.
   */
  stale: z.boolean().optional(),
};

export const collectionSeriesItemSchema = z.object({
  type: z.literal("series"),
  bridgeId: z.string().min(1),
  seriesId: z.string().min(1),
  ...collectionItemBase,
  thumbnailUrl: z.string().url().optional(),
  author: z.string().optional(),
});
export type CollectionSeriesItem = z.infer<typeof collectionSeriesItemSchema>;

export const collectionChapterItemSchema = z.object({
  type: z.literal("chapter"),
  bridgeId: z.string().min(1),
  seriesId: z.string().min(1),
  chapterId: z.string().min(1),
  ...collectionItemBase,
  chapterName: z.string().optional(),
  number: z.number().optional(),
  languageCode: z.string().optional(),
});
export type CollectionChapterItem = z.infer<typeof collectionChapterItemSchema>;

export const collectionPageItemSchema = z.object({
  type: z.literal("page"),
  bridgeId: z.string().min(1),
  seriesId: z.string().min(1),
  chapterId: z.string().min(1),
  pageIndex: z.number().int().nonnegative(),
  ...collectionItemBase,
  chapterName: z.string().optional(),
  /** The chapter's page count when this was collected. Kept current by `reconcileChapterPages`,
   *  which also uses a mismatch as the last-resort "this chapter moved" signal. */
  pageCount: z.number().int().nonnegative().optional(),
  sourceUrl: z.string().optional(),
  contentHash: z.string().optional(),
});
export type CollectionPageItem = z.infer<typeof collectionPageItemSchema>;

/** Any collected target — one keyspace, one store seam, one query surface. */
export const collectionItemSchema = z.discriminatedUnion("type", [
  collectionSeriesItemSchema,
  collectionChapterItemSchema,
  collectionPageItemSchema,
]);
export type CollectionItem = z.infer<typeof collectionItemSchema>;

/**
 * One page of a freshly-fetched chapter, as handed to {@link Library.reconcileChapterPages}.
 * Position in the array IS the page index. Both fields are optional, and populating them is
 * best-effort — see below, because it drives how the matcher may read them.
 */
export interface ChapterPageRef {
  /** The page's image URL as of now. Cheap: the caller fetched the list to render the chapter. */
  url?: string;
  /**
   * Lowercase hex SHA-256 of the page's bytes — see `CollectionPageItem.contentHash`.
   *
   * **Expected to be SPARSE**, and that is the whole design. A client can only hash bytes it holds,
   * which is the page or two it has actually rendered; hashing the full list would mean downloading
   * the chapter just to open it. So callers fill this in for whatever they happen to have and leave
   * the rest blank.
   *
   * The consequence for anything reading this: a hash MISS carries no information (the page may
   * simply be one of the unhashed ones), so only a hash HIT may be acted on. The one exception is
   * positional — a hash present at an item's own index that differs from the item's is proof
   * that the page there is not the saved one.
   */
  contentHash?: string;
}

/**
 * Which items a {@link LibraryStore.listCollectionItems} call is interested in. Omitted fields
 * don't constrain. Stores MUST honour it: it is what keeps a chapter open from loading a whole
 * library's items, and what lets an indexed backend answer without a scan.
 */
export interface CollectionItemScope {
  type?: CollectionItemType;
  bridgeId?: string;
  seriesId?: string;
  chapterId?: string;
}

/**
 * A user-created grouping of collection items — the ONE grouping concept in the app (the old
 * library "lists" retired into this; local "favorites" dissolved into it). Deliberately not called
 * "tags": that word belongs to bridge content/genre tags (`getTags`, `excludedTags`).
 */
export const collectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Sort position among collections (ascending). */
  order: z.number(),
});
export type Collection = z.infer<typeof collectionSchema>;

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
  /**
   * Monotonic WATERMARK: the highest chapter number the tracker is known to hold — either because we
   * pushed it or because a pull reported it. Never lowered, mirroring the fact that a pull only ever
   * marks chapters read and never un-marks them.
   *
   * It exists because the tracker's own reported progress is a lossy echo and cannot be compared
   * against local progress directly: AniList's `progress` and MAL's `num_chapters_read` are integers,
   * so a decimal chapter 12.5 comes back as 12 forever. Comparing local-vs-echo makes local look
   * permanently "ahead" and re-pushes on every sync; comparing local-vs-watermark settles.
   */
  chaptersRead: z.number().optional(),
  /**
   * The tracker's own chapter count for this media, mirrored from the last pull. Drives two things
   * the local chapter list can't: deciding the series is finished (progress reached the total), and
   * clamping what we push, so a tracker is never told about more chapters than it believes exist.
   */
  totalChapters: z.number().int().positive().optional(),
  /**
   * When we successfully told this tracker the series is FINISHED, epoch ms.
   *
   * Deliberately separate from `status`, which a pull overwrites with the tracker's own truth (see
   * `applyTrackerItem`). If completion were inferred from `status`, a user who deliberately set a
   * fully-read series to "dropped" on the service would have "completed" re-pushed over it on every
   * background sync. This records only what WE sent, so the push happens exactly once.
   */
  completedPushedAt: z.number().int().optional(),
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
