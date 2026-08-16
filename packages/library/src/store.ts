/**
 * The persistence seam for the library. The `Library` service holds ALL domain logic; a store is a
 * dumb, typed document sink. Keeping it minimal and purpose-built (rather than a generic KV) lets
 * platform backends be efficient: a filesystem store writes JSON, a browser store uses IndexedDB,
 * a native store uses SQLite — each implements exactly these methods.
 *
 * Keys are `entryKey(bridgeId, seriesId)`.
 */
import type { ActivityItem, BridgePrefs, CachedChapters, CachedSeriesDetail, ChapterProgress, FavoriteCollection, FavoriteItem, FavoriteItemScope, HistoryItem, LibraryEntry, SeriesGroup, TrackerLink } from "./models.ts";

export interface LibraryStore {
  // ── Entries ──────────────────────────────────────────────────────────────
  listEntries(): Promise<LibraryEntry[]>;
  getEntry(key: string): Promise<LibraryEntry | undefined>;
  putEntry(entry: LibraryEntry): Promise<void>;
  deleteEntry(key: string): Promise<void>;

  /** Optional: the ACTUAL bytes this store's documents occupy (files on disk, AsyncStorage blobs…).
   *  Powers the Storage screen's library figure; excludes cover blobs (the host's covers `BlobStore`
   *  reports those itself). */
  diskUsage?(): Promise<number>;

  // ── Offline metadata cache (beside the entry) ──────────────────────────────
  getSeriesDetail(key: string): Promise<CachedSeriesDetail | undefined>;
  putSeriesDetail(key: string, detail: CachedSeriesDetail): Promise<void>;
  deleteSeriesDetail(key: string): Promise<void>;
  getCachedChapters(key: string): Promise<CachedChapters | undefined>;
  putCachedChapters(key: string, doc: CachedChapters): Promise<void>;
  deleteCachedChapters(key: string): Promise<void>;

  // ── Per-series chapter progress ────────────────────────────────────────────
  listProgress(key: string): Promise<ChapterProgress[]>;
  putProgress(key: string, progress: ChapterProgress): Promise<void>;
  /** Drop all progress for a series (called when an entry is removed). */
  deleteProgressForEntry(key: string): Promise<void>;

  // ── Series groups ────────────────────────────────────────────────────────
  listGroups(): Promise<SeriesGroup[]>;
  putGroup(group: SeriesGroup): Promise<void>;
  deleteGroup(id: string): Promise<void>;

  // ── Favorites (series / chapter / page items) ─────────────────────────────
  // Keyed by the derived `favoriteItemId`. Deliberately scoped + batched rather than
  // list-everything/write-one: favorites are the one collection here with no natural ceiling (a
  // heavy user of a long-running series accumulates thousands), and both the reader's chapter-open
  // path and a reconcile would otherwise cost a full load and a write per record.

  /** Items matching `scope`; every item when it is omitted. Stores MUST honour the scope —
   *  it is what keeps opening a chapter off the whole-library path. */
  listFavoriteItems(scope?: FavoriteItemScope): Promise<FavoriteItem[]>;
  /** One item by its derived id — the keyed lookup that makes "is this favorited" O(1)
   *  rather than a scan. */
  getFavoriteItem(id: string): Promise<FavoriteItem | undefined>;
  /** Upsert a batch (the derived id makes each idempotent). One call must cost ONE durable write,
   *  however many records it carries — a reconcile repairs a whole chapter through it. */
  putFavoriteItems(items: FavoriteItem[]): Promise<void>;
  /** Delete a batch. Same one-write-per-call expectation as `putFavoriteItems`. */
  deleteFavoriteItems(ids: string[]): Promise<void>;

  /** Collections are a small ordered array — the whole document is read and written at once, so a
   *  reorder or a cascading delete is a single write rather than N racing read-modify-writes. */
  listFavoriteCollections(): Promise<FavoriteCollection[]>;
  putFavoriteCollections(collections: FavoriteCollection[]): Promise<void>;

  // ── Tracker links ─────────────────────────────────────────────────────────
  listTrackerLinks(key: string): Promise<TrackerLink[]>;
  putTrackerLink(key: string, link: TrackerLink): Promise<void>;
  deleteTrackerLink(key: string, trackerId: string): Promise<void>;

  // ── Reading log (non-library reads) ───────────────────────────────────────
  /** One entry per series; keyed by `bridgeId:seriesId`. */
  listReadingLog(): Promise<HistoryItem[]>;
  upsertReadingLog(item: HistoryItem): Promise<void>;
  deleteReadingLog(bridgeId: string, seriesId: string): Promise<void>;

  // ── Bridge preferences ────────────────────────────────────────────────────
  getBridgePrefs(bridgeId: string): Promise<BridgePrefs | undefined>;
  setBridgePrefs(bridgeId: string, prefs: BridgePrefs): Promise<void>;

  // ── Activity feed (newly-detected chapters) ────────────────────────────────
  /** Every recorded activity event; keyed internally by `bridgeId:seriesId:chapterId`. */
  listActivity(): Promise<ActivityItem[]>;
  /** Upsert one event (dedup on its composite key). */
  putActivity(item: ActivityItem): Promise<void>;
  /** Drop all activity for a series (called when an entry is removed). */
  deleteActivityForEntry(key: string): Promise<void>;
  /** Drop the entire feed. */
  clearActivity(): Promise<void>;
}
