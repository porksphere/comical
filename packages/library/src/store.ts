/**
 * The persistence seam for the library. The `Library` service holds ALL domain logic; a store is a
 * dumb, typed document sink. Keeping it minimal and purpose-built (rather than a generic KV) lets
 * platform backends be efficient: a filesystem store writes JSON, a browser store uses IndexedDB,
 * a native store uses SQLite — each implements exactly these methods.
 *
 * Keys are `entryKey(bridgeId, seriesId)`.
 */
import type { ActivityItem, BridgePrefs, ChapterProgress, HistoryItem, KnownChapter, LibraryEntry, LibraryList, SeriesGroup, TrackerLink } from "./models.ts";

export interface LibraryStore {
  // ── Entries ──────────────────────────────────────────────────────────────
  listEntries(): Promise<LibraryEntry[]>;
  getEntry(key: string): Promise<LibraryEntry | undefined>;
  putEntry(entry: LibraryEntry): Promise<void>;
  deleteEntry(key: string): Promise<void>;

  // ── Known chapters ────────────────────────────────────────────────────────
  //
  // Chapter lists live BESIDE the entry, not inside it. They dwarf everything else — a long series
  // is thousands of chapters, and a real library measured 84% chapter list by weight, with one entry
  // at 73KB. While they were a field on the entry, the only way to touch them was to rewrite the
  // whole entry, which meant every page turn (which updates the resume cache) rewrote all of them.
  // Given the entry is also one LWW register on the wire, that made a page turn cost 73KB of sync.
  // Same key as progress: `entryKey(bridgeId, seriesId)`.
  listChapters(key: string): Promise<KnownChapter[]>;
  /** Full replace — `syncChapters` always reconciles against a complete freshly-fetched list. */
  putChapters(key: string, chapters: KnownChapter[]): Promise<void>;
  /** Drop the chapter list for a series (called when an entry is removed). */
  deleteChaptersForEntry(key: string): Promise<void>;

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
