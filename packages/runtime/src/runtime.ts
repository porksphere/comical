/**
 * ComicalRuntime — host-agnostic orchestration layer that wires bridges to the library.
 *
 * Any host (HTTP server, native app, CLI) constructs one of these with a BridgeProvider and an
 * optional Library, then calls runtime.* instead of manually coordinating the two. The key
 * responsibilities that are NOT in the library or in a bridge individually:
 *
 *   - addToLibrary: fetches SeriesInfo from the bridge (for externalIds auto-linking) so callers
 *     only need a bridgeId + seriesId — no separate getSeriesDetails call required.
 *   - markRead / setProgress / markReadUpTo: write library state first, then fire bridge read-sync
 *     if the bridge declares the "read-sync" capability (best-effort — bridge errors are swallowed).
 *   - importBridgeFavorites: paginate getFavorites, dedupe, bulk-add to library.
 *   - backgroundSync: iterate all library entries, pull fresh chapters, update knownChapterIds.
 */
import type { Chapter, PagedResults, TrackerSearchResult } from "@comical/contract";
import type { LoadedBridge, LoadedTracker } from "@comical/core";
import { entryKey, type AddSeriesResult, type Library, type SeriesSnapshot, type TrackerLink } from "@comical/library";

export interface BridgeProvider {
  get(id: string): Promise<LoadedBridge>;
}

export interface TrackerProvider {
  get(id: string): Promise<LoadedTracker>;
  list(): Promise<Array<{ info: { id: string } }>>;
}

export interface RuntimeOptions {
  bridges: BridgeProvider;
  /** Optional — methods that require a library throw if omitted. */
  library?: Library;
  /** Optional — methods that require trackers throw if omitted. */
  trackers?: TrackerProvider;
}

export class ComicalRuntime {
  private readonly bridges: BridgeProvider;
  private readonly lib: Library | undefined;
  private readonly trackers: TrackerProvider | undefined;

  constructor(opts: RuntimeOptions) {
    this.bridges = opts.bridges;
    this.lib = opts.library;
    this.trackers = opts.trackers;
  }

  // ── addToLibrary ──────────────────────────────────────────────────────────────

  /**
   * Add a series to the library. If `snap.title` is absent the runtime calls
   * `bridge.getSeriesDetails()` to populate title, thumbnailUrl, author, and externalIds —
   * so callers only need bridgeId + seriesId when they don't already have the series detail.
   *
   * `externalIds` from SeriesInfo are always included in the snapshot so the library's
   * auto-linking logic can fire.
   */
  async addToLibrary(
    bridgeId: string,
    seriesId: string,
    snap?: Partial<Omit<SeriesSnapshot, "bridgeId" | "seriesId">>,
  ): Promise<AddSeriesResult> {
    const lib = this.requireLibrary();

    let title = snap?.title;
    let thumbnailUrl = snap?.thumbnailUrl;
    let author = snap?.author;
    let externalIds = snap?.externalIds;

    if (!title) {
      const bridge = await this.bridges.get(bridgeId);
      const info = await bridge.getSeriesDetails(seriesId);
      title = info.title;
      if (thumbnailUrl === undefined && info.thumbnailUrl !== undefined) thumbnailUrl = info.thumbnailUrl;
      if (author === undefined && info.author !== undefined) author = info.author;
      if (externalIds === undefined && info.externalIds !== undefined) {
        const { anilist, mal, mu } = info.externalIds;
        externalIds = {
          ...(anilist !== undefined && { anilist }),
          ...(mal !== undefined && { mal }),
          ...(mu !== undefined && { mu }),
        };
      }
    }

    const full: SeriesSnapshot = { bridgeId, seriesId, title };
    if (thumbnailUrl !== undefined) full.thumbnailUrl = thumbnailUrl;
    if (author !== undefined) full.author = author;
    if (snap?.categoryIds !== undefined) full.categoryIds = snap.categoryIds;
    if (externalIds !== undefined) full.externalIds = externalIds;

    return lib.addSeries(full);
  }

  // ── Read-state methods (library write + optional bridge read-sync) ────────────

  async markRead(
    bridgeId: string,
    seriesId: string,
    chapterId: string,
    read: boolean,
    chapterName?: string,
  ): Promise<void> {
    const lib = this.requireLibrary();
    const key = entryKey(bridgeId, seriesId);
    await lib.markRead(key, chapterId, read, chapterName);
    try {
      const bridge = await this.bridges.get(bridgeId);
      if (bridge.info.capabilities.includes("read-sync")) {
        if (read) {
          await bridge.markChapterRead?.(seriesId, chapterId);
        } else {
          await bridge.markChapterUnread?.(seriesId, chapterId);
        }
      }
    } catch {
      // read-sync is best-effort — library write already committed
    }
    if (read) await this.syncEntryToTrackers(bridgeId, seriesId).catch(() => {});
  }

