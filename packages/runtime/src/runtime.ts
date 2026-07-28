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
import type { Chapter, LogCapability, PagedResults, SeriesInfo, TrackerEntryUpdate, TrackerLibraryEntry, TrackerSearchResult } from "@comical/contract";
import { trackerEntryUpdateSchema } from "@comical/contract";
// Import from Node-free subpaths (not the `@comical/core` barrel, which registers the
// node:vm-backed default evaluator) so `@comical/runtime`'s types stay consumable by non-Node
// hosts — e.g. comical-app's embedded runtime typing `RouterOptions.runtime`. See @comical/core.
import type { LoadedBridge } from "@comical/core/loader";
import type { LoadedTracker } from "@comical/core/tracker-loader";
import {
  entryKey,
  type AddSeriesResult,
  type Library,
  type LibraryEntryView,
  type SeriesSnapshot,
  type TrackerLink,
} from "@comical/library";

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

export interface BackgroundSyncOptions {
  /** Sync every entry regardless of the staleness window (the manual "Check for updates" path). */
  force?: boolean;
  /** Skip entries whose chapters were synced more recently than this. Default 6 hours. */
  staleMs?: number;
  /** Max entries synced in parallel. Default 4 — conservative so same-bridge rate limits don't pile up. */
  concurrency?: number;
  /** Wall-clock budget: stop starting new entries once exceeded (short OS background windows). */
  budgetMs?: number;
  /**
   * How old a *non-terminal* cached series detail may be before it's re-fetched. Default 7 days.
   * Separate from `staleMs` because this governs publication status (which changes on the order of
   * months), not the chapter list.
   */
  detailStaleMs?: number;
  /** Run the whole-list tracker pull at the end. Default true; quick background runs pass false. */
  trackers?: boolean;
}

export interface BackgroundSyncResult {
  updated: number;
  newChapters: number;
  readSynced: number;
  suggestions: TrackerSuggestion[];
  /** Library size at scan time. */
  scanned: number;
  /** Entries skipped because they were synced within the staleness window. */
  skipped: number;
  /** True when the time budget ran out before every candidate was synced. */
  partial: boolean;
}

/**
 * Bounded retry for a tracker push. The implicit push runs on the read path (`markRead` awaits it),
 * so the worst case a failing tracker can add to a page turn is the sum of these delays — enough to
 * ride out a blip, not enough to make the read feel stuck.
 */
const PUSH_ATTEMPTS = 3;
const PUSH_RETRY_DELAY_MS = [300, 900];

const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Is this failure worth another attempt? A rejected credential or a refused request won't fix itself
 * in a second, and each retry burns a rate-limited slot on an already-unhappy tracker — so those are
 * reported immediately instead. Matched on the message because the contract's tracker interface has
 * no typed error channel: a tracker bundle can only throw.
 */
function isPermanentPushFailure(err: unknown): boolean {
  return /\b401\b|\b403\b|expired|unauthor|forbidden|invalid.*token|token.*invalid/i.test(errMessage(err));
}

/** Today as `YYYY-MM-DD` in local time — trackers record reading dates, not instants. */
function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * What (if anything) to tell a tracker about one link, and what to record locally once it lands.
 * Returns undefined when there is nothing new to say.
 *
 * Pure and synchronous so the transition rules — the part that's easy to get subtly wrong — are
 * readable and testable in one place, without a store or a tracker in the way.
 *
 * ## Progress
 * Clamped to the tracker's own chapter count: it will not accept more than it thinks exists, and a
 * local number above the total would otherwise re-push forever (the watermark could never catch up).
 * The clamped value is what's compared against the watermark AND what's recorded as the new one.
 *
 * ## Completion — two triggers, deliberately
 * `reachedTotal` is the rule Mihon and Aidoku both use: progress has reached the tracker's own
 * chapter count. It's the only one available when a bridge doesn't report publication status.
 * `finishedLocally` is every known chapter read on a series that's over. It's the only one that
 * fires when a source's numbering ends BELOW the tracker's count — BLAME! numbers its logs 1–65
 * plus extras 3.5/7.5 against AniList's count of 66, so `reachedTotal` can never be true for it.
 * Neither subsumes the other.
 *
 * Completion is one-shot, gated on `completedPushedAt` rather than on `status`: a pull overwrites
 * `status` with the tracker's own truth, so a user who deliberately drops a finished series would
 * otherwise have "completed" re-pushed over it on every background sync.
 */
