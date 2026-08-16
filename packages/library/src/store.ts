/**
 * The persistence seam for the library. The `Library` service holds ALL domain logic; a store is a
 * dumb, typed document sink. Keeping it minimal and purpose-built (rather than a generic KV) lets
 * platform backends be efficient: a filesystem store writes JSON, a browser store uses IndexedDB,
 * a native store uses SQLite — each implements exactly these methods.
 *
 * Keys are `entryKey(bridgeId, seriesId)`.
 */
import type { ActivityItem, BridgePrefs, CachedChapters, CachedSeriesDetail, ChapterProgress, FavoriteCollection, FavoritePage, HistoryItem, LibraryEntry, LibraryList, SeriesGroup, TrackerLink } from "./models.ts";

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

  // ── Lists ─────────────────────────────────────────────────────────────────────
  listLists(): Promise<LibraryList[]>;
  putList(list: LibraryList): Promise<void>;
  deleteList(id: string): Promise<void>;

  // ── Series groups ────────────────────────────────────────────────────────
  listGroups(): Promise<SeriesGroup[]>;
  putGroup(group: SeriesGroup): Promise<void>;
  deleteGroup(id: string): Promise<void>;

  // ── Page favorites ────────────────────────────────────────────────────────
  /** Every favorited page; keyed internally by its derived `favoritePageId`. */
  listFavoritePages(): Promise<FavoritePage[]>;
  /** Upsert one favorite (the derived id makes this idempotent). */
  putFavoritePage(page: FavoritePage): Promise<void>;
  deleteFavoritePage(id: string): Promise<void>;

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
