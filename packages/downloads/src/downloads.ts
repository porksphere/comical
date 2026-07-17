/**
 * The downloads domain service. ALL behaviour lives here so every store backend (memory, file,
 * AsyncStorage, SQLite) and every host behaves identically — a store only persists documents.
 *
 * The service is platform-agnostic: it owns the *manifest* (which chapters/pages are downloaded,
 * their state, and byte sizes), the storage accounting, and the deletion cascade. It never touches a
 * filesystem or the network. A host drives it:
 *   1. `enqueueChapter(snapshot, chapter, pages)` records the intent (everything `queued`).
 *   2. the host fetches each page's bytes, writes them to disk, and calls
 *      `recordPage(key, chapterId, index, file, bytes)` — the service rolls up chapter/series totals
 *      and flips state to `complete` once every page has bytes.
 *   3. `deleteChapter` / `deleteSeries` / `deleteAll` return the on-disk `file` paths for the host to
 *      remove; the service purges the manifest.
 *
 * Identity is the cross-bridge pair `(bridgeId, seriesId)`, encoded via `entryKey`.
 */
import {
  entryKey,
  parseEntryKey,
  type DownloadPrefs,
  type DownloadState,
  type DownloadedChapter,
  type DownloadedPage,
  type DownloadedSeries,
  type StorageUsage,
  type StorageUsageSeries,
} from "./models.ts";
import type { DownloadsStore } from "./store.ts";

/** A series snapshot supplied when enqueuing (cached for offline rendering / bridge removal). */
export interface DownloadSeriesSnapshot {
  bridgeId: string;
  seriesId: string;
  title: string;
  thumbnailUrl?: string;
  author?: string;
}

/** Chapter metadata supplied when enqueuing. */
export interface DownloadChapterMeta {
  chapterId: string;
  chapterName?: string;
  number?: number;
  languageCode?: string;
}

/** One page to download: its ordinal `index` and the bridge's raw `imageUrl` (+ optional headers). */
export interface DownloadPageInput {
  index: number;
  sourceUrl: string;
  headers?: Record<string, string>;
}

export interface DownloadsOptions {
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** A single page still needing bytes — returned by {@link Downloads.requeueMissing}. */
export interface PendingPage {
  index: number;
  sourceUrl: string;
  headers?: Record<string, string>;
}

export class Downloads {
  private readonly now: () => number;

