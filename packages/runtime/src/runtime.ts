/**
 * ComicalRuntime — host-agnostic orchestration layer that wires bridges to the library.
 *
 * Any host (HTTP server, native app, CLI) constructs one of these with a BridgeProvider and an
 * optional Library, then calls runtime.* instead of manually coordinating the two. The key
 * responsibilities that are NOT in the library or in a bridge individually:
 *
 *   - collectSeries: fetches SeriesInfo from the bridge (for externalIds auto-linking) so callers
 *     only need a bridgeId + seriesId — no separate getSeriesDetails call required.
 *   - markRead / setProgress / markReadUpTo: write library state first, then fire bridge read-sync
 *     if the bridge declares the "read-sync" capability (best-effort — bridge errors are swallowed).
 *   - previewBridgeFavoritesImport / importBridgeFavorites: paginate getFavorites, classify each
 *     against the library (already present / another source for something already present / new),
 *     then bulk-add the caller's selection, grouping in any confirmed cross-bridge duplicates.
 *   - backgroundSync: iterate all library entries, pull fresh chapters, update knownChapters.
 */
import type { Chapter, Cursor, LogCapability, PagedResults, SeriesEntry, SeriesInfo, SeriesRevision, TrackerEntryUpdate, TrackerLibraryEntry, TrackerSearchResult, TrackerStatus } from "@comical/contract";
import { MAX_UPDATE_CHECK_BATCH, trackerEntryUpdateSchema } from "@comical/contract";
import type { z } from "zod";
import { matchSearchResults, sharesName, trackerEntryNames, type trackerImportItemSchema, type trackerImportResolveRequestSchema } from "./tracker-import.ts";
// Import from Node-free subpaths (not the `@comical/core` barrel, which registers the
// node:vm-backed default evaluator) so `@comical/runtime`'s types stay consumable by non-Node
// hosts — e.g. comical-app's embedded runtime typing `RouterOptions.runtime`. See @comical/core.
import type { LoadedBridge } from "@comical/core/loader";
import type { LoadedTracker } from "@comical/core/tracker-loader";
import {
  entryKey,
  normalizeTitle,
  type CollectSeriesResult,
  type Library,
  type CollectionSeriesItem,
  type CollectionSeriesItemView,
  type SeriesItemSnapshot,
  type TrackerLink,
} from "@comical/library";

/** Page cap for an import walk (a bridge's favorites, a tracker's list), mirroring the router's
 *  `isFavorite` fallback scan. A list this long is a runaway `hasNextPage`, not a real account. */
const MAX_IMPORT_PAGES = 50;

/** What a bridge's batch update check said about one entry. See `batchCheckRevisions`. */
interface UpdateCheckOutcome {
  /** The revision the source just reported — stored as the next run's baseline either way. */
  revision: SeriesRevision;
  /** The reported revision matches the stored baseline exactly, so the chapter list can be skipped. */
  unchanged: boolean;
}

/**
 * Do two revisions describe the same state? Compared across the union of their keys rather than
 * field by field, so a field added to `SeriesRevision` later is included automatically. Hard-coding
 * the three current fields would silently start ignoring a fourth — and an ignored field means
 * "unchanged" gets returned for a series that did change, which is the one failure mode the batch
 * check must not have. Every field is a primitive, so `!==` is the whole comparison.
 */
function sameRevision(a: SeriesRevision, b: SeriesRevision): boolean {
  const ax = a as Record<string, unknown>;
  const bx = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ax), ...Object.keys(bx)])) {
    if (ax[k] !== bx[k]) return false;
  }
  return true;
}

/** One favorite, classified against the library. See {@link ComicalRuntime.previewBridgeFavoritesImport}. */
export interface FavoritesImportCandidate {
  seriesId: string;
  title: string;
  thumbnailUrl?: string;
  /**
   * `"in-library"` — already added FROM THIS BRIDGE, so there's nothing to import.
   * `"duplicate"` — a normalized-title match on ANOTHER bridge: importing adds a second source for
   * a series the user already has. `"new"` — no match anywhere.
   */
  status: "new" | "in-library" | "duplicate";
  /** Present for `"duplicate"` — every matching library entry (a title can match more than one). */
  matches?: Array<{ key: string; bridgeId: string; seriesId: string; title: string }>;
}

export interface FavoritesImportPreview {
  items: FavoritesImportCandidate[];
  /** True when the page cap stopped the walk, so `items` is not the whole favorites list. */
  truncated: boolean;
}

/** One series to import. `linkTo` is the `entryKey` of an existing entry it's another source for. */
export interface FavoritesImportItem {
  seriesId: string;
  title: string;
  thumbnailUrl?: string;
  linkTo?: string;
}

/** One entry of a tracker's list, classified against the library. See {@link ComicalRuntime.previewTrackerImport}. */
export interface TrackerImportCandidate {
  externalId: string | number;
  title: string;
  altTitles?: string[];
  thumbnailUrl?: string;
  status: TrackerStatus;
  chaptersRead?: number;
  totalChapters?: number;
  /**
   * `"linked"` — a library series is already linked to this entry, so there's nothing to import.
   * `"in-library"` — the library has it (matched on the tracker's id in the series' `externalIds`, or
   * on title/alternate titles) but not linked: importing links it. `"none"` — no match; a source
   * series has to be found first (see {@link ComicalRuntime.resolveTrackerImport}).
   */
  match: "linked" | "in-library" | "none";
  /** Present for `"in-library"` — every matching series (cross-bridge copies), with its local progress. */
  entries?: Array<{ key: string; bridgeId: string; seriesId: string; title: string; localRead: number }>;
}

export interface TrackerImportPreview {
  items: TrackerImportCandidate[];
  /** True when the page cap stopped the walk, so `items` is not the whole tracker list. */
  truncated: boolean;
}

/** What one bridge turned up for one tracker entry. See {@link ComicalRuntime.resolveTrackerImport}. */
export interface TrackerImportResolveResult {
  externalId: string | number;
  /** A hit the runtime is confident enough to accept on the user's behalf. */
  exact?: SeriesEntry;
  /** Hits the user has to choose between — empty when the bridge found nothing. */
  candidates: SeriesEntry[];
  /** Set when the search itself failed, so "nothing found" isn't mistaken for "source is down". */
  error?: string;
}