  async setProgress(
    bridgeId: string,
    seriesId: string,
    chapterId: string,
    lastPage: number,
    pageCount?: number,
    chapterName?: string,
  ): Promise<void> {
    const lib = this.requireLibrary();
    const key = entryKey(bridgeId, seriesId);
    await lib.setProgress(key, chapterId, lastPage, pageCount, chapterName);
    const reachedEnd = pageCount !== undefined && pageCount > 0 && lastPage >= pageCount - 1;
    if (!reachedEnd) return;
    try {
      const bridge = await this.bridges.get(bridgeId);
      if (bridge.info.capabilities.includes("read-sync")) {
        await bridge.markChapterRead?.(seriesId, chapterId);
      }
    } catch { /* best-effort */ }
    await this.syncEntryToTrackers(bridgeId, seriesId).catch(() => {});
  }

  async markReadUpTo(
    bridgeId: string,
    seriesId: string,
    chapters: Chapter[],
    chapterId: string,
  ): Promise<void> {
    const lib = this.requireLibrary();
    const key = entryKey(bridgeId, seriesId);
    await lib.markReadUpTo(key, chapters, chapterId);
    try {
      const bridge = await this.bridges.get(bridgeId);
      if (!bridge.info.capabilities.includes("read-sync") || !bridge.markChapterRead) return;
      const ordered = orderForReading(chapters);
      const cut = ordered.findIndex((c) => c.id === chapterId);
      if (cut === -1) return;
      for (const c of ordered.slice(0, cut + 1)) {
        try { await bridge.markChapterRead(seriesId, c.id); } catch { /* best-effort */ }
      }
    } catch { /* best-effort */ }
    await this.syncEntryToTrackers(bridgeId, seriesId).catch(() => {});
  }

  // ── Favorites import ──────────────────────────────────────────────────────────

  /** Paginate bridge favorites and bulk-add any that aren't already in the library. */
  async importBridgeFavorites(bridgeId: string): Promise<{ imported: number; skipped: number }> {
    const lib = this.requireLibrary();
    const bridge = await this.bridges.get(bridgeId);
    if (!bridge.getFavorites) throw new Error(`bridge "${bridgeId}" does not support favorites`);

    let page = 1;
    let imported = 0;
    let skipped = 0;
    while (true) {
      const result = await bridge.getFavorites(page);
      for (const entry of result.items) {
        const existing = await lib.getEntry(entryKey(bridgeId, entry.id));
        if (existing) { skipped++; continue; }
        const snap: SeriesSnapshot = { bridgeId, seriesId: entry.id, title: entry.title };
        if (entry.thumbnailUrl !== undefined) snap.thumbnailUrl = entry.thumbnailUrl;
        await lib.addSeries(snap);
        imported++;
      }
      if (!result.hasNextPage) break;
      page++;
    }
    return { imported, skipped };
  }

  // ── Background sync ───────────────────────────────────────────────────────────

  /**
   * Pull fresh chapters for every library entry and update knownChapterIds.
   * Skips direct-only bridges (no getChapters). Per-entry errors are swallowed so one
   * unreachable bridge doesn't abort the whole run.
   */
  async backgroundSync(): Promise<{ updated: number; newChapters: number }> {
    const lib = this.requireLibrary();
    const entries = await lib.getLibrary();
    let updated = 0;
    let newChapters = 0;
    for (const entry of entries) {
      try {
        const bridge = await this.bridges.get(entry.bridgeId);
        if (!bridge.getChapters) continue;
        const chapters = await bridge.getChapters(entry.seriesId);
        const key = entryKey(entry.bridgeId, entry.seriesId);
        const result = await lib.syncChapters(key, chapters);
        newChapters += result.added.length;
        updated++;
      } catch {
        // continue — one bad bridge or deleted series should not abort the sync
      }
    }
    return { updated, newChapters };
  }

  // ── Tracker sync ─────────────────────────────────────────────────────────────

  /** Link a library entry to a tracker (e.g. after the user selects from a search result). */
  async linkTracker(bridgeId: string, seriesId: string, trackerId: string, externalId: string | number): Promise<void> {
    await this.requireLibrary().linkTracker(entryKey(bridgeId, seriesId), trackerId, externalId);
  }

