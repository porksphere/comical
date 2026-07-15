/**
 * The persistence seam for downloads. The `Downloads` service holds ALL domain logic; a store is a
 * dumb, typed document sink — the same contract `@comical/library`'s `LibraryStore` follows. Keeping
 * it minimal lets platform backends be efficient: a filesystem store writes JSON, a native store uses
 * AsyncStorage/SQLite, each implementing exactly these methods.
 *
 * Series/chapter keys are `entryKey(bridgeId, seriesId)`. Pages live BESIDE their chapter (their own
 * methods, keyed by `(entryKey, chapterId)`) because they are the bulk of a download and recording
 * one page's bytes must not rewrite the whole list — the same split `LibraryStore` uses for chapters.
 */
import type { DownloadPrefs, DownloadedChapter, DownloadedPage, DownloadedSeries } from "./models.ts";

export interface DownloadsStore {
  // ── Series ─────────────────────────────────────────────────────────────────
  listSeries(): Promise<DownloadedSeries[]>;
  getSeries(key: string): Promise<DownloadedSeries | undefined>;
  putSeries(series: DownloadedSeries): Promise<void>;
  deleteSeries(key: string): Promise<void>;

  // ── Chapters (beside the series) ────────────────────────────────────────────
  listChapters(key: string): Promise<DownloadedChapter[]>;
  getChapter(key: string, chapterId: string): Promise<DownloadedChapter | undefined>;
  putChapter(chapter: DownloadedChapter): Promise<void>;
  deleteChapter(key: string, chapterId: string): Promise<void>;
  /** Drop every chapter for a series (called when the series is removed). */
  deleteChaptersForEntry(key: string): Promise<void>;

  // ── Pages (beside the chapter) ──────────────────────────────────────────────
  listPages(key: string, chapterId: string): Promise<DownloadedPage[]>;
  putPage(key: string, chapterId: string, page: DownloadedPage): Promise<void>;
  /** Drop all pages for a chapter (called when the chapter is removed). */
  deletePagesForChapter(key: string, chapterId: string): Promise<void>;

  // ── Preferences ─────────────────────────────────────────────────────────────
  getPrefs(): Promise<DownloadPrefs | undefined>;
  setPrefs(prefs: DownloadPrefs): Promise<void>;
}