/** The library as seen from one tracker — built once per preview. See `indexLibraryForTracker`. */
interface TrackerLibraryIndex {
  /** External ids (as strings) some series is already linked to. */
  linked: Set<string>;
  /** External id (as string) → unlinked series carrying it in `externalIds`. */
  byExternalId: Map<string, CollectionSeriesItem[]>;
  /** Normalized title or alternate title → unlinked series going by it. */
  byName: Map<string, CollectionSeriesItem[]>;
}

/** One tracker entry to import, paired with the source series it resolved to (`bridgeId`/`seriesId`). */
export type TrackerImportItem = z.infer<typeof trackerImportItemSchema>;

/** A tracker entry to find on a bridge — the names the search can use. */
export type TrackerImportResolveEntry = z.infer<typeof trackerImportResolveRequestSchema>["entries"][number];

export interface TrackerImportOptions {
  /** Collections a NEWLY collected series is filed in. Series already in the library keep theirs. */
  collectionIds?: string[];
  /**
   * Mark chapters read up to the tracker's progress on a series the library did NOT have yet. The
   * only way a tracker's progress ever becomes local read state; a series already in the library
   * keeps its own progress regardless.
   */
  seedProgress: boolean;
}

export interface TrackerImportResult {
  /** Series newly added to the library. */
  imported: number;
  /** Tracker links created (one per item that succeeded, new or already collected). */
  linked: number;
  /** Chapters marked read from the tracker's progress on newly added series. */
  seeded: number;
  /** Items whose local progress led the tracker's and was pushed to it. */
  pushed: number;
  failed: Array<{ externalId: string | number; bridgeId: string; seriesId: string; error: string }>;
}

/** Extends CollectSeriesResult with tracker suggestions when no externalId match was found. */
export interface RuntimeAddResult extends CollectSeriesResult {
  /** Candidate tracker matches found by title search for trackers that couldn't be auto-linked. */
  trackerSuggestions?: Array<{ trackerId: string; result: TrackerSearchResult }>;
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
}

export interface BackgroundSyncResult {
  updated: number;
  /** Chapters this run put in the activity feed — not ones another device's run already had. */
  newChapters: number;
  /** Of `newChapters`, those on a series the reader was behind on — see `ActivityItem.behind`. */
  behind: { joined: number; unseen: number };
  /** Chapters newly marked read from a bridge's own read state (`getReadChapters`). */
  readSynced: number;
  /** Library size at scan time. */
  scanned: number;
  /** Entries skipped because they were synced within the staleness window. */
  skipped: number;
  /**
   * Entries a bridge's batch update check reported as unchanged, so their chapter list was never
   * fetched. These are the requests the batch check saved; they are NOT counted in `updated`.
   */
  unchanged: number;
  /** True when the time budget ran out before every candidate was synced. */
  partial: boolean;
}

/** Outcome of a manual per-link tracker sync — see `syncEntryWithTracker`. */
export interface TrackerLinkSyncResult {
  /** The link's record of the tracker was refreshed, or progress was pushed. */
  updated: boolean;
  /** Local progress was ahead and was sent to the tracker. */
  pushed: boolean;
  /** The chapter number both sides now settle on (the pushed number, or the local one when the tracker holds it). */
  chaptersRead: number;
  /** What the tracker reported for this entry, 0 when it has none. Never applied locally — shown so the user can see it. */
  trackerRead: number;
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
 * `reachedTotal` is the rule most readers use: progress has reached the tracker's own chapter
 * count. It's the only one available when a bridge doesn't report publication status.
 * `finishedLocally` is every known chapter read on a series that's over. It's the only one that
 * fires when a source's numbering ends BELOW the tracker's count — BLAME! numbers its logs 1–65
 * plus extras 3.5/7.5 against AniList's count of 66, so `reachedTotal` can never be true for it.
 * Neither subsumes the other.
 *
 * Completion is one-shot, gated on `completedPushedAt` rather than on `status`: a manual sync
 * refreshes `status` from the tracker, so a user who deliberately drops a finished series there
 * would otherwise have "completed" re-pushed over it on the next sync.
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
      // writing it would drag the watermark below what a lookup had raised it to.
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

  // ── collectSeries ─────────────────────────────────────────────────────────────