  async unlinkTracker(bridgeId: string, seriesId: string, trackerId: string): Promise<void> {
    await this.requireLibrary().unlinkTracker(entryKey(bridgeId, seriesId), trackerId);
  }

  async listTrackerLinks(bridgeId: string, seriesId: string): Promise<TrackerLink[]> {
    return this.requireLibrary().listTrackerLinks(entryKey(bridgeId, seriesId));
  }

  /**
   * Push the current read-state for one library entry to all linked trackers.
   * Best-effort: errors per-tracker are swallowed, nothing throws.
   * Called automatically after markRead / setProgress / markReadUpTo when trackers are configured.
   */
  async syncEntryToTrackers(bridgeId: string, seriesId: string): Promise<void> {
    if (!this.lib || !this.trackers) return;
    const key = entryKey(bridgeId, seriesId);
    const links = await this.lib.listTrackerLinks(key);
    if (links.length === 0) return;
    const progress = await this.lib.getProgress(key);
    const readCount = progress.filter((p) => p.read).length;
    for (const link of links) {
      try {
        const tracker = await this.trackers.get(link.trackerId);
        if (!tracker.info.capabilities.includes("status-sync") || !tracker.updateEntry) continue;
        await tracker.updateEntry(link.externalId, { chaptersRead: readCount });
        await this.lib.updateTrackerLink(key, link.trackerId, {
          chaptersRead: readCount,
          lastSyncAt: Date.now(),
        });
      } catch { /* per-tracker best-effort */ }
    }
  }

  /**
   * Pull the user's list from a tracker and update the status/chaptersRead on all existing
   * tracker links for this tracker. Entries from the tracker that are not yet linked are counted
   * as `unlinked` (the caller can prompt the user to link them manually).
   * Capability "library-sync" required.
   */
  async syncFromTracker(trackerId: string): Promise<{ updated: number; unlinked: number }> {
    const lib = this.requireLibrary();
    if (!this.trackers) throw new Error("ComicalRuntime: no trackers configured");
    const tracker = await this.trackers.get(trackerId);
    if (!tracker.info.capabilities.includes("library-sync") || !tracker.getLibrary) {
      throw new Error(`tracker "${trackerId}" does not support library-sync`);
    }

    // Build a lookup: externalId → entryKey for all existing links of this tracker.
    const allEntries = await lib.getLibrary();
    const linkIndex = new Map<string, string>(); // stringified externalId → entryKey
    for (const entry of allEntries) {
      const ek = entryKey(entry.bridgeId, entry.seriesId);
      const link = await lib.getTrackerLink(ek, trackerId);
      if (link) linkIndex.set(String(link.externalId), ek);
    }

    let page = 1;
    let updated = 0;
    let unlinked = 0;
    while (true) {
      const result = await tracker.getLibrary(page);
      for (const item of result.items) {
        const ek = linkIndex.get(String(item.externalId));
        if (ek) {
          await lib.updateTrackerLink(ek, trackerId, {
            status: item.status,
            ...(item.chaptersRead !== undefined && { chaptersRead: item.chaptersRead }),
            lastSyncAt: Date.now(),
          });
          updated++;
        } else {
          unlinked++;
        }
      }
      if (!result.hasNextPage) break;
      page++;
    }
    return { updated, unlinked };
  }

  /**
   * Search a tracker for a series title (for the "link tracker" UI flow).
   * Capability "search" required.
   */
  async searchTracker(trackerId: string, query: string, page = 1): Promise<PagedResults<TrackerSearchResult>> {
    if (!this.trackers) throw new Error("ComicalRuntime: no trackers configured");
    const tracker = await this.trackers.get(trackerId);
    if (!tracker.info.capabilities.includes("search") || !tracker.search) {
      throw new Error(`tracker "${trackerId}" does not support search`);
    }
    return tracker.search(query, page);
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  private requireLibrary(): Library {
    if (!this.lib) throw new Error("ComicalRuntime: library not configured");
    return this.lib;
  }
}


/** Ascending chapter order by number, preserving original order for unnumbered chapters. */
function orderForReading(chapters: Chapter[]): Chapter[] {
  return chapters
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const an = a.c.number;
      const bn = b.c.number;
      if (an !== undefined && bn !== undefined && an !== bn) return an - bn;
      if (an !== undefined && bn === undefined) return -1;
      if (an === undefined && bn !== undefined) return 1;
      return a.i - b.i;
    })
    .map((x) => x.c);
}