  constructor(
    private readonly store: DownloadsStore,
    opts: DownloadsOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  // ── Enqueue ─────────────────────────────────────────────────────────────────

  /**
   * Record the intent to download a chapter: upserts the series snapshot, creates (or resets) the
   * chapter as `queued`, and lays down one `queued` page row per input page. Idempotent — enqueuing
   * an already-complete chapter re-queues only pages that aren't complete.
   *
   * `pages` may be OMITTED (a lazy enqueue): the chapter is recorded `queued` with
   * `pagesResolved: false` and NO page rows are touched — a pure store write, so bulk enqueues land
   * the whole queue instantly and survive interruption. Whoever drains the queue resolves the page
   * list later ({@link resolveChapterPages}); the fresh resolution also means the source URLs can't
   * have gone stale between enqueue and download.
   */
  async enqueueChapter(
    snap: DownloadSeriesSnapshot,
    meta: DownloadChapterMeta,
    pages?: DownloadPageInput[],
  ): Promise<DownloadedChapter> {
    const key = entryKey(snap.bridgeId, snap.seriesId);
    const t = this.now();

    // Upsert the series snapshot (refresh display fields; keep addedAt).
    const existingSeries = await this.store.getSeries(key);
    const series: DownloadedSeries = existingSeries
      ? { ...existingSeries, title: snap.title }
      : { bridgeId: snap.bridgeId, seriesId: snap.seriesId, title: snap.title, chapterCount: 0, bytes: 0, addedAt: t };
    if (snap.thumbnailUrl !== undefined) series.thumbnailUrl = snap.thumbnailUrl;
    if (snap.author !== undefined) series.author = snap.author;
    await this.store.putSeries(series);

    if (pages) await this.writePages(key, meta.chapterId, pages);

    const existingChapter = await this.store.getChapter(key, meta.chapterId);
    const chapter: DownloadedChapter = {
      bridgeId: snap.bridgeId,
      seriesId: snap.seriesId,
      chapterId: meta.chapterId,
      // A lazy enqueue keeps any prior count so a partial chapter's progress display stays sensible.
      pageCount: pages ? pages.length : (existingChapter?.pageCount ?? 0),
      completedPages: existingChapter?.completedPages ?? 0,
      bytes: existingChapter?.bytes ?? 0,
      state: "queued",
      addedAt: existingChapter?.addedAt ?? t,
    };
    if (!pages) chapter.pagesResolved = false;
    if (meta.chapterName !== undefined) chapter.chapterName = meta.chapterName;
    if (meta.number !== undefined) chapter.number = meta.number;
    if (meta.languageCode !== undefined) chapter.languageCode = meta.languageCode;
    await this.store.putChapter(chapter);
    await this.rollUpSeries(key);
    // Recompute state in case pages were already complete from a prior download.
    return this.recomputeChapter(key, meta.chapterId);
  }

  /**
   * Supply the resolved page list for a lazily-enqueued chapter (see {@link enqueueChapter} without
   * `pages`): lays down the page rows (preserving already-complete bytes, exactly like an eager
   * enqueue), sets `pageCount`, and clears the `pagesResolved: false` marker.
   */
  async resolveChapterPages(key: string, chapterId: string, pages: DownloadPageInput[]): Promise<DownloadedChapter> {
    const chapter = await this.requireChapter(key, chapterId);
    await this.writePages(key, chapterId, pages);
    const next: DownloadedChapter = { ...chapter, pageCount: pages.length };
    delete next.pagesResolved;
    await this.store.putChapter(next);
    return this.recomputeChapter(key, chapterId);
  }

  /**
   * Mark a chapter failed as a whole — for failures that happen BEFORE any page exists to blame
   * (page-list resolution failing on a lazy enqueue). A retry (`requeueMissing`) puts it back to
   * `queued`, and — its `pagesResolved` marker still unset — resolution is attempted again.
   */
  async failChapter(key: string, chapterId: string): Promise<DownloadedChapter> {
    const chapter = await this.requireChapter(key, chapterId);
    const next: DownloadedChapter = { ...chapter, state: "failed" };
    await this.store.putChapter(next);
    return next;
  }

  // ── Progress ────────────────────────────────────────────────────────────────

  /**
   * Mark one page complete with its on-disk `file` path and byte size, then roll up the chapter and
   * series totals (chapter → `complete` once every page has bytes). Throws if the chapter isn't known.
   */
  async recordPage(key: string, chapterId: string, index: number, file: string, bytes: number): Promise<DownloadedChapter> {
    await this.requireChapter(key, chapterId);
    const pages = await this.store.listPages(key, chapterId);
    const page = pages.find((p) => p.index === index);
    if (!page) throw new Error(`page not downloaded: ${chapterId}#${index}`);
    await this.store.putPage(key, chapterId, { ...page, file, bytes, state: "complete" });
    return this.recomputeChapter(key, chapterId);
  }

  /** Mark one page failed (its bytes never landed); flips the chapter to `failed`. */
  async failPage(key: string, chapterId: string, index: number): Promise<DownloadedChapter> {
    await this.requireChapter(key, chapterId);
    const pages = await this.store.listPages(key, chapterId);
    const page = pages.find((p) => p.index === index);
    if (page) await this.store.putPage(key, chapterId, { ...page, state: "failed" });
    return this.recomputeChapter(key, chapterId);
  }

  /**
   * Re-queue every page of a chapter that isn't `complete` and return them, so a host can resume a
   * partial/failed download by fetching only the missing bytes. Sets the chapter back to `queued`.
   */
  async requeueMissing(key: string, chapterId: string): Promise<PendingPage[]> {
    await this.requireChapter(key, chapterId);
    const pages = await this.store.listPages(key, chapterId);
    const missing: PendingPage[] = [];
    for (const p of pages) {
      if (p.state === "complete") continue;
      await this.store.putPage(key, chapterId, { ...p, state: "queued" });
      const pending: PendingPage = { index: p.index, sourceUrl: p.sourceUrl };
      if (p.headers !== undefined) pending.headers = p.headers;
      missing.push(pending);
    }
    await this.recomputeChapter(key, chapterId);
    return missing.sort((a, b) => a.index - b.index);
  }

  /**
   * Chapters that still need work (`queued`/`downloading`), across all series — the work queue.
   * `paused` (cancelled) and `failed` chapters are excluded so the queue never auto-retries them or
   * spins on a persistent error: a paused chapter resumes to `queued`, and a failed one is re-queued
   * by an explicit retry (`requeueMissing`) — both of which put it back here.
   */
  async pendingChapters(): Promise<DownloadedChapter[]> {
    const out: DownloadedChapter[] = [];
    for (const series of await this.store.listSeries()) {
      const key = entryKey(series.bridgeId, series.seriesId);
      for (const c of await this.store.listChapters(key)) {
        if (c.state !== "complete" && c.state !== "paused" && c.state !== "failed") out.push(c);
      }
    }
    return out.sort((a, b) => a.addedAt - b.addedAt);
  }

  // ── Pause / resume (cancel a download, keep the bytes already fetched) ──────────

  /** Pause an in-flight/queued/failed chapter so it stops draining; downloaded pages are kept. */
  async pauseChapter(key: string, chapterId: string): Promise<DownloadedChapter> {
    const chapter = await this.requireChapter(key, chapterId);
    if (chapter.state === "complete" || chapter.state === "paused") return chapter;
    const next: DownloadedChapter = { ...chapter, state: "paused" };
    await this.store.putChapter(next);
    return next;
  }

  /** Resume a paused chapter — back to `queued` so the engine drains its remaining pages. */
  async resumeChapter(key: string, chapterId: string): Promise<DownloadedChapter> {
    const chapter = await this.requireChapter(key, chapterId);
    if (chapter.state !== "paused") return chapter;
    const next: DownloadedChapter = { ...chapter, state: "queued" };
    await this.store.putChapter(next);
    return next;
  }

  /** Pause every not-yet-complete chapter of a series (cancel the whole series' in-flight work). */
  async pauseSeries(key: string): Promise<void> {
    for (const c of await this.store.listChapters(key)) {
      if (c.state !== "complete" && c.state !== "paused") {
        await this.store.putChapter({ ...c, state: "paused" });
      }
    }
  }

  /** Resume every paused chapter of a series. */
  async resumeSeries(key: string): Promise<void> {
    for (const c of await this.store.listChapters(key)) {
      if (c.state === "paused") await this.store.putChapter({ ...c, state: "queued" });
    }
  }

  // ── Read / offline lookup ─────────────────────────────────────────────────────

  async getSeries(key: string): Promise<DownloadedSeries | undefined> {
    return this.store.getSeries(key);
  }

  /** All chapters recorded for a series (any state). */
  async listChapters(key: string): Promise<DownloadedChapter[]> {
    return this.store.listChapters(key);
  }

  async getChapter(key: string, chapterId: string): Promise<DownloadedChapter | undefined> {
    return this.store.getChapter(key, chapterId);
  }

  /** The ordered page list for a chapter — the offline page-LIST fallback when the bridge is unreachable. */
  async getManifestPages(key: string, chapterId: string): Promise<DownloadedPage[]> {
    return (await this.store.listPages(key, chapterId)).sort((a, b) => a.index - b.index);
  }

  /**
   * The on-disk `file` path for a single page, or `undefined` if it isn't downloaded — the offline
   * image lookup. Keyed on `(bridge, series, chapter, index)`, never the raw URL (which can differ
   * run-to-run).
   */
  async localFileFor(bridgeId: string, seriesId: string, chapterId: string, index: number): Promise<string | undefined> {
    const pages = await this.store.listPages(entryKey(bridgeId, seriesId), chapterId);
    const page = pages.find((p) => p.index === index && p.state === "complete" && p.file);
    return page?.file;
  }

  /** Whether a chapter is fully downloaded (every page complete). */
  async isChapterComplete(key: string, chapterId: string): Promise<boolean> {
    const chapter = await this.store.getChapter(key, chapterId);
    return chapter?.state === "complete";
  }

  // ── Deletion (returns blob paths for the host to remove) ───────────────────────

  /** Delete one chapter; returns the on-disk `file` paths to remove. Prunes the series if now empty. */
  async deleteChapter(key: string, chapterId: string): Promise<string[]> {
    const files = (await this.store.listPages(key, chapterId)).map((p) => p.file).filter((f): f is string => !!f);
    await this.store.deletePagesForChapter(key, chapterId);
    await this.store.deleteChapter(key, chapterId);
    const remaining = await this.store.listChapters(key);
    if (remaining.length === 0) {
      await this.store.deleteSeries(key);
    } else {
      await this.rollUpSeries(key);
    }
    return files;
  }

  /** Delete an entire series; returns all its on-disk `file` paths to remove. */
  async deleteSeries(key: string): Promise<string[]> {
    const files: string[] = [];
    for (const c of await this.store.listChapters(key)) {
      for (const p of await this.store.listPages(key, c.chapterId)) {
        if (p.file) files.push(p.file);
      }
      await this.store.deletePagesForChapter(key, c.chapterId);
    }
    await this.store.deleteChaptersForEntry(key);
    await this.store.deleteSeries(key);
    return files;
  }

  /** Delete everything; returns all on-disk `file` paths to remove. */
  async deleteAll(): Promise<string[]> {
    const files: string[] = [];
    for (const series of await this.store.listSeries()) {
      files.push(...(await this.deleteSeries(entryKey(series.bridgeId, series.seriesId))));
    }
    return files;
  }

  // ── Storage accounting ─────────────────────────────────────────────────────────

  /** The full storage-usage tree (series → chapters), with rolled-up byte and count totals. */
  async getStorageUsage(): Promise<StorageUsage> {
    const bySeries: StorageUsageSeries[] = [];
    let totalBytes = 0;
    let chapterCount = 0;
    let pageCount = 0;
    for (const series of await this.store.listSeries()) {
      const key = entryKey(series.bridgeId, series.seriesId);
      const chapters = (await this.store.listChapters(key)).sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
      for (const c of chapters) {
        totalBytes += c.bytes;
        chapterCount += 1;
        pageCount += c.pageCount;
      }
      bySeries.push({ ...series, chapters });
    }
    bySeries.sort((a, b) => b.bytes - a.bytes);
    return { totalBytes, seriesCount: bySeries.length, chapterCount, pageCount, bySeries };
  }

  // ── Preferences ─────────────────────────────────────────────────────────────────

  async getPrefs(): Promise<DownloadPrefs> {
    return (await this.store.getPrefs()) ?? { wifiOnly: true, background: false };
  }

  async setPrefs(prefs: DownloadPrefs): Promise<DownloadPrefs> {
    await this.store.setPrefs(prefs);
    return prefs;
  }

  // ── Internals ─────────────────────────────────────────────────────────────────

  /** Lay down page rows, merging against existing ones so already-complete bytes are preserved. */
  private async writePages(key: string, chapterId: string, pages: DownloadPageInput[]): Promise<void> {
    const existingPages = new Map((await this.store.listPages(key, chapterId)).map((p) => [p.index, p]));
    for (const input of pages) {
      const prior = existingPages.get(input.index);
      if (prior?.state === "complete") {
        // Keep the downloaded bytes; just refresh the source in case it changed.
        const kept: DownloadedPage = { ...prior, sourceUrl: input.sourceUrl };
        if (input.headers !== undefined) kept.headers = input.headers;
        await this.store.putPage(key, chapterId, kept);
        continue;
      }
      const page: DownloadedPage = { index: input.index, sourceUrl: input.sourceUrl, file: "", bytes: 0, state: "queued" };
      if (input.headers !== undefined) page.headers = input.headers;
      await this.store.putPage(key, chapterId, page);
    }
  }

  private async requireChapter(key: string, chapterId: string): Promise<DownloadedChapter> {
    const chapter = await this.store.getChapter(key, chapterId);
    if (!chapter) {
      const { bridgeId, seriesId } = parseEntryKey(key);
      throw new Error(`chapter not downloaded: ${bridgeId}/${seriesId}/${chapterId}`);
    }
    return chapter;
  }

  /** Recompute a chapter's rolled-up bytes/progress + state from its pages, then roll the series up. */
  private async recomputeChapter(key: string, chapterId: string): Promise<DownloadedChapter> {
    const chapter = await this.requireChapter(key, chapterId);
    const pages = await this.store.listPages(key, chapterId);
    const bytes = pages.reduce((sum, p) => sum + p.bytes, 0);
    const completedPages = pages.filter((p) => p.state === "complete").length;
    const derived = deriveChapterState(pages);
    // `paused` is a chapter-level flag the user set; it survives a recompute until explicitly resumed
    // (or until every page is complete, at which point the chapter is genuinely done).
    const state = chapter.state === "paused" && derived !== "complete" ? "paused" : derived;
    const next: DownloadedChapter = { ...chapter, bytes, completedPages, state };
    if (state === "complete") {
      next.completedAt = chapter.completedAt ?? this.now();
      // Every page has bytes, so an unresolved-pages marker is stale by definition.
      delete next.pagesResolved;
    } else {
      delete next.completedAt;
    }
    await this.store.putChapter(next);
    await this.rollUpSeries(key);
    return next;
  }

  /** Recompute a series' rolled-up chapterCount + bytes from its chapters. */
  private async rollUpSeries(key: string): Promise<void> {
    const series = await this.store.getSeries(key);
    if (!series) return;
    const chapters = await this.store.listChapters(key);
    await this.store.putSeries({
      ...series,
      chapterCount: chapters.length,
      bytes: chapters.reduce((sum, c) => sum + c.bytes, 0),
    });
  }
}

/**
 * A chapter's state is the aggregate of its pages: `complete` when every page is complete, `failed`
 * if any page failed, `downloading` if some (but not all) pages are complete, else `queued`.
 */
function deriveChapterState(pages: DownloadedPage[]): DownloadState {
  if (pages.length === 0) return "queued";
  if (pages.every((p) => p.state === "complete")) return "complete";
  if (pages.some((p) => p.state === "failed")) return "failed";
  if (pages.some((p) => p.state === "complete")) return "downloading";
  return "queued";
}
