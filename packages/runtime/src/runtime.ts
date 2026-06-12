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
 *   - backgroundSync: iterate all library entries, pull fresh chapters, update knownChapters.
 */
import type { Chapter, PagedResults, TrackerSearchResult } from "@comical/contract";
import type { LoadedBridge, LoadedTracker } from "@comical/core";
import { entryKey, type AddSeriesResult, type Library, type SeriesSnapshot, type TrackerLink } from "@comical/library";

/** Extends AddSeriesResult with tracker suggestions when no externalId match was found. */
export interface RuntimeAddResult extends AddSeriesResult {
  /** Candidate tracker matches found by title search for trackers that couldn't be auto-linked. */
  trackerSuggestions?: Array<{ trackerId: string; result: TrackerSearchResult }>;
}

/**
 * A series the user tracks on an external service but does not yet have in their library. Surfaced
 * by a tracker pull so the host can offer to add it — adding stays deliberate because a tracker
 * entry has no bridge to read from until the user picks one.
 */
export interface TrackerSuggestion {
  trackerId: string;
  externalId: string | number;
  title: string;
  thumbnailUrl?: string;
}

export interface BridgeProvider {
  get(id: string): Promise<LoadedBridge>;
}

export interface TrackerProvider {
  get(id: string): Promise<LoadedTracker>;
  list(): Promise<Array<{ info: { id: string; capabilities: string[] } }>>;
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
  ): Promise<RuntimeAddResult> {
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
        externalIds = info.externalIds;
      }
    }

    const full: SeriesSnapshot = { bridgeId, seriesId, title };
    if (thumbnailUrl !== undefined) full.thumbnailUrl = thumbnailUrl;
    if (author !== undefined) full.author = author;
    if (snap?.listIds !== undefined) full.listIds = snap.listIds;
    if (externalIds !== undefined) full.externalIds = externalIds;

    const result = await lib.addSeries(full);

    const key = entryKey(bridgeId, seriesId);
    const trackerSuggestions: RuntimeAddResult["trackerSuggestions"] = [];

    if (this.trackers) {
      const trackerList = await this.trackers.list().catch(() => []);
      for (const t of trackerList) {
        const extId = externalIds?.[t.info.id];
        if (extId !== undefined) {
          // Known external id — auto-link silently.
          await lib.linkTracker(key, t.info.id, extId).catch(() => {});
        } else if (title && t.info.capabilities.includes("search")) {
          // No id available — search by title and surface a suggestion for the user to confirm.
          try {
            const tracker = await this.trackers.get(t.info.id);
            const res = await tracker.search?.(title, 1);
            const first = res?.items[0];
            if (first) trackerSuggestions.push({ trackerId: t.info.id, result: first });
          } catch { /* best-effort */ }
        }
      }
    }

    return {
      ...result,
      ...(trackerSuggestions.length > 0 && { trackerSuggestions }),
    };
  }

  // ── Read-state methods (library write + optional bridge read-sync) ────────────

  async markRead(
    bridgeId: string,
    seriesId: string,
    chapterId: string,
    read: boolean,
    chapterName?: string,
    number?: number,
  ): Promise<void> {
    const lib = this.requireLibrary();
    const key = entryKey(bridgeId, seriesId);
    await lib.markRead(key, chapterId, read, chapterName, number);
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
    number?: number,
  ): Promise<void> {
    const lib = this.requireLibrary();
    const key = entryKey(bridgeId, seriesId);
    await lib.setProgress(key, chapterId, lastPage, pageCount, chapterName, number);
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
    // Bridge push is best-effort and self-contained so its early-exits never skip the tracker sync.
    await this.pushReadUpToBridge(bridgeId, seriesId, chapters, chapterId).catch(() => {});
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
   * One reconciliation pass over the whole library. Per entry: pull fresh chapters (new-chapter
   * detection), auto-link any newly-configured trackers, union-merge the bridge's read state, and
   * push local read state back out. Then, once per library-sync tracker, pull the tracker's list
   * and union-merge its progress in too. Read-state pulls go through `reconcileRead`, so they update
   * read flags WITHOUT moving the user's resume point or recency. Per-entry/per-tracker errors are
   * swallowed so one unreachable source doesn't abort the run.
   */
  async backgroundSync(): Promise<{ updated: number; newChapters: number; readSynced: number; suggestions: TrackerSuggestion[] }> {
    const lib = this.requireLibrary();
    const entries = await lib.getLibrary();
    let updated = 0;
    let newChapters = 0;
    let readSynced = 0;
    for (const entry of entries) {
      try {
        const bridge = await this.bridges.get(entry.bridgeId);
        const key = entryKey(entry.bridgeId, entry.seriesId);

        // Pull fresh chapter list and detect new chapters.
        let chapters: Chapter[] | undefined;
        if (bridge.getChapters) {
          chapters = await bridge.getChapters(entry.seriesId);
          const result = await lib.syncChapters(key, chapters);
          newChapters += result.added.length;
          updated++;
        }

        // Wire up any tracker configured after this entry was added (externalId already known).
        await this.relinkEntry(entry.bridgeId, entry.seriesId, entry.externalIds);

        // Union-merge the bridge's read state — read flags only, resume untouched.
        if (bridge.getReadChapters) {
          const remoteRead = await bridge.getReadChapters(entry.seriesId);
          const numById = new Map((chapters ?? []).map((c) => [c.id, c.number]));
          const res = await lib.reconcileRead(
            key,
            remoteRead.map((id) => {
              const n = numById.get(id);
              return n !== undefined ? { chapterId: id, number: n } : { chapterId: id };
            }),
          );
          readSynced += res.marked;
        }

        await this.syncEntryToTrackers(entry.bridgeId, entry.seriesId).catch(() => {});
      } catch {
        // continue — one bad bridge or deleted series should not abort the sync
      }
    }

    // Tracker pull is a whole-list operation, so run it once per tracker (not per entry).
    const suggestions: TrackerSuggestion[] = [];
    if (this.trackers) {
      const trackerList = await this.trackers.list().catch(() => []);
      for (const t of trackerList) {
        if (!t.info.capabilities.includes("library-sync")) continue;
        try {
          const res = await this.syncFromTracker(t.info.id);
          readSynced += res.readSynced;
          suggestions.push(...res.suggestions);
        } catch { /* best-effort — one bad tracker shouldn't abort */ }
      }
    }

    return { updated, newChapters, readSynced, suggestions };
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
    const prefs = await this.lib.getBridgePrefs(bridgeId);
    if (prefs.trackersDisabled) return;
    const key = entryKey(bridgeId, seriesId);
    const links = await this.lib.listTrackerLinks(key);
    if (links.length === 0) return;
    // `chaptersRead` is the HIGHEST read chapter number (the contract's definition), not a count —
    // counting breaks on decimal or out-of-order numbering. Skip pushing 0 so we never clobber a
    // tracker's progress with "nothing read".
    const chaptersRead = await this.lib.maxReadChapterNumber(key);
    if (chaptersRead <= 0) return;
    for (const link of links) {
      try {
        const tracker = await this.trackers.get(link.trackerId);
        if (!tracker.info.capabilities.includes("status-sync") || !tracker.updateEntry) continue;
        await tracker.updateEntry(link.externalId, { chaptersRead });
        await this.lib.updateTrackerLink(key, link.trackerId, {
          chaptersRead,
          lastSyncAt: Date.now(),
        });
      } catch { /* per-tracker best-effort */ }
    }
  }

  /**
   * Pull the user's list from a tracker. For each linked entry: update the link's status/chaptersRead
   * AND reconcile the tracker's progress into the library (mark chapters up to `chaptersRead` read,
   * union, resume untouched). Tracked series with no local entry are returned as `suggestions` —
   * adding them stays deliberate because a tracker entry has no bridge to read from.
   * Capability "library-sync" required.
   */
  async syncFromTracker(trackerId: string): Promise<{ updated: number; readSynced: number; suggestions: TrackerSuggestion[] }> {
    const lib = this.requireLibrary();
    if (!this.trackers) throw new Error("ComicalRuntime: no trackers configured");
    const tracker = await this.trackers.get(trackerId);
    if (!tracker.info.capabilities.includes("library-sync") || !tracker.getLibrary) {
      throw new Error(`tracker "${trackerId}" does not support library-sync`);
    }

    // Build a lookup: externalId → linked entry for all existing links of this tracker.
    const allEntries = await lib.getLibrary();
    const linkIndex = new Map<string, { key: string; bridgeId: string; seriesId: string }>();
    for (const entry of allEntries) {
      const ek = entryKey(entry.bridgeId, entry.seriesId);
      const link = await lib.getTrackerLink(ek, trackerId);
      if (link) linkIndex.set(String(link.externalId), { key: ek, bridgeId: entry.bridgeId, seriesId: entry.seriesId });
    }

    let page = 1;
    let updated = 0;
    let readSynced = 0;
    const suggestions: TrackerSuggestion[] = [];
    while (true) {
      const result = await tracker.getLibrary(page);
      for (const item of result.items) {
        const match = linkIndex.get(String(item.externalId));
        if (match) {
          await lib.updateTrackerLink(match.key, trackerId, {
            status: item.status,
            ...(item.chaptersRead !== undefined && { chaptersRead: item.chaptersRead }),
            lastSyncAt: Date.now(),
          });
          updated++;
          if (item.chaptersRead !== undefined && item.chaptersRead > 0) {
            readSynced += await this.reconcileTrackerRead(match.bridgeId, match.seriesId, match.key, item.chaptersRead);
          }
        } else {
          suggestions.push({
            trackerId,
            externalId: item.externalId,
            title: item.title,
            ...(item.thumbnailUrl !== undefined && { thumbnailUrl: item.thumbnailUrl }),
          });
        }
      }
      if (!result.hasNextPage) break;
      page++;
    }
    return { updated, readSynced, suggestions };
  }

  /**
   * Link an existing entry to any configured tracker whose externalId is already on the entry but
   * not yet linked — the re-link counterpart to the auto-link `addToLibrary` does, for entries that
   * predate a tracker being configured. Best-effort; never throws.
   */
  /** Push a "read up to here" range to the bridge's own backend, if it supports read-sync. */
  private async pushReadUpToBridge(bridgeId: string, seriesId: string, chapters: Chapter[], chapterId: string): Promise<void> {
    const bridge = await this.bridges.get(bridgeId);
    if (!bridge.info.capabilities.includes("read-sync") || !bridge.markChapterRead) return;
    const ordered = orderForReading(chapters);
    const cut = ordered.findIndex((c) => c.id === chapterId);
    if (cut === -1) return;
    for (const c of ordered.slice(0, cut + 1)) {
      try { await bridge.markChapterRead(seriesId, c.id); } catch { /* best-effort */ }
    }
  }

  private async relinkEntry(bridgeId: string, seriesId: string, externalIds?: Record<string, string | number>): Promise<void> {
    if (!this.lib || !this.trackers || !externalIds) return;
    const key = entryKey(bridgeId, seriesId);
    const trackerList = await this.trackers.list().catch(() => []);
    for (const t of trackerList) {
      const extId = externalIds[t.info.id];
      if (extId === undefined) continue;
      if (await this.lib.getTrackerLink(key, t.info.id)) continue;
      await this.lib.linkTracker(key, t.info.id, extId).catch(() => {});
    }
  }

  /**
   * Map a tracker's `chaptersRead` high-water number to chapter ids via the bridge's chapter list
   * and reconcile them into the library (read flags only). No-op for direct-only bridges that can't
   * list chapters, or when the bridge/series is unreachable. Returns how many chapters were newly
   * marked read.
   */
  private async reconcileTrackerRead(bridgeId: string, seriesId: string, key: string, chaptersRead: number): Promise<number> {
    const lib = this.requireLibrary();
    let chapters: Chapter[];
    try {
      const bridge = await this.bridges.get(bridgeId);
      if (!bridge.getChapters) return 0;
      chapters = await bridge.getChapters(seriesId);
    } catch {
      return 0;
    }
    const toMark = chapters
      .filter((c): c is Chapter & { number: number } => c.number !== undefined && c.number <= chaptersRead)
      .map((c) => ({ chapterId: c.id, number: c.number }));
    const res = await lib.reconcileRead(key, toMark);
    return res.marked;
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