export function decideTrackerPush(
  link: TrackerLink,
  maxRead: number,
  finishedLocally: boolean,
  now = new Date(),
): { update: TrackerEntryUpdate; link: Partial<TrackerLink> } | undefined {
  const total = link.totalChapters;
  const chaptersRead = total !== undefined ? Math.min(maxRead, total) : maxRead;
  const advanced = chaptersRead > (link.chaptersRead ?? 0);

  const reachedTotal = total !== undefined && Math.floor(maxRead) >= total;
  const sendCompleted = (reachedTotal || finishedLocally) && link.completedPushedAt === undefined;
  // Reading a series the tracker already holds as finished is a re-read. A link already in
  // "rereading" matches nothing below, which is how an existing re-read survives untouched.
  const sendRereading = !sendCompleted && advanced && link.status === "completed";
  const sendReading =
    !sendCompleted && !sendRereading && advanced && (link.status === undefined || link.status === "planning");

  if (!advanced && !sendCompleted) return undefined;

  return {
    update: {
      ...(advanced && { chaptersRead }),
      ...(sendCompleted && { status: "completed" as const, finishedAt: today(now) }),
      ...(sendRereading && { status: "rereading" as const }),
      ...(sendReading && { status: "reading" as const, startedAt: today(now) }),
    },
    link: {
      // NOT unconditional: on a status-only push `chaptersRead` is at or below the watermark, and
      // writing it would drag the watermark below what a pull had raised it to.
      ...(advanced && { chaptersRead }),
      ...(sendCompleted && { status: "completed" as const, completedPushedAt: now.getTime() }),
      ...(sendRereading && { status: "rereading" as const }),
      ...(sendReading && { status: "reading" as const }),
    },
  };
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
  /**
   * Optional host log. Best-effort background work (tracker pushes, bridge read-sync) deliberately
   * swallows its errors so a failing side-effect never fails the user's action — but swallowing them
   * SILENTLY made a broken tracker push indistinguishable from a working one (an expired OAuth token
   * failed invisibly, forever). Anything caught on those paths is reported here instead, so a host
   * can surface it (comical-app routes this into Settings → Diagnostics).
   */
  log?: LogCapability;
}

export class ComicalRuntime {
  private readonly bridges: BridgeProvider;
  private readonly lib: Library | undefined;
  private readonly trackers: TrackerProvider | undefined;
  private readonly log: LogCapability | undefined;