  /**
   * Collect a series — what "add to library" means now, since being in the library IS having a
   * series collection item. If `snap.seriesTitle` is absent the runtime calls
   * `bridge.getSeriesDetails()` to populate title, thumbnailUrl, author, and externalIds —
   * so callers only need bridgeId + seriesId when they don't already have the series detail.
   *
   * `externalIds` from SeriesInfo are always included in the snapshot so the library's
   * auto-linking logic can fire. `collectionIds` is passed straight through to the library, which
   * files the series in the same write: under pure collections a series that is never filed stays
   * only transiently, so a client adding to "the library" should pass whichever collection its UI
   * treats as the default.
   */
  async collectSeries(
    bridgeId: string,
    seriesId: string,
    snap?: Partial<SeriesItemSnapshot>,
  ): Promise<RuntimeAddResult> {
    const lib = this.requireLibrary();

    let title = snap?.seriesTitle;
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

    const full: SeriesItemSnapshot = { seriesTitle: title };
    if (thumbnailUrl !== undefined) full.thumbnailUrl = thumbnailUrl;
    if (author !== undefined) full.author = author;
    if (externalIds !== undefined) full.externalIds = externalIds;
    if (snap?.collectionIds !== undefined) full.collectionIds = snap.collectionIds;

    const result = await lib.collectSeries({ bridgeId, seriesId }, full);

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
            const res = await tracker.search?.(title);
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
  async markActivityRead(
    bridgeId: string,
    seriesId: string,
    opts: { caughtUpOnly?: boolean } = {},
  ): Promise<{ marked: number }> {
    const result = await this.requireLibrary().markActivityRead(bridgeId, seriesId, opts);
    // Unconditional, like `markRead`: even a zero-marked call is a chance to heal a link that's
    // behind for some other reason (a failed earlier push, a completion never sent).
    await this.syncEntryToTrackers(bridgeId, seriesId).catch(() => {});
    return result;
  }

  // ── Favorites import ──────────────────────────────────────────────────────────

  /**
   * Page a bridge's favorites and classify each against the library, WITHOUT writing anything —
   * the list a host shows for confirmation before importing.
   *
   * Classification is deliberately done here rather than in each client: every host would otherwise
   * re-implement the same title matching, and the rules would drift. See {@link normalizeTitle} for
   * why cross-bridge matching is title-based (a favorites payload is `SeriesEntry` — no externalIds
   * to auto-link on) and why it errs toward missing matches.
   */
  async previewBridgeFavoritesImport(bridgeId: string): Promise<FavoritesImportPreview> {
    const lib = this.requireLibrary();
    const bridge = await this.bridges.get(bridgeId);
    if (!bridge.getFavorites) throw new Error(`bridge "${bridgeId}" does not support favorites`);

    const byTitle = await lib.titleIndex();
    const items: FavoritesImportCandidate[] = [];
    let truncated = false;
    let cursor: Cursor | undefined;
    for (let page = 1; ; page++) {
      const result = await bridge.getFavorites(cursor ? { cursor } : {});
      for (const entry of result.items) {
        items.push(await this.classifyFavorite(lib, byTitle, bridgeId, entry));
      }
      if (!result.nextCursor) break;
      if (page >= MAX_IMPORT_PAGES) { truncated = true; break; }
      cursor = result.nextCursor;
    }
    return { items, truncated };
  }

  private async classifyFavorite(
    lib: Library,
    byTitle: Map<string, CollectionSeriesItem[]>,
    bridgeId: string,
    entry: SeriesEntry,
  ): Promise<FavoritesImportCandidate> {
    const candidate: FavoritesImportCandidate = { seriesId: entry.id, title: entry.title, status: "new" };
    if (entry.thumbnailUrl !== undefined) candidate.thumbnailUrl = entry.thumbnailUrl;

    if (await lib.getSeries(entryKey(bridgeId, entry.id))) {
      candidate.status = "in-library";
      return candidate;
    }
    // Only OTHER bridges count as an overlap — a same-bridge title twin is a different series with a
    // similar name, not another source for this one.
    const matches = (byTitle.get(normalizeTitle(entry.title)) ?? []).filter((e) => e.bridgeId !== bridgeId);
    if (matches.length > 0) {
      candidate.status = "duplicate";
      candidate.matches = matches.map((e) => ({
        key: entryKey(e.bridgeId, e.seriesId),
        bridgeId: e.bridgeId,
        seriesId: e.seriesId,
        title: e.seriesTitle,
      }));
    }
    return candidate;
  }

  /**
   * Add favorites to the library.
   *
   * With a `selection` the caller is importing exactly what the user confirmed in a preview, so the
   * favorites are NOT re-fetched — the entries come straight off the wire. An item's `linkTo` is the
   * `entryKey` of an existing library entry it's another source for; it gets grouped in (existing
   * entry stays primary — see {@link Library.linkEntries}).
   *
   * Without a `selection` this keeps the original behavior: page everything and add whatever isn't
   * already in the library, no cross-bridge linking.
   */
  async importBridgeFavorites(
    bridgeId: string,
    selection?: FavoritesImportItem[],
  ): Promise<{ imported: number; skipped: number; linked: number }> {
    const lib = this.requireLibrary();
    const items = selection ?? (await this.collectAllFavorites(bridgeId));

    let imported = 0;
    let skipped = 0;
    let linked = 0;
    for (const item of items) {
      const key = entryKey(bridgeId, item.seriesId);
      if (await lib.getSeries(key)) { skipped++; continue; }
      const snap: SeriesItemSnapshot = { seriesTitle: item.title };
      if (item.thumbnailUrl !== undefined) snap.thumbnailUrl = item.thumbnailUrl;
      await lib.collectSeries({ bridgeId, seriesId: item.seriesId }, snap);
      imported++;
      if (item.linkTo) {
        // Best-effort: a link target the user removed between preview and confirm must not lose the
        // import that already succeeded.
        try { await lib.linkEntries(item.linkTo, key); linked++; } catch { /* target gone */ }
      }
    }
    return { imported, skipped, linked };
  }

  /** Every favorite the bridge will hand over, flattened — the no-selection import path. */
  private async collectAllFavorites(bridgeId: string): Promise<FavoritesImportItem[]> {
    const bridge = await this.bridges.get(bridgeId);
    if (!bridge.getFavorites) throw new Error(`bridge "${bridgeId}" does not support favorites`);
    const items: FavoritesImportItem[] = [];
    let cursor: Cursor | undefined;
    for (let page = 1; ; page++) {
      const result = await bridge.getFavorites(cursor ? { cursor } : {});
      for (const entry of result.items) {
        items.push({
          seriesId: entry.id,
          title: entry.title,
          ...(entry.thumbnailUrl !== undefined && { thumbnailUrl: entry.thumbnailUrl }),
        });
      }
      if (!result.nextCursor || page >= MAX_IMPORT_PAGES) break;
      cursor = result.nextCursor;
    }
    return items;
  }

  // ── Tracker import ────────────────────────────────────────────────────────────

  /**
   * Page a tracker's list and classify each entry against the library, WITHOUT writing anything —
   * the list a host shows before importing. The tracker-side twin of
   * {@link previewBridgeFavoritesImport}, and classified here for the same reason.
   *
   * A library series counts as the entry's media when it is linked to the entry (`linked`), or —
   * for a series with no link to this tracker at all — when it carries the tracker's id in its
   * `externalIds` or shares a name with the entry (`in-library`). Names are the title plus any
   * alternate titles on EITHER side, folded with {@link normalizeTitle}: a tracker tends to show
   * one language and a source another, so the tracker's romanized title is often the source's
   * alternate title or the other way round. A series already linked to a different entry of this
   * tracker is never offered as a match — a series holds one link per tracker, and a title twin
   * (a sequel, a spin-off) must not silently re-point it.
   */
  async previewTrackerImport(trackerId: string): Promise<TrackerImportPreview> {
    const lib = this.requireLibrary();
    const tracker = await this.requireListableTracker(trackerId);
    const index = await this.indexLibraryForTracker(lib, trackerId);

    const items: TrackerImportCandidate[] = [];
    let truncated = false;
    let cursor: Cursor | undefined;
    for (let page = 1; ; page++) {
      const result = await tracker.getLibrary!(cursor ? { cursor } : {});
      for (const entry of result.items) {
        items.push(await this.classifyTrackerEntry(lib, index, entry));
      }
      if (!result.nextCursor) break;
      if (page >= MAX_IMPORT_PAGES) { truncated = true; break; }
      cursor = result.nextCursor;
    }
    return { items, truncated };
  }

  /** One pass over the library, so classifying a whole tracker list scans it once. */
  private async indexLibraryForTracker(lib: Library, trackerId: string): Promise<TrackerLibraryIndex> {
    const index: TrackerLibraryIndex = { linked: new Set(), byExternalId: new Map(), byName: new Map() };
    const add = (map: Map<string, CollectionSeriesItem[]>, k: string, e: CollectionSeriesItem) => {
      const bucket = map.get(k);
      if (bucket) bucket.push(e);
      else map.set(k, [e]);
    };
    for (const e of await lib.getLibrary()) {
      const key = entryKey(e.bridgeId, e.seriesId);
      const link = await lib.getTrackerLink(key, trackerId);
      if (link) { index.linked.add(String(link.externalId)); continue; }
      const ext = e.externalIds?.[trackerId];
      if (ext !== undefined) add(index.byExternalId, String(ext), e);
      const detail = await lib.getCachedDetail(key);
      for (const raw of [e.seriesTitle, ...(detail?.info.altTitles ?? [])]) {
        const n = normalizeTitle(raw);
        if (n) add(index.byName, n, e);
      }
    }
    return index;
  }

  private async classifyTrackerEntry(
    lib: Library,
    index: TrackerLibraryIndex,
    entry: TrackerLibraryEntry,
  ): Promise<TrackerImportCandidate> {
    const candidate: TrackerImportCandidate = {
      externalId: entry.externalId,
      title: entry.title,
      status: entry.status,
      match: "none",
    };
    if (entry.altTitles !== undefined) candidate.altTitles = entry.altTitles;
    if (entry.thumbnailUrl !== undefined) candidate.thumbnailUrl = entry.thumbnailUrl;
    if (entry.chaptersRead !== undefined) candidate.chaptersRead = entry.chaptersRead;
    if (entry.totalChapters !== undefined) candidate.totalChapters = entry.totalChapters;

    const ext = String(entry.externalId);
    if (index.linked.has(ext)) {
      candidate.match = "linked";
      return candidate;
    }
    // A series can be reached by its external id AND a name — one match, not two.
    const matches = new Map<string, CollectionSeriesItem>();
    for (const e of index.byExternalId.get(ext) ?? []) matches.set(entryKey(e.bridgeId, e.seriesId), e);
    for (const name of trackerEntryNames(entry)) {
      for (const e of index.byName.get(name) ?? []) matches.set(entryKey(e.bridgeId, e.seriesId), e);
    }
    if (matches.size > 0) {
      candidate.match = "in-library";
      candidate.entries = [];
      for (const [key, e] of matches) {
        candidate.entries.push({
          key,
          bridgeId: e.bridgeId,
          seriesId: e.seriesId,
          title: e.seriesTitle,
          localRead: await lib.maxReadChapterNumber(key),
        });
      }
    }
    return candidate;
  }

  /**
   * Find, on one bridge, the source series for tracker entries the library doesn't have. One search
   * per entry (the bridge's own first page), then {@link matchSearchResults}: a hit whose title is
   * one of the entry's names is accepted outright. Failing that, the top hit's full details are
   * fetched once — a source's search listing carries only a title, but its details carry alternate
   * titles and cross-service ids, and either of those naming the entry is as good as a title match.
   * Otherwise the top hits are returned for the user to choose between. An empty first page is
   * retried once under the entry's first alternate title (a source that lists a work under its
   * romanized name finds nothing for the English one).
   *
   * At most three bridge requests per entry. Callers batch the entries (the router caps a call) so
   * a long list is resolved in slices the user can watch and cancel. Per entry best-effort: one
   * failed search reports on that entry and the rest of the batch still resolves.
   */
  async resolveTrackerImport(
    trackerId: string,
    bridgeId: string,
    entries: TrackerImportResolveEntry[],
  ): Promise<TrackerImportResolveResult[]> {
    const bridge = await this.bridges.get(bridgeId);
    if (!bridge.getSearchResults) throw new Error(`bridge "${bridgeId}" does not support search`);

    const out: TrackerImportResolveResult[] = [];
    for (const entry of entries) {
      const names = trackerEntryNames(entry);
      try {
        let results = (await bridge.getSearchResults({ text: entry.title })).items;
        const retry = entry.altTitles?.[0];
        if (results.length === 0 && retry !== undefined && retry !== entry.title) {
          results = (await bridge.getSearchResults({ text: retry })).items;
        }

        let split = matchSearchResults(names, results);
        const top = results[0];
        if (!split.exact && top) {
          const info = await bridge.getSeriesDetails(top.id).catch(() => undefined);
          const sameId = info?.externalIds?.[trackerId] !== undefined
            && String(info.externalIds[trackerId]) === String(entry.externalId);
          if (info && (sameId || sharesName(names, info))) split = matchSearchResults(names, results, top);
        }
        out.push({ externalId: entry.externalId, ...split });
      } catch (err) {
        this.log?.warn(`tracker import: search failed on ${bridgeId} for "${entry.title}":`, errMessage(err));
        out.push({ externalId: entry.externalId, candidates: [], error: errMessage(err) });
      }
    }
    return out;
  }

  /**
   * Import tracker entries, each paired with the source series it resolved to (or the library
   * series it matched). Per item:
   *
   *   - not in the library → collect it (details and chapters cached, filed in `collectionIds`),
   *     link it, record what the tracker holds on the link, and — with `seedProgress` — mark
   *     chapters read up to the tracker's progress. This is the ONE place a tracker's progress
   *     becomes local read state, and it is only ever for a series the library didn't have.
   *   - already in the library → link it and reconcile push-only, exactly like the manual sync: the
   *     tracker is updated when local progress leads, and local chapters are never touched. A series
   *     the user has read here keeps its progress whatever the tracker says.
   *
   * Idempotent: re-importing an item re-links (a no-op) and reconciles again. Failures are isolated
   * per item and reported, never thrown mid-batch — the items before and after still land.
   */
  async importTrackerEntries(
    trackerId: string,
    items: TrackerImportItem[],
    opts: TrackerImportOptions,
  ): Promise<TrackerImportResult> {
    const lib = this.requireLibrary();
    if (!this.trackers) throw new Error("ComicalRuntime: no trackers configured");
    const tracker = await this.trackers.get(trackerId);
    const canPush = tracker.info.capabilities.includes("status-sync") && !!tracker.updateEntry;

    const result: TrackerImportResult = { imported: 0, linked: 0, seeded: 0, pushed: 0, failed: [] };
    for (const item of items) {
      const key = entryKey(item.bridgeId, item.seriesId);
      try {
        const existing = await lib.getSeries(key);
        const hadLink = existing !== undefined && (await lib.getTrackerLink(key, trackerId)) !== undefined;
        let chapters: Chapter[] | undefined;
        if (!existing) {
          chapters = await this.collectForImport(lib, item, opts.collectionIds);
          result.imported++;
        }

        if (!hadLink) result.linked++;
        await lib.linkTracker(key, trackerId, item.externalId);
        const link = (await lib.getTrackerLink(key, trackerId))!;
        const remote: TrackerLibraryEntry = {
          externalId: item.externalId,
          title: item.title,
          status: item.status,
          ...(item.chaptersRead !== undefined && { chaptersRead: item.chaptersRead }),
          ...(item.totalChapters !== undefined && { totalChapters: item.totalChapters }),
        };

        if (!existing) {
          // Nothing local can lead on a series that didn't exist a moment ago, so there is nothing to
          // push; the link just takes the tracker's state, and the seed (if wanted) matches it.
          await this.recordTrackerEntry(key, trackerId, remote, link.chaptersRead ?? 0);
          if (opts.seedProgress && item.chaptersRead !== undefined && item.chaptersRead > 0) {
            result.seeded += await this.reconcileTrackerRead(item.bridgeId, item.seriesId, key, item.chaptersRead, chapters);
          }
        } else {
          const sync = await this.syncLinkWithEntry(key, trackerId, link, remote, canPush ? tracker : undefined);
          if (sync.pushed) result.pushed++;
        }
      } catch (err) {
        this.log?.warn(`tracker import failed: ${trackerId} ${key}:`, errMessage(err));
        result.failed.push({ externalId: item.externalId, bridgeId: item.bridgeId, seriesId: item.seriesId, error: errMessage(err) });
      }
    }
    return result;
  }

  /**
   * Collect a series the import found on a bridge. The source's own details are preferred over
   * what the tracker knows (the tracker's title is in its language, not the source's), with the
   * tracker's as the fallback so an unreachable detail page still adds the series. The chapter list
   * fetched for the offline cache is returned so the seed can reuse it instead of fetching twice.
   *
   * Not {@link collectSeries}: that runs a title search on every configured tracker per series,
   * which for a bulk import of a tracker's own list is both pointless and rate-limit poison. Any
   * OTHER tracker's id in the source's details still auto-links, as it would for a browsed add.
   */
  private async collectForImport(
    lib: Library,
    item: TrackerImportItem,
    collectionIds: string[] | undefined,
  ): Promise<Chapter[] | undefined> {
    const key = entryKey(item.bridgeId, item.seriesId);
    const bridge = await this.bridges.get(item.bridgeId);
    const info = await bridge.getSeriesDetails(item.seriesId).catch(() => undefined);

    const snap: SeriesItemSnapshot = { seriesTitle: info?.title ?? item.title };
    const thumbnailUrl = info?.thumbnailUrl ?? item.thumbnailUrl;
    if (thumbnailUrl !== undefined) snap.thumbnailUrl = thumbnailUrl;
    if (info?.author !== undefined) snap.author = info.author;
    if (info?.externalIds !== undefined) snap.externalIds = info.externalIds;
    if (collectionIds !== undefined) snap.collectionIds = collectionIds;
    await lib.collectSeries({ bridgeId: item.bridgeId, seriesId: item.seriesId }, snap);

    // Offline metadata capture, best-effort as in `collectSeries` — the add itself already landed.
    let chapters: Chapter[] | undefined;
    try {
      if (info) await lib.cacheSeriesDetail(key, info);
      if (bridge.getChapters) {
        chapters = await bridge.getChapters(item.seriesId);
        await lib.syncChapters(key, chapters);
      }
    } catch {
      // Browsing/background sync write it through later.
    }
    await this.relinkEntry(item.bridgeId, item.seriesId, info?.externalIds);
    return chapters;
  }

  private async requireListableTracker(trackerId: string): Promise<LoadedTracker> {
    if (!this.trackers) throw new Error("ComicalRuntime: no trackers configured");
    const tracker = await this.trackers.get(trackerId);
    if (!tracker.info.capabilities.includes("library-sync") || !tracker.getLibrary) {
      throw new Error(`tracker "${trackerId}" does not support library-sync`);
    }
    return tracker;
  }

  // ── Background sync ───────────────────────────────────────────────────────────

  /**
   * One reconciliation pass over the library. Per entry: pull fresh chapters (new-chapter
   * detection), auto-link any newly-configured trackers, union-merge the bridge's read state, and
   * push local read state out to the entry's trackers. Trackers are never pulled from here — see
   * `syncEntryWithTracker` for why progress only flows TO a tracker. The bridge read-state pull goes
   * through `reconcileRead`, so it updates read flags WITHOUT moving the user's resume point or
   * recency. Per-entry errors are swallowed so one unreachable source doesn't abort the run.
   *
   * Before the per-entry pass, every bridge implementing `checkForUpdates` is asked in bulk which of
   * its candidates actually changed (see `batchCheckRevisions`). Entries it reports as unchanged skip
   * their chapter fetch entirely, which is what turns a 200-series library from ~200 requests into a
   * couple per bridge plus one per series that really moved. A bridge without the method, one whose
   * check fails, and every entry the check declines to answer for all fall back to a full fetch.
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
    } = opts;
    const startedAt = Date.now();

    const entries = await lib.getLibrary();
    const candidates = force
      ? [...entries]
      : entries.filter((e) => e.chaptersSyncedAt === undefined || startedAt - e.chaptersSyncedAt > staleMs);
    // Stalest first (never-synced entries lead) so a truncated run picks up the remainder next time.
    candidates.sort((a, b) => (a.chaptersSyncedAt ?? -1) - (b.chaptersSyncedAt ?? -1));

    const deadlineAt = budgetMs === undefined ? undefined : startedAt + budgetMs;

    // Ask each batch-capable bridge, in one request per ~100 series, which of its entries actually
    // changed. Everything it reports as unchanged skips its `getChapters` below — the difference
    // between one request per library entry and a couple per bridge. `force` only bypasses the
    // staleness filter above (which candidates are considered) — it does not bypass this check, so
    // "Check for updates" still gets the cheap batch pre-pass rather than a full fetch of everything.
    const checks = await this.batchCheckRevisions(candidates, deadlineAt);

    const counters = { updated: 0, newChapters: 0, behind: { joined: 0, unseen: 0 }, readSynced: 0, unchanged: 0 };
    let partial = false;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < candidates.length) {
        // Budget gates *starting* entries, but never the very first one — a run must always make
        // forward progress, or a budget shorter than startup overhead would starve forever.
        if (next > 0 && deadlineAt !== undefined && Date.now() >= deadlineAt) {
          partial = true;
          return;
        }
        const entry = candidates[next++]!;
        await this.syncOneEntry(entry, counters, detailStaleMs, checks.get(entryKey(entry.bridgeId, entry.seriesId)));
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

    // Keep the activity feed bounded — best-effort, never fails the sync.
    await lib.pruneActivity().catch(() => {});

    return {
      ...counters,
      scanned: entries.length,
      skipped: entries.length - candidates.length,
      partial,
    };
  }

  /**
   * Batch update check: for every bridge that implements `checkForUpdates`, ask about all of its
   * candidate entries in chunks and return what came back, keyed by entry.
   *
   * Every candidate of a batch-capable bridge is asked about, including ones with no stored
   * revision — those can't be skipped this run, but the answer becomes the baseline that lets the
   * NEXT run skip them. Asking only about entries that already had a baseline would mean none was
   * ever acquired and the check would never fire at all.
   *
   * Conservative throughout: a bridge that can't be loaded, throws, or omits a series simply isn't
   * in the result, and the caller does the full fetch. Nothing here can cause an update to be
   * missed; the worst case is the per-entry behavior that predates it.
   */
  private async batchCheckRevisions(
    candidates: CollectionSeriesItemView[],
    deadlineAt: number | undefined,
  ): Promise<Map<string, UpdateCheckOutcome>> {
    const out = new Map<string, UpdateCheckOutcome>();
    const byBridge = new Map<string, CollectionSeriesItemView[]>();
    for (const e of candidates) {
      const list = byBridge.get(e.bridgeId);
      if (list) list.push(e);
      else byBridge.set(e.bridgeId, [e]);
    }

    for (const [bridgeId, entries] of byBridge) {
      const bridge = await this.bridges.get(bridgeId).catch(() => undefined);
      if (!bridge?.checkForUpdates) continue;
      const bySeriesId = new Map(entries.map((e) => [e.seriesId, e]));
      for (let i = 0; i < entries.length; i += MAX_UPDATE_CHECK_BATCH) {
        // The check is a net saving, but it isn't free — once past the deadline stop asking and let
        // the (already budget-gated) per-entry pass do what it can with the time that's left.
        if (deadlineAt !== undefined && Date.now() >= deadlineAt) return out;
        const chunk = entries.slice(i, i + MAX_UPDATE_CHECK_BATCH);
        const answered = await bridge
          .checkForUpdates(chunk.map((e) => e.seriesId))
          .catch(() => undefined);
        if (!answered) continue; // one bad chunk falls back to per-entry fetches, nothing more
        for (const [seriesId, revision] of Object.entries(answered)) {
          const entry = bySeriesId.get(seriesId);
          if (!entry) continue;
          out.set(entryKey(bridgeId, seriesId), {
            revision,
            // Unchanged ONLY when there's a baseline and it matches exactly. No baseline means we
            // can't prove anything, so it reads as changed and gets the full fetch.
            unchanged: entry.revision !== undefined && sameRevision(entry.revision, revision),
          });
        }
      }
    }
    return out;
  }

  /**
   * One entry's reconciliation pass — see backgroundSync. Errors are swallowed per entry.
   *
   * `check` carries the batch update check's answer for this entry, when its bridge supports one.
   * `check.unchanged` means the chapter list provably hasn't moved, so the `getChapters` round-trip
   * is skipped; otherwise `check.revision` is stored alongside the list this run does fetch, as the
   * baseline the next run compares against. Everything below the chapter pull still runs either way:
   * a revision describes the chapter list only, and says nothing about read state, tracker links, or
   * detail staleness.
   */
  private async syncOneEntry(
    entry: CollectionSeriesItemView,
    counters: {
      updated: number;
      newChapters: number;
      behind: { joined: number; unseen: number };
      readSynced: number;
      unchanged: number;
    },
    detailStaleMs?: number,
    check?: UpdateCheckOutcome,
  ): Promise<void> {
    const lib = this.requireLibrary();
    try {
      const bridge = await this.bridges.get(entry.bridgeId);
      const key = entryKey(entry.bridgeId, entry.seriesId);

      // Pull fresh chapter list and detect new chapters.
      let chapters: Chapter[] | undefined;
      if (check?.unchanged) {
        // Still has to be marked checked, or stalest-first ordering would hand this entry back on
        // every run and starve the rest of the library — see `markChaptersUnchanged`.
        await lib.markChaptersUnchanged(key, check.revision);
        counters.unchanged++;
      } else if (bridge.getChapters) {
        chapters = await bridge.getChapters(entry.seriesId);
        const result = await lib.syncChapters(key, chapters, check?.revision);
        counters.newChapters += result.fresh.length;
        counters.behind.joined += result.joined.length;
        counters.behind.unseen += result.unseen.length;
        counters.updated++;
      }

      // Wire up any tracker configured after this entry was added (externalId already known).
      await this.relinkEntry(entry.bridgeId, entry.seriesId, entry.externalIds);

      await this.refreshStaleDetail(bridge, entry.seriesId, key, detailStaleMs).catch(() => {});

      // Union-merge the bridge's read state — read flags only, resume untouched.
      if (bridge.getReadChapters) {
        const remoteRead = await bridge.getReadChapters(entry.seriesId);
        // Fall back to the entry's own `knownChapters` for the number lookup when the chapter fetch
        // was skipped: the batch check said the list hasn't changed, so what we already stored IS the
        // current list, and read reconciliation keeps its chapter numbers.
        const numById = new Map((chapters ?? entry.knownChapters ?? []).map((c) => [c.id, c.number]));
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

  /**
   * Link a library entry to a tracker (e.g. after the user selects from a search result), then
   * sync it once.
   *
   * Goes through `syncEntryWithTracker` rather than a bare push because a fresh link has no
   * `chaptersRead`: a push would treat any local progress as an advance and overwrite a service that
   * is further along — link a series you read 40 chapters of on AniList and have 3 of locally, and a
   * bare push would report 3. Looking the entry up first records what the tracker holds on the link
   * (progress watermark, status, `totalChapters` for the completion trigger and the progress clamp),
   * so only progress that genuinely leads is pushed.
   *
   * Best-effort: a tracker that's unreachable, unlistable or push-only must not fail the link
   * itself — the next read pushes as usual.
   */
  async linkTracker(bridgeId: string, seriesId: string, trackerId: string, externalId: string | number): Promise<void> {
    await this.requireLibrary().linkTracker(entryKey(bridgeId, seriesId), trackerId, externalId);
    try {
      await this.syncEntryWithTracker(bridgeId, seriesId, trackerId);
    } catch (err) {
      this.log?.warn(`tracker link sync failed: ${trackerId} ${entryKey(bridgeId, seriesId)}:`, errMessage(err));
    }
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
    const { fullyRead, seriesFinished } = await this.requireLibrary().getSeriesCompletion(key);
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
   * Sync one library entry's tracker link — the manual, per-row "Sync" action.
   *
   * ONE-WAY: progress flows from the library TO the tracker, never back. The tracker's entry is
   * looked up and RECORDED on the link (its status, chapter count and progress), but no local chapter
   * is ever marked read from it. Tracker counts and source numbering disagree too often for that to
   * be safe — volume-counted titles, split chapters, decimals — and marking a chapter read is not
   * something a user can tell happened behind their back. Read state is the library's; what the
   * tracker holds is shown, and overtaken when local leads. (The tracker import is the one place a
   * tracker's progress seeds local read state, for a series the library didn't have yet.)
   *
   *   - local ahead  → push `chaptersRead` to the tracker (`updateEntry`)
   *   - otherwise    → nothing moves; the link is re-stamped with what the tracker holds
   *
   * "Local ahead" is measured against the link's WATERMARK (raised to the tracker's own number by
   * the lookup), not against what the tracker echoes back. A tracker may store our number lossily —
   * AniList and MAL both take an integer, so chapter 12.5 lands as 12 — and against the echo local
   * would read as ahead forever, re-pushing on every sync and never once reporting "already in
   * sync". The watermark records what we know reached the tracker, so the comparison settles
   * regardless of what the service did to the value. This is the generic form of the problem: it
   * costs the trackers nothing to declare and holds for any future one that rounds, clamps, or
   * otherwise reshapes what it's given.
   *
   * Capability-adaptive: a tracker with only `library-sync` still records what it holds, one with
   * only `status-sync` still pushes. Finding the remote entry pages through `tracker.getLibrary`
   * (the contract has no single-entry lookup); that cost is acceptable for an infrequent,
   * user-initiated action. When the tracker's list has no entry for this link, remote counts as 0 —
   * so a local count pushes and CREATES it there (`SaveMediaListEntry` upserts).
   */
  async syncEntryWithTracker(
    bridgeId: string,
    seriesId: string,
    trackerId: string,
  ): Promise<TrackerLinkSyncResult> {
    const lib = this.requireLibrary();
    if (!this.trackers) throw new Error("ComicalRuntime: no trackers configured");
    const key = entryKey(bridgeId, seriesId);
    const link = await lib.getTrackerLink(key, trackerId);
    if (!link) throw new Error(`no ${trackerId} link for this entry`);
    const tracker = await this.trackers.get(trackerId);

    const canLookup = tracker.info.capabilities.includes("library-sync") && !!tracker.getLibrary;
    const canPush = tracker.info.capabilities.includes("status-sync") && !!tracker.updateEntry;
    if (!canLookup && !canPush) {
      throw new Error(`tracker "${trackerId}" supports neither library-sync nor status-sync`);
    }

    // Locate this link's entry in the tracker's list (list-capable trackers only).
    let remote: TrackerLibraryEntry | undefined;
    if (canLookup) {
      let cursor: Cursor | undefined;
      while (true) {
        const result = await tracker.getLibrary!(cursor ? { cursor } : {});
        const item = result.items.find((i) => String(i.externalId) === String(link.externalId));
        if (item) { remote = item; break; }
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
    }

    return this.syncLinkWithEntry(key, trackerId, link, remote, canPush ? tracker : undefined);
  }

  /**
   * The push-only reconcile of one link against the tracker entry already in hand: record what the
   * tracker holds, then push if local leads. Shared by the manual sync (which looks the entry up)
   * and the tracker import (which holds the whole list already).
   *
   * The decision is made against the FRESHEST view of the link: folding the tracker's own number
   * into the watermark is what makes a push require local to be ahead of both the echo and what the
   * tracker is known to hold, and its chapter count is what the push is clamped to.
   */
  private async syncLinkWithEntry(
    key: string,
    trackerId: string,
    link: TrackerLink,
    remote: TrackerLibraryEntry | undefined,
    pushTo: { updateEntry?: (externalId: string | number, update: TrackerEntryUpdate) => Promise<void> } | undefined,
  ): Promise<TrackerLinkSyncResult> {
    const lib = this.requireLibrary();
    const localRead = await lib.maxReadChapterNumber(key);
    const remoteRead = remote?.chaptersRead ?? 0;
    const watermark = link.chaptersRead ?? 0;

    const effective: TrackerLink = {
      ...link,
      ...(remote?.status !== undefined && { status: remote.status }),
      ...(remote?.totalChapters !== undefined && { totalChapters: remote.totalChapters }),
      chaptersRead: Math.max(watermark, remoteRead),
    };
    const finishedLocally = link.completedPushedAt === undefined ? await this.isFinishedLocally(key) : false;
    const decision = pushTo ? decideTrackerPush(effective, localRead, finishedLocally) : undefined;

    if (decision) {
      // Same bounded retry as the implicit push — here the error isn't swallowed, it's thrown at the
      // user who pressed the button, so it's worth being sure it's real before reporting it.
      await this.pushToTracker(pushTo!, link.externalId, decision.update);
    }

    // What the tracker holds lands on the link either way; what was just pushed wins over the
    // now-stale remote status. The watermark never drops to a lossy echo of an earlier push.
    await this.recordTrackerEntry(key, trackerId, remote, watermark, decision?.link);

    if (decision?.update.chaptersRead !== undefined) {
      return { updated: true, pushed: true, chaptersRead: decision.update.chaptersRead, trackerRead: remoteRead };
    }
    if (remote) {
      // Which number to report as "where you both are". When local reads ahead of the echo but not of
      // the watermark, the tracker DOES hold this progress and is merely reporting it back coarsely
      // (12.5 → 12), so the local number is the honest answer.
      const settledLossy = localRead > remoteRead && localRead <= watermark;
      return { updated: true, pushed: !!decision, chaptersRead: settledLossy ? localRead : remoteRead, trackerRead: remoteRead };
    }
    if (decision) {
      return { updated: true, pushed: true, chaptersRead: localRead, trackerRead: remoteRead };
    }
    // Nothing on the tracker's list for this link — a list-capable tracker that doesn't hold it, or
    // a push-only tracker, which has no list at all. `updated` separates "settled at a count the
    // tracker already holds" from "neither side has anything yet": the difference between reporting
    // "already in sync" and "nothing to sync".
    return {
      updated: localRead > 0 && localRead <= watermark,
      pushed: false,
      chaptersRead: localRead,
      trackerRead: remoteRead,
    };
  }

  /**
   * Write what a tracker holds for one entry onto its link: status, chapter count, and progress as
   * the watermark. Read flags are NOT touched — see `syncEntryWithTracker`.
   *
   * `watermark` is the link's current `chaptersRead`, passed in because every caller already holds
   * the link. The write keeps the higher of the two: a lookup must never drag the watermark down to
   * a lossy echo of what we pushed, or the next sync would see local as ahead again and re-push.
   *
   * `overrides` wins over `item`. It exists for the callers that PUSH before recording: the item
   * predates that push, so its `status` is stale and would otherwise clobber the status we just sent.
   */
  private async recordTrackerEntry(
    key: string,
    trackerId: string,
    item: TrackerLibraryEntry | undefined,
    watermark: number,
    overrides?: Partial<TrackerLink>,
  ): Promise<void> {
    await this.requireLibrary().updateTrackerLink(key, trackerId, {
      ...(item?.status !== undefined && { status: item.status }),
      ...(item?.chaptersRead !== undefined && { chaptersRead: Math.max(item.chaptersRead, watermark) }),
      // The only place the tracker's own chapter count enters local state. Until a lookup has run,
      // pushes are unclamped and can only complete via the local signal.
      ...(item?.totalChapters !== undefined && { totalChapters: item.totalChapters }),
      ...overrides,
      lastSyncAt: Date.now(),
    });
  }

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

  /**
   * Link an existing entry to any configured tracker whose externalId is already on the entry but
   * not yet linked — the re-link counterpart to the auto-link `collectSeries` does, for series that
   * predate a tracker being configured. Best-effort; never throws.
   */
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
   *
   * This is the ONLY path by which a tracker's progress becomes local read state, and it is reserved
   * for seeding a series the library did not have until now (the tracker import). The sync paths
   * never call it — see `syncEntryWithTracker`. A caller that already fetched the chapter list
   * passes it in rather than paying for a second fetch.
   */
  private async reconcileTrackerRead(
    bridgeId: string,
    seriesId: string,
    key: string,
    chaptersRead: number,
    chapters?: Chapter[],
  ): Promise<number> {
    const lib = this.requireLibrary();
    if (!chapters) {
      try {
        const bridge = await this.bridges.get(bridgeId);
        if (!bridge.getChapters) return 0;
        chapters = await bridge.getChapters(seriesId);
      } catch {
        return 0;
      }
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
  async searchTracker(
    trackerId: string,
    query: string,
    cursor?: Cursor,
  ): Promise<PagedResults<TrackerSearchResult>> {
    if (!this.trackers) throw new Error("ComicalRuntime: no trackers configured");
    const tracker = await this.trackers.get(trackerId);
    if (!tracker.info.capabilities.includes("search") || !tracker.search) {
      throw new Error(`tracker "${trackerId}" does not support search`);
    }
    return tracker.search(query, cursor ? { cursor } : {});
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
