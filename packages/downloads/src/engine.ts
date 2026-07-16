/**
 * The portable download engine: the drain loop that turns a queued manifest into bytes on disk.
 * Runs identically on every host — the host injects the three platform seams:
 *
 *  - a {@link BlobStore} (where bytes land),
 *  - a {@link PageFetcher} (how a page's `sourceUrl` becomes bytes — server: in-process router
 *    resolution; device: the reader's own asset resolver),
 *  - an optional `mayDownload` gate (device Wi-Fi-only policy; servers omit it).
 *
 * The manifest IS the persisted queue (chapter `state`), so an interrupted run resumes when the host
 * calls `kick()` at boot. `drain()` is single-flight and re-reads pending work each pass, so
 * re-entrant calls are cheap no-ops and newly enqueued chapters are picked up by a running loop.
 *
 * Progress is push-based: hosts/UIs `subscribe()` to typed events (per-page advance, chapter state
 * transitions, deletions, queue idle) instead of polling — the seam that feeds both an SSE stream
 * (remote clients) and direct in-process subscriptions (embedded clients).
 */
import { entryKey, parseEntryKey, type DownloadedChapter, type DownloadedPage } from "./models.ts";
import type {
  Downloads,
  DownloadChapterMeta,
  DownloadPageInput,
  DownloadSeriesSnapshot,
  PendingPage,
} from "./downloads.ts";
import type { BlobStore } from "./blob-store.ts";
import { extFor, relPathFor } from "./paths.ts";

/** One fetched page: its raw bytes plus the response media type (used to pick the file extension). */
export interface FetchedPage {
  data: Uint8Array;
  contentType?: string;
}

/** Fetch one page's bytes. Throwing marks the attempt failed (the engine retries, then `failPage`s). */
export type PageFetcher = (
  ctx: { bridgeId: string; seriesId: string; chapterId: string },
  page: PendingPage,
) => Promise<FetchedPage>;

/** A progress/state event pushed to subscribers. */
export type DownloadEngineEvent =
  /** One page landed — carries the chapter's rolled-up progress so UIs can patch caches in place. */
  | {
      type: "page";
      bridgeId: string;
      seriesId: string;
      chapterId: string;
      index: number;
      completedPages: number;
      pageCount: number;
      bytes: number;
      state: DownloadedChapter["state"];
    }
  /** A chapter's state changed (picked up, completed, failed, paused, resumed, enqueued). */
  | { type: "chapter"; chapter: DownloadedChapter }
  /** A bulk series-level change (pause/resume all) — subscribers should refetch that series. */
  | { type: "changed"; bridgeId: string; seriesId: string }
  /** A chapter/series/everything was deleted (no ids = everything). */
  | { type: "deleted"; bridgeId?: string; seriesId?: string; chapterId?: string }
  /** The drain loop went to sleep (queue empty, gated, stopped, or nothing progressing). */
  | { type: "idle" };

export interface DownloadEngineOptions {
  downloads: Downloads;
  blobs: BlobStore;
  fetchPage: PageFetcher;
  /**
   * Policy gate checked before each chapter: return false to hold the queue (device Wi-Fi-only /
   * metered-network rules). Defaults to always-allowed (servers don't gate).
   */
  mayDownload?: () => Promise<boolean>;
  /**
   * Pages per chapter fetched at once. Defaults to 1 — sequential fetching avoids hammering sources
   * into rate-limiting and keeps progress advancing steadily instead of lurching.
   */
  pageConcurrency?: number;
  /** Fetch attempts per page before it's marked failed. Defaults to 2. */
  attemptsPerPage?: number;
  /** Called between attempts on a page that failed once (device hosts bust a stale asset resolve). */
  onPageRetry?: (page: PendingPage) => void;
}

export class DownloadEngine {
  readonly downloads: Downloads;
  readonly blobs: BlobStore;
  private readonly fetchPage: PageFetcher;
  private readonly mayDownload: () => Promise<boolean>;
  private readonly pageConcurrency: number;
  private readonly attemptsPerPage: number;
  private readonly onPageRetry: ((page: PendingPage) => void) | undefined;