  constructor(opts: RuntimeOptions) {
    this.bridges = opts.bridges;
    this.lib = opts.library;
    this.trackers = opts.trackers;
    this.log = opts.log;
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

    let fetchedInfo: SeriesInfo | undefined;
    if (!title) {
      const bridge = await this.bridges.get(bridgeId);
      fetchedInfo = await bridge.getSeriesDetails(seriesId);
      title = fetchedInfo.title;
      if (thumbnailUrl === undefined && fetchedInfo.thumbnailUrl !== undefined) thumbnailUrl = fetchedInfo.thumbnailUrl;
      if (author === undefined && fetchedInfo.author !== undefined) author = fetchedInfo.author;
      if (externalIds === undefined && fetchedInfo.externalIds !== undefined) {
        externalIds = fetchedInfo.externalIds;
      }
    }

    const full: SeriesSnapshot = { bridgeId, seriesId, title };
    if (thumbnailUrl !== undefined) full.thumbnailUrl = thumbnailUrl;
    if (author !== undefined) full.author = author;
    if (snap?.listIds !== undefined) full.listIds = snap.listIds;
    if (externalIds !== undefined) full.externalIds = externalIds;

    const result = await lib.addSeries(full);

    const key = entryKey(bridgeId, seriesId);

    // Offline metadata capture (best-effort — the add itself already succeeded): the full series
    // detail plus a chapter-list seed, so the entry renders offline from the moment it's added
    // rather than after the first background sync or series-page visit.
    try {
      const bridge = await this.bridges.get(bridgeId);
      await lib.cacheSeriesDetail(key, fetchedInfo ?? (await bridge.getSeriesDetails(seriesId)));
      if (bridge.getChapters) await lib.syncChapters(key, await bridge.getChapters(seriesId));
    } catch {
      // No metadata cached this time — browsing/background sync write it through later.
    }
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

  /**
   * Mark a series' whole activity feed read (the feed row's "Mark read" swipe), then sync trackers.
   *
   * The library method alone is a read-state write like any other, and hosts were calling it
   * directly — which made clearing a series' feed the one way to mark chapters read that never
   * reached a tracker. No bridge read-sync push here, deliberately: `Library.markActivityRead`
   * doesn't touch the resume pointer or history either, because dismissing a feed row isn't reading.
   */
  async markActivityRead(bridgeId: string, seriesId: string): Promise<{ marked: number }> {
    const result = await this.requireLibrary().markActivityRead(bridgeId, seriesId);
    // Unconditional, like `markRead`: even a zero-marked call is a chance to heal a link that's
    // behind for some other reason (a failed earlier push, a completion never sent).
    await this.syncEntryToTrackers(bridgeId, seriesId).catch(() => {});
    return result;
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
   * One reconciliation pass over the library. Per entry: pull fresh chapters (new-chapter
   * detection), auto-link any newly-configured trackers, union-merge the bridge's read state, and
   * push local read state back out. Then, once per library-sync tracker, pull the tracker's list
   * and union-merge its progress in too. Read-state pulls go through `reconcileRead`, so they update
   * read flags WITHOUT moving the user's resume point or recency. Per-entry/per-tracker errors are
   * swallowed so one unreachable source doesn't abort the run.
   *
   * Large-library behavior: entries synced within `staleMs` are skipped (pass `force` to override —
   * the user-facing "Check for updates" path), entries run through a bounded worker pool
   * (`concurrency` wide — parallelism is across entries; per-bridge rate limiting still serializes
   * same-bridge fetches inside the bridge layer), and `budgetMs` caps the wall clock by not
   * *starting* further entries past the deadline. Candidates are processed stalest-first, and every
   * synced entry refreshes its `chaptersSyncedAt`, so a budget-truncated run resumes where it left
   * off on the next call — the staleness ordering is the incremental cursor, no extra state.
   */
  async backgroundSync(opts: BackgroundSyncOptions = {}): Promise<BackgroundSyncResult> {
    const lib = this.requireLibrary();
    const {
      force = false,
      staleMs = 6 * 60 * 60 * 1000,
      concurrency = 4,
      budgetMs,
      detailStaleMs,
      trackers = true,
    } = opts;
    const startedAt = Date.now();

    const entries = await lib.getLibrary();
    const candidates = force
      ? [...entries]
      : entries.filter((e) => e.chaptersSyncedAt === undefined || startedAt - e.chaptersSyncedAt > staleMs);
    // Stalest first (never-synced entries lead) so a truncated run picks up the remainder next time.
    candidates.sort((a, b) => (a.chaptersSyncedAt ?? -1) - (b.chaptersSyncedAt ?? -1));

    const counters = { updated: 0, newChapters: 0, readSynced: 0 };
    let partial = false;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < candidates.length) {
        // Budget gates *starting* entries, but never the very first one — a run must always make
        // forward progress, or a budget shorter than startup overhead would starve forever.
        if (next > 0 && budgetMs !== undefined && Date.now() - startedAt >= budgetMs) {
          partial = true;
          return;
        }
        const entry = candidates[next++]!;
        await this.syncOneEntry(entry, counters, detailStaleMs);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

    // Tracker pull is a whole-list operation, so run it once per tracker (not per entry).
    const suggestions: TrackerSuggestion[] = [];
    if (trackers && this.trackers) {
      const trackerList = await this.trackers.list().catch(() => []);
      for (const t of trackerList) {
        if (!t.info.capabilities.includes("library-sync")) continue;
        try {
          const res = await this.syncFromTracker(t.info.id);
          counters.readSynced += res.readSynced;
          suggestions.push(...res.suggestions);
        } catch { /* best-effort — one bad tracker shouldn't abort */ }
      }
    }

    // Keep the activity feed bounded — best-effort, never fails the sync.
    await lib.pruneActivity().catch(() => {});

    return {
      ...counters,
      suggestions,
      scanned: entries.length,
      skipped: entries.length - candidates.length,
      partial,
    };
  }

  /** One entry's reconciliation pass — see backgroundSync. Errors are swallowed per entry. */
  private async syncOneEntry(
    entry: LibraryEntryView,
    counters: { updated: number; newChapters: number; readSynced: number },
    detailStaleMs?: number,
  ): Promise<void> {
    const lib = this.requireLibrary();
    try {
      const bridge = await this.bridges.get(entry.bridgeId);
      const key = entryKey(entry.bridgeId, entry.seriesId);

      // Pull fresh chapter list and detect new chapters.
      let chapters: Chapter[] | undefined;
      if (bridge.getChapters) {
        chapters = await bridge.getChapters(entry.seriesId);
        const result = await lib.syncChapters(key, chapters);
        counters.newChapters += result.added.length;
        counters.updated++;
      }

      // Wire up any tracker configured after this entry was added (externalId already known).
      await this.relinkEntry(entry.bridgeId, entry.seriesId, entry.externalIds);

      await this.refreshStaleDetail(bridge, entry.seriesId, key, detailStaleMs).catch(() => {});

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
        counters.readSynced += res.marked;
      }

      await this.syncEntryToTrackers(entry.bridgeId, entry.seriesId).catch(() => {});
    } catch {
      // continue — one bad bridge or deleted series should not abort the sync
    }
  }

  /**
   * Re-cache a series' detail when its publication status could have gone stale.
   *
   * The cached detail is otherwise written only at add-time and when the user opens the series page,
   * so a series added while *ongoing* that later finishes would never be detected as complete until
   * someone visited it — leaving the tracker on "Reading" indefinitely.
   *
   * Refreshed only when the cache is **absent, or non-terminal and older than the window**:
   * "completed"/"cancelled" is a terminal answer that can't go stale, and gating on it keeps this off
   * the common path instead of doubling every background sync's request count.
   */
  private async refreshStaleDetail(
    bridge: LoadedBridge,
    seriesId: string,
    key: string,
    staleMs: number = 7 * 24 * 60 * 60 * 1000,
  ): Promise<void> {
    if (!bridge.getSeriesDetails) return;
    const lib = this.requireLibrary();
    const cached = await lib.getCachedDetail(key);
    if (cached) {
      const terminal = cached.info.status === "completed" || cached.info.status === "cancelled";
      if (terminal || Date.now() - cached.cachedAt < staleMs) return;
    }
    await lib.cacheSeriesDetail(key, await bridge.getSeriesDetails(seriesId));
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
   *
   * Pushes STATUS as well as progress. See {@link decideTrackerPush} for which transitions fire.
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
    const maxRead = await this.lib.maxReadChapterNumber(key);
    if (maxRead <= 0) return;
    // The local completion signal costs two document reads, so only ask when some link could still
    // act on it. Once every link has been told, this is never computed again.
    const finishedLocally = links.some((l) => l.completedPushedAt === undefined)
      ? await this.isFinishedLocally(key)
      : false;

    for (const link of links) {
      const decision = decideTrackerPush(link, maxRead, finishedLocally);
      try {
        const tracker = await this.trackers.get(link.trackerId);
        if (!tracker.info.capabilities.includes("status-sync") || !tracker.updateEntry) continue;
        if (!decision) continue;
        await this.pushToTracker(tracker, link.externalId, decision.update);
        await this.lib.updateTrackerLink(key, link.trackerId, { ...decision.link, lastSyncAt: Date.now() });
      } catch (err) {
        // Per-tracker best-effort: a failing push must never fail the read that triggered it. But it
        // IS reported now — this catch used to be silent, which is how an expired AniList token could
        // drop every push indefinitely with no symptom anywhere in the app.
        this.log?.warn(
          `tracker push failed: ${link.trackerId} ${key} (${JSON.stringify(decision?.update ?? {})}):`,
          errMessage(err),
        );
      }
    }
  }

  /**
   * Has the user finished this series, judged locally? Every known chapter read AND the series over.
   * One half of the completion decision; the other is the tracker's own chapter count, which catches
   * the entries this can't (see {@link decideTrackerPush}).
   */
  private async isFinishedLocally(key: string): Promise<boolean> {
    const { fullyRead, seriesFinished } = await this.requireLibrary().getEntryCompletion(key);
    return fullyRead && seriesFinished;
  }

  /**
   * `updateEntry` with a short bounded retry, so one dropped request doesn't lose the push until the
   * next read. Gives up immediately on a failure that retrying can't fix (see
   * `isPermanentPushFailure`) and rethrows the last error with the attempt count folded in — the
   * difference between "1 attempt" and "3 attempts" is the difference between a dead token and a
   * flaky network, which is the first thing you want to know from the log.
   */
  private async pushToTracker(
    tracker: { updateEntry?: (externalId: string | number, update: TrackerEntryUpdate) => Promise<void> },
    externalId: string | number,
    update: TrackerEntryUpdate,
  ): Promise<void> {
    // Validate at the boundary, like every other contract-shaped value handed to a bundle: a
    // malformed date would be rejected by the service with an opaque error three layers away.
    const parsed = trackerEntryUpdateSchema.parse(update);
    for (let attempt = 1; ; attempt++) {
      try {
        await tracker.updateEntry!(externalId, parsed);
        return;
      } catch (err) {
        if (attempt >= PUSH_ATTEMPTS || isPermanentPushFailure(err)) {
          throw attempt === 1
            ? err
            : new Error(`${errMessage(err)} (after ${attempt} attempts)`, { cause: err });
        }
        await delay(PUSH_RETRY_DELAY_MS[attempt - 1] ?? PUSH_RETRY_DELAY_MS.at(-1)!);
      }
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
    const linkIndex = new Map<string, { key: string; bridgeId: string; seriesId: string; watermark: number }>();
    for (const entry of allEntries) {
      const ek = entryKey(entry.bridgeId, entry.seriesId);
      const link = await lib.getTrackerLink(ek, trackerId);
      if (link) {
        linkIndex.set(String(link.externalId), {
          key: ek,
          bridgeId: entry.bridgeId,
          seriesId: entry.seriesId,
          watermark: link.chaptersRead ?? 0,
        });
      }
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
          updated++;
          readSynced += await this.applyTrackerItem(match, item, trackerId);
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
   * TWO-WAY sync for a single library entry's tracker link — the manual, per-row "Sync" action.
   *
   * This used to be `syncEntryFromTracker`, a PULL: it applied the tracker's state locally and never
   * called `updateEntry`, so pressing "Sync" could not update the user's AniList account — while
   * still stamping `lastSyncAt`, which made the row read "synced just now" and looked like it had.
   * Pushing only ever happened implicitly via `syncEntryToTrackers` after a read.
   *
   * Now whichever side has read FURTHER wins, and the other is brought up to it:
   *   - local ahead  → push `chaptersRead` to the tracker (`updateEntry`)
   *   - tracker ahead → apply it locally (same path as the bulk pull, marking chapters read)
   *   - equal        → nothing to move; the link is still re-stamped
   *
   * Highest-wins is chosen over last-writer-wins because read progress is monotonic: a lower number
   * on one side is far more likely to be a stale/never-synced copy than a deliberate rewind, and
   * clobbering a higher count would silently lose reading history the user can't recover.
   *
   * "Local ahead" is measured against the link's WATERMARK, not against what the tracker echoes back.
   * A tracker may store our number lossily — AniList and MAL both take an integer, so chapter 12.5
   * lands as 12 — and against the echo local would read as ahead forever, re-pushing on every sync
   * and never once reporting "already in sync". The watermark records what we know reached the
   * tracker, so the comparison settles regardless of what the service did to the value. This is the
   * generic form of the problem: it costs the trackers nothing to declare and holds for any future
   * one that rounds, clamps, or otherwise reshapes what it's given.
   *
   * Capability-adaptive: a tracker with only `library-sync` still pulls, one with only `status-sync`
   * still pushes. Finding the remote entry pages through `tracker.getLibrary` (the contract has no
   * single-entry lookup); that cost is acceptable for an infrequent, user-initiated action. When the
   * tracker's list has no entry for this link, remote counts as 0 — so a local count pushes and
   * CREATES it there (`SaveMediaListEntry` upserts), instead of the old `updated: false` no-op.
   */
  async syncEntryWithTracker(
    bridgeId: string,
    seriesId: string,
    trackerId: string,
  ): Promise<{ updated: boolean; readSynced: number; pushed: boolean; chaptersRead: number }> {
    const lib = this.requireLibrary();
    if (!this.trackers) throw new Error("ComicalRuntime: no trackers configured");
    const key = entryKey(bridgeId, seriesId);
    const link = await lib.getTrackerLink(key, trackerId);
    if (!link) throw new Error(`no ${trackerId} link for this entry`);
    const tracker = await this.trackers.get(trackerId);

    const canPull = tracker.info.capabilities.includes("library-sync") && !!tracker.getLibrary;
    const canPush = tracker.info.capabilities.includes("status-sync") && !!tracker.updateEntry;
    if (!canPull && !canPush) {
      throw new Error(`tracker "${trackerId}" supports neither library-sync nor status-sync`);
    }

    const localRead = await lib.maxReadChapterNumber(key);

    // Locate this link's entry in the tracker's list (pull-capable trackers only).
    let remote: TrackerLibraryEntry | undefined;
    if (canPull) {
      let page = 1;
      while (true) {
        const result = await tracker.getLibrary!(page);
        const item = result.items.find((i) => String(i.externalId) === String(link.externalId));
        if (item) { remote = item; break; }
        if (!result.hasNextPage) break;
        page++;
      }
    }
    const remoteRead = remote?.chaptersRead ?? 0;
    const watermark = link.chaptersRead ?? 0;

    // Decide against the FRESHEST view of the link: the pull we just did knows the tracker's real
    // status and chapter count, and folding `remoteRead` into the watermark is what makes a push
    // require local to be ahead of both the echo and what the tracker is known to hold.
    const effective: TrackerLink = {
      ...link,
      ...(remote?.status !== undefined && { status: remote.status }),
      ...(remote?.totalChapters !== undefined && { totalChapters: remote.totalChapters }),
      chaptersRead: Math.max(watermark, remoteRead),
    };
    const finishedLocally = link.completedPushedAt === undefined ? await this.isFinishedLocally(key) : false;
    const decision = canPush ? decideTrackerPush(effective, localRead, finishedLocally) : undefined;

    if (decision) {
      // Same bounded retry as the implicit push — here the error isn't swallowed, it's thrown at the
      // user who pressed the button, so it's worth being sure it's real before reporting it.
      await this.pushToTracker(tracker, link.externalId, decision.update);
      const pushed = decision.update.chaptersRead;
      if (pushed !== undefined) {
        await lib.updateTrackerLink(key, trackerId, {
          // Mirror the total even though this branch skips `applyTrackerItem` — it's the only thing
          // the implicit read push (which never pulls) has to clamp against, so dropping it here
          // would let the next local read push straight past the service's own chapter count.
          ...(remote?.totalChapters !== undefined && { totalChapters: remote.totalChapters }),
          ...decision.link,
          lastSyncAt: Date.now(),
        });
        return { updated: true, readSynced: 0, pushed: true, chaptersRead: pushed };
      }
      // Status-only (the finished-series repair, where progress has nothing new to say). Fall through
      // to apply the tracker's state, but let what we just pushed win over the now-stale pulled status.
    }

    // Apply the tracker's state locally (shared with the bulk pull).
    if (remote) {
      const readSynced = await this.applyTrackerItem(
        { key, bridgeId, seriesId, watermark }, remote, trackerId, decision?.link,
      );
      // Which number to report as "where you both are". When local reads ahead of the echo but not of
      // the watermark, the tracker DOES hold this progress and is merely reporting it back coarsely
      // (12.5 → 12), so the local number is the honest answer. Otherwise the tracker's is the one that
      // moved — including for a pull-only tracker, where local really is ahead and staying that way.
      const settledLossy = localRead > remoteRead && localRead <= watermark;
      return { updated: true, readSynced, pushed: !!decision, chaptersRead: settledLossy ? localRead : remoteRead };
    }
    if (decision) {
      await lib.updateTrackerLink(key, trackerId, { ...decision.link, lastSyncAt: Date.now() });
      return { updated: true, readSynced: 0, pushed: true, chaptersRead: localRead };
    }

    // Nothing on the tracker's list to apply — a pull-only tracker that doesn't list this link, or a
    // push-only tracker, which has no list at all. `updated` separates "settled at a count the
    // tracker already holds" from "neither side has anything yet": the difference between reporting
    // "already in sync" and "nothing to sync".
    return {
      updated: localRead > 0 && localRead <= watermark,
      readSynced: 0,
      pushed: false,
      chaptersRead: localRead,
    };
  }

  /**
   * Apply one tracker library item to a matched, already-linked entry: update the link's
   * status/chaptersRead, then reconcile the tracker's read progress into local chapter-read flags.
   * Shared by the bulk (`syncFromTracker`) and scoped (`syncEntryWithTracker`) pull paths.
   * Returns how many chapters were newly marked read.
   *
   * `match.watermark` is the link's current `chaptersRead`, passed in by both callers because both
   * already hold the link (re-reading it here would cost a store round-trip per entry in the bulk
   * pull). The write keeps the higher of the two: a pull must never drag the watermark down to a
   * lossy echo of what we pushed, or the next sync would see local as ahead again and re-push.
   *
   * `overrides` wins over `item`. It exists for the one caller that PUSHES before applying: the
   * pulled item predates that push, so its `status` is stale and would otherwise clobber the status
   * we just successfully sent.
   */
  private async applyTrackerItem(
    match: { key: string; bridgeId: string; seriesId: string; watermark: number },
    item: TrackerLibraryEntry,
    trackerId: string,
    overrides?: Partial<TrackerLink>,
  ): Promise<number> {
    const lib = this.requireLibrary();
    await lib.updateTrackerLink(match.key, trackerId, {
      status: item.status,
      ...(item.chaptersRead !== undefined && {
        chaptersRead: Math.max(item.chaptersRead, match.watermark),
      }),
      // The only place the tracker's own chapter count enters local state. Until a pull has run,
      // pushes are unclamped and can only complete via the local signal.
      ...(item.totalChapters !== undefined && { totalChapters: item.totalChapters }),
      ...overrides,
      lastSyncAt: Date.now(),
    });
    if (item.chaptersRead !== undefined && item.chaptersRead > 0) {
      return this.reconcileTrackerRead(match.bridgeId, match.seriesId, match.key, item.chaptersRead);
    }
    return 0;
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
