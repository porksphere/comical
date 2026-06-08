/**
 * The persistence seam for the library. The `Library` service holds ALL domain logic; a store is a
 * dumb, typed document sink. Keeping it minimal and purpose-built (rather than a generic KV) lets
 * platform backends be efficient: a filesystem store writes JSON, a browser store uses IndexedDB,
 * a native store uses SQLite — each implements exactly these methods.
 *
 * Keys are `entryKey(bridgeId, seriesId)`.
 */
import type { BridgePrefs, Category, ChapterProgress, HistoryItem, LibraryEntry, SeriesGroup, TrackerLink } from "./models.ts";

export interface LibraryStore {
  // ── Entries ──────────────────────────────────────────────────────────────
  listEntries(): Promise<LibraryEntry[]>;
  getEntry(key: string): Promise<LibraryEntry | undefined>;
  putEntry(entry: LibraryEntry): Promise<void>;
  deleteEntry(key: string): Promise<void>;

  // ── Per-series chapter progress ────────────────────────────────────────────
  listProgress(key: string): Promise<ChapterProgress[]>;
  putProgress(key: string, progress: ChapterProgress): Promise<void>;
  /** Drop all progress for a series (called when an entry is removed). */
  deleteProgressForEntry(key: string): Promise<void>;

  // ── Categories ──────────────────────────────────────────────────────────────
  listCategories(): Promise<Category[]>;
  putCategory(category: Category): Promise<void>;
  deleteCategory(id: string): Promise<void>;

  // ── Series groups ────────────────────────────────────────────────────────
  listGroups(): Promise<SeriesGroup[]>;
  putGroup(group: SeriesGroup): Promise<void>;
  deleteGroup(id: string): Promise<void>;

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
}
