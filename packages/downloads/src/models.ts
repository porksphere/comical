/**
 * The downloads data model, as zod schemas with inferred TS types.
 *
 * A "download" is a durable, offline-readable copy of a chapter: the ordered list of its pages, each
 * page's raw (unresolved) bridge image URL, and the relative path of the fully-downloaded bytes on
 * disk. Like `@comical/library` this is app-side state keyed by the cross-bridge pair
 * `(bridgeId, seriesId)`, and it caches a small display snapshot of the series so downloads render
 * offline and survive the bridge being uninstalled.
 *
 * The `Downloads` service (`downloads.ts`) owns all domain logic — state transitions, storage
 * accounting, and the deletion cascade. It is platform-agnostic: it stores only the *manifest* (which
 * pages exist, their `file` path, and byte sizes). The actual image bytes and the filesystem they
 * live on are a platform concern — a host fetches bytes, writes them, and passes the relative `file`
 * path and `bytes` back via `recordPage`; on deletion the service returns the `file` paths for the
 * host to remove. Nothing here touches `fs`, `fetch`, or the DOM.
 */
import { z } from "zod";

/** Stable, cross-bridge key for a downloaded series. Matches `@comical/library`'s `entryKey`. */
export function entryKey(bridgeId: string, seriesId: string): string {
  return `${bridgeId}:${seriesId}`;
}

/** Split a key back into its parts. `bridgeId` is `[a-z0-9-]` so the first `:` is the separator. */
export function parseEntryKey(key: string): { bridgeId: string; seriesId: string } {
  const i = key.indexOf(":");
  if (i === -1) return { bridgeId: key, seriesId: "" };
  return { bridgeId: key.slice(0, i), seriesId: key.slice(i + 1) };
}

/**
 * Lifecycle of a download unit (page or chapter).
 * - `queued` — recorded, no bytes yet.
 * - `downloading` — some but not all pages complete.
 * - `complete` — every page has bytes on disk.
 * - `failed` — a page (or the whole chapter) errored; a retry re-fetches only what's missing.
 * - `paused` — the user cancelled an in-flight/queued download; it won't auto-drain until resumed (a
 *   chapter-level state only — pages keep their own states so a resume re-fetches only what's missing).
 */
export const downloadStateSchema = z.enum(["queued", "downloading", "complete", "failed", "paused"]);
export type DownloadState = z.infer<typeof downloadStateSchema>;

/**
 * One page of a downloaded chapter.
 *
 * We persist BOTH the raw `sourceUrl` (the bridge's unresolved `Page.imageUrl`) AND the local `file`
 * because bridge image URLs are frequently server-relative / time-scoped resolve routes: a resolved
 * CDN URL expires and re-resolution needs the live bridge runtime. So offline serving keys on
 * `(bridge, series, chapter, index)` and returns the on-disk bytes, never the raw URL. `headers` are
 * the per-page fetch headers (referer/auth) the contract carries, kept so the downloader can fetch
 * `sourceUrl` directly.
 */
export const downloadedPageSchema = z.object({
  index: z.number().int().nonnegative(),
  /** The bridge's raw, unresolved `Page.imageUrl` (absolute or server-relative). */
  sourceUrl: z.string().min(1),
  /** Relative path of the downloaded bytes under the platform blob root. Empty until `complete`. */
  file: z.string().default(""),
  /** On-disk size in bytes. 0 until `complete`. */
  bytes: z.number().int().nonnegative().default(0),
  /** Per-page fetch headers from `Page.headers` (referer/auth). */
  headers: z.record(z.string(), z.string()).optional(),
  state: downloadStateSchema,
});
export type DownloadedPage = z.infer<typeof downloadedPageSchema>;

/**
 * A downloaded chapter's manifest metadata. The page LIST lives BESIDE the chapter in the store
 * (`DownloadsStore.listPages`), not inline — pages are the bulk of a download, and recording one
 * page's bytes must not rewrite the whole list. `bytes` is the rolled-up sum of its pages.
 */
export const downloadedChapterSchema = z.object({
  bridgeId: z.string().min(1),
  seriesId: z.string().min(1),
  chapterId: z.string().min(1),
  chapterName: z.string().optional(),
  /** Decimal chapter number (mirrors `Chapter.number`), when known. */
  number: z.number().optional(),
  /** Language of the chapter (mirrors `Chapter.languageCode`), when known. */
  languageCode: z.string().optional(),
  pageCount: z.number().int().nonnegative(),
  /** Pages with bytes on disk so far — the numerator for a progress radial (denominator `pageCount`). */
  completedPages: z.number().int().nonnegative().default(0),
  /** Rolled-up total bytes across this chapter's pages. */
  bytes: z.number().int().nonnegative().default(0),
  state: downloadStateSchema,
  addedAt: z.number().int(),
  completedAt: z.number().int().optional(),
});
export type DownloadedChapter = z.infer<typeof downloadedChapterSchema>;

/**
 * A downloaded series: a cached display snapshot (so it renders offline / survives bridge removal)
 * plus rolled-up totals across its chapters. The chapter list lives beside it in the store.
 */
export const downloadedSeriesSchema = z.object({
  bridgeId: z.string().min(1),
  seriesId: z.string().min(1),
  /** Cached display snapshot. */
  title: z.string().min(1),
  thumbnailUrl: z.string().url().optional(),
  author: z.string().optional(),
  /** Rolled-up count of downloaded chapters. */
  chapterCount: z.number().int().nonnegative().default(0),
  /** Rolled-up total bytes across all chapters. */
  bytes: z.number().int().nonnegative().default(0),
  addedAt: z.number().int(),
});
export type DownloadedSeries = z.infer<typeof downloadedSeriesSchema>;

/** User preferences for downloading, persisted so they survive restarts. */
export const downloadPrefsSchema = z.object({
  /** When true, downloads only run on Wi-Fi (the host enforces reachability). Default on. */
  wifiOnly: z.boolean().default(true),
  /** When true, the host may drain the queue in OS-granted background windows. Default off. */
  background: z.boolean().default(false),
});
export type DownloadPrefs = z.infer<typeof downloadPrefsSchema>;

/**
 * A derived (non-persisted) storage-usage tree for the settings UI. Computed by
 * `Downloads.getStorageUsage` from the manifest; never stored.
 */
export interface StorageUsage {
  totalBytes: number;
  seriesCount: number;
  chapterCount: number;
  pageCount: number;
  bySeries: StorageUsageSeries[];
  /**
   * The ACTUAL bytes under the serving host's blob root, when that host owns the bytes and its
   * `BlobStore` reports usage. Attached by the router (not computed here — the manifest service has
   * no blob access); a gap versus `totalBytes` surfaces orphaned blobs.
   */
  diskBytes?: number;
}

/** One series node in the {@link StorageUsage} tree, with its chapters. */
export interface StorageUsageSeries extends DownloadedSeries {
  chapters: DownloadedChapter[];
}