  private readonly listeners = new Set<(e: DownloadEngineEvent) => void>();
  private drainPromise: Promise<void> | null = null;
  private stopRequested = false;
  /** Set when a kick arrives while a loop is running — the loop runs one more pass after settling. */
  private rekick = false;

  // Cancellation markers — the manifest is the source of truth (a paused chapter is excluded from
  // the pending queue), but a chapter the engine is downloading RIGHT NOW is mid-loop, so these let
  // its in-flight page workers bail promptly. Cleared by any re-activation (enqueue/resume), so a
  // stale flag can never block a later download.
  private readonly cancelledChapters = new Set<string>();
  private readonly cancelledSeries = new Set<string>();

  constructor(opts: DownloadEngineOptions) {
    this.downloads = opts.downloads;
    this.blobs = opts.blobs;
    this.fetchPage = opts.fetchPage;
    this.mayDownload = opts.mayDownload ?? (async () => true);
    this.pageConcurrency = opts.pageConcurrency ?? 1;
    this.attemptsPerPage = opts.attemptsPerPage ?? 2;
    this.onPageRetry = opts.onPageRetry;
  }

  // ── Events ───────────────────────────────────────────────────────────────────

  /** Subscribe to progress/state events; returns the unsubscribe. Listener errors are swallowed. */
  subscribe(fn: (e: DownloadEngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: DownloadEngineEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // a broken subscriber must never take down the drain loop
      }
    }
  }

  // ── Queue mutations (each kicks the drain where it makes sense) ────────────────

  /** Enqueue a chapter (idempotent — completed pages are kept) and start draining. */
  async enqueue(
    snap: DownloadSeriesSnapshot,
    meta: DownloadChapterMeta,
    pages: DownloadPageInput[],
  ): Promise<DownloadedChapter> {
    this.clearCancel(entryKey(snap.bridgeId, snap.seriesId), meta.chapterId);
    const chapter = await this.downloads.enqueueChapter(snap, meta, pages);
    this.emit({ type: "chapter", chapter });
    this.kick();
    return chapter;
  }

  /** Pause one in-flight/queued chapter (resumable): flag its workers and pause the manifest. */
  async pauseChapter(key: string, chapterId: string): Promise<DownloadedChapter> {
    this.cancelledChapters.add(chapterCancelKey(key, chapterId));
    const chapter = await this.downloads.pauseChapter(key, chapterId);
    this.emit({ type: "chapter", chapter });
    return chapter;
  }

  /** Resume a paused chapter and kick the drain. */
  async resumeChapter(key: string, chapterId: string): Promise<DownloadedChapter> {
    this.clearCancel(key, chapterId);
    const chapter = await this.downloads.resumeChapter(key, chapterId);
    this.emit({ type: "chapter", chapter });
    this.kick();
    return chapter;
  }

  /** Pause every not-yet-complete chapter of a series and abort the one in flight. */
  async pauseSeries(key: string): Promise<void> {
    this.cancelledSeries.add(key);
    await this.downloads.pauseSeries(key);
    const { bridgeId, seriesId } = parseEntryKey(key);
    this.emit({ type: "changed", bridgeId, seriesId });
  }

  /** Resume every paused chapter of a series and kick the drain. */
  async resumeSeries(key: string): Promise<void> {
    this.clearCancel(key);
    await this.downloads.resumeSeries(key);
    const { bridgeId, seriesId } = parseEntryKey(key);
    this.emit({ type: "changed", bridgeId, seriesId });
    this.kick();
  }

  /** Retry a failed/partial chapter: re-queue its missing pages and drain. */
  async retryChapter(key: string, chapterId: string): Promise<PendingPage[]> {
    this.clearCancel(key, chapterId);
    const missing = await this.downloads.requeueMissing(key, chapterId);
    const chapter = await this.downloads.getChapter(key, chapterId);
    if (chapter) this.emit({ type: "chapter", chapter });
    this.kick();
    return missing;
  }

  // ── Deletion (manifest cascade + blob removal, in one place) ───────────────────

  /** Delete one chapter: purge the manifest, remove its blobs. */
  async deleteChapter(key: string, chapterId: string): Promise<void> {
    const files = await this.downloads.deleteChapter(key, chapterId);
    await this.blobs.remove(files);
    const { bridgeId, seriesId } = parseEntryKey(key);
    this.emit({ type: "deleted", bridgeId, seriesId, chapterId });
  }

  /** Delete a whole series: purge the manifest, remove its blobs. */
  async deleteSeries(key: string): Promise<void> {
    const files = await this.downloads.deleteSeries(key);
    await this.blobs.remove(files);
    const { bridgeId, seriesId } = parseEntryKey(key);
    this.emit({ type: "deleted", bridgeId, seriesId });
  }

  /** Delete everything, sweeping the blob root if the store supports it. */
  async deleteAll(): Promise<void> {
    const files = await this.downloads.deleteAll();
    await this.blobs.remove(files);
    await this.blobs.removeAll?.();
    this.emit({ type: "deleted" });
  }

  // ── The drain loop ──────────────────────────────────────────────────────────────

  /** Fire-and-forget `drain()` — the standard nudge after any mutation or at host boot. */
  kick(): void {
    void this.drain().catch(() => {});
  }

  /** Ask the running drain loop to stop after the current page (e.g. app backgrounding). */
  stop(): void {
    this.stopRequested = true;
  }

  /**
   * Single-flight queue worker. Drains every pending chapter; returns when the queue is empty, the
   * `mayDownload` gate blocks it, or a stop was requested. A re-entrant call joins the running
   * loop's promise instead of starting a second one — but it also flags `rekick`, so the loop runs
   * ONE MORE full pass after it settles. Without that, work re-activated while a loop is winding
   * down gets lost: resuming a just-paused chapter races the dying loop's final (empty) pending
   * read — the resume's kick would join a loop that has already decided to exit, and the chapter
   * sits queued until some unrelated trigger. So `await drain()` always means "the queue settled,
   * including anything re-activated while it ran".
   */
  drain(): Promise<void> {
    if (this.drainPromise) {
      this.rekick = true;
      return this.drainPromise;
    }
    this.stopRequested = false;
    this.drainPromise = (async () => {
      do {
        this.rekick = false;
        await this.drainLoop();
      } while (this.rekick && !this.stopRequested);
    })().finally(() => {
      this.drainPromise = null;
      this.emit({ type: "idle" });
      // A kick can land in the microtask gap between the final rekick check and this cleanup —
      // start a fresh loop for it rather than dropping it.
      if (this.rekick && !this.stopRequested) {
        this.rekick = false;
        this.kick();
      }
    });
    return this.drainPromise;
  }

  private async drainLoop(): Promise<void> {
    for (;;) {
      if (this.stopRequested) break;
      if (!(await this.mayDownload())) break;
      let pending: DownloadedChapter[];
      try {
        pending = await this.downloads.pendingChapters();
      } catch {
        break; // store hiccup — stop rather than spin; the next explicit mutation retries
      }
      if (pending.length === 0) break;

      let progressed = false;
      for (const chapter of pending) {
        if (this.stopRequested || !(await this.mayDownload())) break;
        const key = entryKey(chapter.bridgeId, chapter.seriesId);
        if (this.isCancelled(key, chapter.chapterId)) continue;
        try {
          const did = await this.downloadChapter(chapter);
          progressed = progressed || did;
        } catch {
          // The chapter vanished mid-drain — deleted/cancelled between being listed as pending and
          // read here, so the manifest lookup throws "not downloaded". Skip it (the manifest is
          // the source of truth) rather than let it crash the whole queue.
        }
      }
      // Nothing advanced this pass (every remaining page errors) — stop rather than spin.
      if (!progressed) break;
    }
  }

  /** Download one chapter's outstanding pages. Returns true if at least one page landed. */
  private async downloadChapter(chapter: DownloadedChapter): Promise<boolean> {
    const { bridgeId, seriesId, chapterId } = chapter;
    const key = entryKey(bridgeId, seriesId);
    const manifest = await this.downloads.getManifestPages(key, chapterId);
    const outstanding = manifest.filter((p) => p.state !== "complete");

    if (outstanding.length === 0) {
      // Already complete (e.g. re-enqueued) — settle the rolled-up state and tell subscribers.
      const settled = await this.downloads.getChapter(key, chapterId);
      if (settled) this.emit({ type: "chapter", chapter: settled });
      return false;
    }

    // Announce 'downloading' the moment the engine picks the chapter up (before the first byte).
    // Without this the chapter reads 'queued' until its first page lands, so at the hand-off from one
    // chapter to the next a SERIES indicator would dip to 'queued' for that gap.
    this.emit({ type: "chapter", chapter: { ...chapter, state: "downloading" } });

    let landed = false;
    const queue: DownloadedPage[] = [...outstanding];
    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.stopRequested || this.isCancelled(key, chapterId)) return;
        const page = queue.shift();
        if (!page) return;
        const pending: PendingPage = { index: page.index, sourceUrl: page.sourceUrl };
        if (page.headers !== undefined) pending.headers = page.headers;
        // Try the page, retrying (with the host's retry hook between attempts) before giving up on
        // it. A page that still fails is marked failed so the chapter surfaces as `failed`
        // (retryable) rather than silently stalling — the other pages keep going.
        let stored = false;
        for (let attempt = 0; attempt < this.attemptsPerPage && !stored; attempt++) {
          if (this.isCancelled(key, chapterId)) return;
          try {
            const fetched = await this.fetchPage({ bridgeId, seriesId, chapterId }, pending);
            const relPath = relPathFor(bridgeId, seriesId, chapterId, page.index, extFor(fetched.contentType ?? page.sourceUrl));
            const { bytes } = await this.blobs.write(relPath, fetched.data);
            const updated = await this.downloads.recordPage(key, chapterId, page.index, relPath, bytes);
            stored = true;
            landed = true;
            this.emit({
              type: "page",
              bridgeId,
              seriesId,
              chapterId,
              index: page.index,
              completedPages: updated.completedPages,
              pageCount: updated.pageCount,
              bytes: updated.bytes,
              state: updated.state,
            });
            if (updated.state === "complete") this.emit({ type: "chapter", chapter: updated });
          } catch {
            if (attempt < this.attemptsPerPage - 1) this.onPageRetry?.(pending);
          }
        }
        if (!stored && !this.isCancelled(key, chapterId)) {
          try {
            const failed = await this.downloads.failPage(key, chapterId, page.index);
            this.emit({ type: "chapter", chapter: failed });
          } catch {
            // best-effort — the chapter may have been deleted mid-flight
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.pageConcurrency, queue.length) }, () => worker()));

    // Settle: tell subscribers the chapter's final rolled-up state (paused/failed/complete/queued).
    const after = await this.downloads.getChapter(key, chapterId);
    if (after && after.state !== "complete") this.emit({ type: "chapter", chapter: after });
    return landed;
  }

  // ── Cancellation markers ──────────────────────────────────────────────────────

  private isCancelled(key: string, chapterId: string): boolean {
    return this.cancelledSeries.has(key) || this.cancelledChapters.has(chapterCancelKey(key, chapterId));
  }

  private clearCancel(key: string, chapterId?: string): void {
    this.cancelledSeries.delete(key);
    if (chapterId) this.cancelledChapters.delete(chapterCancelKey(key, chapterId));
    else {
      const prefix = `${key}#`;
      for (const k of this.cancelledChapters) if (k.startsWith(prefix)) this.cancelledChapters.delete(k);
    }
  }
}

function chapterCancelKey(key: string, chapterId: string): string {
  return `${key}#${chapterId}`;
}
