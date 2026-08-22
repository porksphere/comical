/**
 * The library domain service. ALL behaviour lives here so every store backend (memory, file,
 * IndexedDB, SQLite) and every host behaves identically — a store only persists documents.
 *
 * Identity is the cross-bridge pair `(bridgeId, seriesId)`, encoded via `entryKey`. The library is
 * fully independent of any bridge's backend `favorites`: adding here never touches a bridge.
 */
import type { Chapter, SeriesInfo, SeriesRevision, SeriesStatus } from "@comical/contract";
import { normalizeTitle } from "./match.ts";
import {
  cachedChaptersSchema,
  cachedSeriesDetailSchema,
  entryKey,
  legacyLibraryEntrySchema,
  collectionItemId,
  parseEntryKey,
  type ActivityItem,
  type ActivityItemView,
  type BridgePrefs,
  type CachedChapters,
  type CachedSeriesDetail,
  type ChapterPageRef,
  type ChapterProgress,
  type ChapterItemCoord,
  type CollectionChapterItem,
  type ChapterItemSnapshot,
  type Collection,
  type CollectionItem,
  type CollectionItemCoord,
  type CollectionItemType,
  type PageItemCoord,
  type CollectionPageItem,
  type PageItemSnapshot,
  type SeriesItemCoord,
  type SeriesItemSnapshot,
  type CollectionSeriesItem,
  type HistoryItem,
  type KnownChapter,
  type CollectionSeriesItemView,
  type ResumePoint,
  type SeriesGroup,
  type TrackerLink,
} from "./models.ts";
import type { LibraryStore } from "./store.ts";

/** Returned when collecting a series. `autoLinked` is set when a NEW series was automatically
 *  grouped with an already-collected one via a shared external id. */
export interface CollectSeriesResult {
  item: CollectionSeriesItem;
  autoLinked?: {
    matchedKey: string;
    sharedId: { service: string; value: number | string };
  };
}

/** Whether a collected series is finished, and the evidence for it. See {@link Library.getSeriesCompletion}. */
export interface SeriesCompletion {
  /** No known logical chapter `(number, language)` is missing a read copy. False when nothing is synced. */
  fullyRead: boolean;
  /** Publication status from the cached series detail; "unknown" when nothing is cached. */
  seriesStatus: SeriesStatus;
  /** The series will gain no more chapters ("completed" or "cancelled"). */
  seriesFinished: boolean;
}

export interface LibraryOptions {
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Sort keys for {@link Library.getLibrary}. */
export type LibrarySort = "added" | "title" | "lastRead" | "unread";

/** Filter + sort options for {@link Library.getLibrary}. All optional. */
export interface LibraryQuery {
  /** Single-collection filter. Prefer `collections`. */
  collection?: string;
  /** Filter to series in ANY of these collections. Empty/absent means all. */
  collections?: string[];
  /** Only series in no collection — a transient state between a collect and its first filing.
   *  Takes precedence over `collection`/`collections`. */
  uncollected?: boolean;
  /** Case-insensitive substring search over title + author. */
  q?: string;
  /** Only series with at least one unread chapter. */
  unreadOnly?: boolean;
  /** Sort key. Defaults to `"added"`. */
  sort?: LibrarySort;
  /** Sort direction. Defaults to `"asc"` for `title`, `"desc"` otherwise. */
  dir?: "asc" | "desc";
}

/** Sort keys for {@link Library.getCollectionItems}. Direction is a separate `dir`, as on `getLibrary` —
 *  folding it into the key (an `"oldest"` alongside `"added"`) can't express "series, descending"
 *  without inventing another key for every combination. */
export type CollectionItemsSort = "added" | "series" | "chapter";

/** Filter + sort options for {@link Library.getCollectionItems}. All optional. */
export interface CollectionItemsQuery {
  /** Restrict to one item type; absent means the mixed union. */
  type?: CollectionItemType;
  /**
   * - `added` (default) — by favorite date.
   * - `series` — grouped by series title, by favorite date within each.
   * - `chapter` — reading order: series title, then chapter name, then page index (series items
   *   sort ahead of their chapters, chapters ahead of their pages, via empty-key fallbacks).
   */
  sort?: CollectionItemsSort;
  /** Sort direction. Defaults to `"desc"` for `added` (newest first) and `"asc"` otherwise. */
  dir?: "asc" | "desc";
  /** A collection id. (There is no "uncollected" sentinel: items exist only as members, so an
   *  uncollected item is at most a transient state between a create and its first filing.) */
  collection?: string;
  /** Restrict to one series, as an `entryKey` (`${bridgeId}:${seriesId}`). */
  series?: string;
  /** Case-insensitive substring search over series title + chapter name. */
  q?: string;
}

/** Compare two favorite items by `sort` key in ASCENDING order; callers apply direction, exactly as
 *  `compareEntries` does. Every branch falls through to the derived id so repeated calls are
 *  stable — and note `dir` flips the tie-breakers too, since one sign covers the whole comparison. */
function compareCollectionItems(a: CollectionItem, b: CollectionItem, sort: CollectionItemsSort): number {
  const byDate = a.collectedAt - b.collectedAt || a.id.localeCompare(b.id);
  switch (sort) {
    case "added":
      return byDate;
    case "series":
      return a.seriesTitle.localeCompare(b.seriesTitle) || byDate;
    case "chapter": {
      // Reading order across the union: a series item leads its own chapters (empty chapter key),
      // and a chapter item leads its own pages (index -1).
      const chapterKey = (i: CollectionItem) => (i.type === "series" ? "" : (i.chapterName ?? ""));
      const pageKey = (i: CollectionItem) => (i.type === "page" ? i.pageIndex : -1);
      return (
        a.seriesTitle.localeCompare(b.seriesTitle) ||
        chapterKey(a).localeCompare(chapterKey(b)) ||
        pageKey(a) - pageKey(b) ||
        a.id.localeCompare(b.id)
      );
    }
  }
}

/** Compare two collected-series views by `sort` key in ascending order (callers apply direction). */
function compareSeries(a: CollectionSeriesItemView, b: CollectionSeriesItemView, sort: LibrarySort): number {
  switch (sort) {
    case "title":
      return a.seriesTitle.localeCompare(b.seriesTitle);
    case "lastRead":
      return (a.lastReadAt ?? 0) - (b.lastReadAt ?? 0);
    case "unread":
      return a.unreadCount - b.unreadCount;
    case "added":
      return a.collectedAt - b.collectedAt;
  }
}

export class Library {
  private readonly now: () => number;

  constructor(
    private readonly store: LibraryStore,
    opts: LibraryOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  // ── Collected series ───────────────────────────────────────────────────────
  // A tracked series IS a `CollectionSeriesItem`: there is no separate library entry. "In the
  // library" means the item exists, which under pure collections means it is in at least one
  // collection (a freshly-collected series is transiently uncollected until the caller files it).
  // Satellite documents — progress, cached detail/chapters, tracker links, activity — hang off it.

  /** The derived id of a series item, from its `entryKey`. */
  private seriesItemId(key: string): string {
    const { bridgeId, seriesId } = parseEntryKey(key);
    return collectionItemId({ type: "series", bridgeId, seriesId });
  }

  private async getSeriesItem(key: string): Promise<CollectionSeriesItem | undefined> {
    const item = await this.store.getCollectionItem(this.seriesItemId(key));
    return item?.type === "series" ? hydrateSeriesItem(item) : undefined;
  }

  private async putSeriesItem(item: CollectionSeriesItem): Promise<void> {
    await this.store.putCollectionItems([item]);
  }

  private async listSeriesItems(): Promise<CollectionSeriesItem[]> {
    return (await this.store.listCollectionItems({ type: "series" }))
      .filter((i): i is CollectionSeriesItem => i.type === "series")
      .map(hydrateSeriesItem);
  }

  /**
   * Collect a series — the operation that used to be "add to library". IDEMPOTENT and MERGING, like
   * every other item PUT: a supplied snapshot field wins as the fresher value, an omitted one is
   * preserved, and `collectedAt` / `collectionIds` / all tracking state carry over.
   *
   * `snap.collectionIds` files the series in the SAME call — the common case, since under pure
   * collections a series nobody filed is only transiently collected. Unknown ids are dropped, and a
   * list that resolves empty leaves the memberships alone rather than deleting what was just
   * collected; `setItemCollections` remains the way to empty them deliberately.
   */
  async collectSeries(coord: SeriesItemCoord, snap: SeriesItemSnapshot): Promise<CollectSeriesResult> {
    const key = entryKey(coord.bridgeId, coord.seriesId);
    const existing = await this.getSeriesItem(key);
    const t = this.now();
    let filed: string[] | undefined;
    if (snap.collectionIds?.length) {
      const known = new Set((await this.store.listCollections()).map((c) => c.id));
      const resolved = [...new Set(snap.collectionIds)].filter((c) => known.has(c));
      if (resolved.length > 0) filed = resolved;
    }
    const thumbnailUrl = snap.thumbnailUrl ?? existing?.thumbnailUrl;
    const author = snap.author ?? existing?.author;
    const externalIds = snap.externalIds ?? existing?.externalIds;
    const item: CollectionSeriesItem = {
      type: "series",
      ...coord,
      id: this.seriesItemId(key),
      collectedAt: existing?.collectedAt ?? t,
      collectionIds: filed ?? existing?.collectionIds ?? [],
      seriesTitle: snap.seriesTitle,
      updatedAt: t,
      knownChapters: existing?.knownChapters ?? [],
      ...(thumbnailUrl !== undefined && { thumbnailUrl }),
      ...(author !== undefined && { author }),
      ...(externalIds !== undefined && { externalIds }),
      ...(existing?.chaptersSyncedAt !== undefined && { chaptersSyncedAt: existing.chaptersSyncedAt }),
      ...(existing?.revision !== undefined && { revision: existing.revision }),
      ...(existing?.lastReadChapterId !== undefined && { lastReadChapterId: existing.lastReadChapterId }),
      ...(existing?.lastReadChapterName !== undefined && { lastReadChapterName: existing.lastReadChapterName }),
      ...(existing?.lastReadAt !== undefined && { lastReadAt: existing.lastReadAt }),
      ...(existing?.seriesGroupId !== undefined && { seriesGroupId: existing.seriesGroupId }),
    };
    await this.putSeriesItem(item);

    // Auto-link: a NEWLY collected series carrying externalIds joins any already-collected series
    // that shares one. No user action required.
    let autoLinked: CollectSeriesResult["autoLinked"];
    if (!existing && snap.externalIds) {
      const match = await this.findExternalIdMatch(key, snap.externalIds);
      if (match) {
        await this.linkEntries(match.matchedKey, key);
        autoLinked = match;
      }
    }

    return { item, ...(autoLinked !== undefined && { autoLinked }) };
  }

  /**
   * One-shot import of a host's pre-collections entries document.
   *
   * The library dissolving into collections is the project's one exception to "no back-compat, no
   * data migration". The rule was made for lists and page favorites, which shipped to nothing. The
   * library is different: it is the user's actual collection, built up over months, and everything
   * hanging off a series — progress, tracker links, cached detail and chapters, group membership —
   * is keyed by `entryKey` in its own document, so it all SURVIVED the dissolution and is merely
   * orphaned. Rebuilding the series items reattaches the lot. Skipping the migration would throw
   * away a library to avoid writing thirty lines.
   *
   * Lives here rather than in each store because it is domain logic, not persistence: a host reads
   * its own legacy document (only it knows where that lives) and hands the rows over. Rows are
   * validated individually and bad ones skipped — a partially-corrupt old document should yield
   * what it can.
   *
   * Idempotent: coordinates already collected are left exactly as they are, so a re-run after a
   * crash is safe and can never clobber post-migration edits.
   *
   * Imported series are filed into `collectionName` (reused if it already exists, created
   * otherwise) because under pure collections an unfiled series would be swept by the next thing
   * that touches it. It defaults to "Default" rather than "Library" so a host that migrates without
   * naming one doesn't end up with a collection called "Library" sitting inside a library — which
   * for a freshly migrated shelf lists exactly what the unfiltered view does, and reads as one list
   * rendered twice.
   */
  async importLegacyEntries(
    rows: unknown[],
    collectionName = "Default",
  ): Promise<{ imported: number; skipped: number; collectionId: string }> {
    const collections = await this.store.listCollections();
    let target = collections.find((c) => c.name === collectionName);
    if (!target) {
      const order = collections.reduce((max, c) => Math.max(max, c.order), -1) + 1;
      target = { id: crypto.randomUUID(), name: collectionName, order };
      await this.store.putCollections([...collections, target]);
    }

    const items: CollectionSeriesItem[] = [];
    let skipped = 0;
    for (const row of rows) {
      const parsed = legacyLibraryEntrySchema.safeParse(row);
      if (!parsed.success) {
        skipped++;
        continue;
      }
      const e = parsed.data;
      const id = collectionItemId({ type: "series", bridgeId: e.bridgeId, seriesId: e.seriesId });
      const existing = await this.store.getCollectionItem(id);
      const current = existing?.type === "series" ? existing : undefined;
      // Already collected under the CURRENT model — never overwrite a live record with a legacy one.
      if (current?.knownChapters !== undefined) {
        skipped++;
        continue;
      }
      // A pre-dissolution series item (see `hydrateSeriesItem`) is not a live record: it predates
      // every tracking field below, so skipping it would strand the entry's progress baseline and
      // resume point forever. Upgrade it instead — keeping the memberships and collect time it
      // already carries, which ARE real user data from the newer build.
      const item: CollectionSeriesItem = {
        type: "series",
        id,
        bridgeId: e.bridgeId,
        seriesId: e.seriesId,
        seriesTitle: e.title,
        collectedAt: current?.collectedAt ?? e.addedAt,
        updatedAt: e.updatedAt,
        collectionIds: current?.collectionIds.length ? current.collectionIds : [target.id],
        knownChapters: e.knownChapters,
        ...(e.thumbnailUrl !== undefined && { thumbnailUrl: e.thumbnailUrl }),
        ...(e.author !== undefined && { author: e.author }),
        ...(e.lastReadChapterId !== undefined && { lastReadChapterId: e.lastReadChapterId }),
        ...(e.lastReadChapterName !== undefined && { lastReadChapterName: e.lastReadChapterName }),
        ...(e.lastReadAt !== undefined && { lastReadAt: e.lastReadAt }),
        ...(e.chaptersSyncedAt !== undefined && { chaptersSyncedAt: e.chaptersSyncedAt }),
        ...(e.revision !== undefined && { revision: e.revision }),
        ...(e.seriesGroupId !== undefined && { seriesGroupId: e.seriesGroupId }),
        ...(e.externalIds !== undefined && { externalIds: e.externalIds }),
      };
      items.push(item);
    }
    if (items.length > 0) await this.store.putCollectionItems(items);
    return { imported: items.length, skipped, collectionId: target.id };
  }

  /**
   * Remove a series from the library: drop its item and the documents that only make sense while it
   * is collected.
   *
   * This is what "uncollecting" a series means, and every path that can zero a series item routes
   * here — an explicit delete, emptying its memberships, or deleting its last collection.
   *
   * **Read progress deliberately SURVIVES**, along with tracker links. Since the library dissolved
   * into collections, an ordinary organizing action — deleting a collection — can reach this, and
   * destroying read state as a side effect of tidying shelves is indefensible: it is the one thing
   * here the user cannot get back, while everything else is a cache the next sync refills. Keeping
   * it also means re-collecting a series puts the reader back where they were, which is how Mihon
   * and Suwayomi behave (a non-favourite manga keeps its chapter read state; only an explicit
   * database clean-up reaps it). The cost is orphaned progress documents for series the user never
   * returns to — cheap, inert, and swept deliberately rather than silently (followups §9).
   *
   * What does go: the offline detail and chapter caches (re-fetchable), the activity feed (noise
   * for a series nobody is tracking, and rebuilt by the next `syncChapters`), and the group
   * membership (a member key pointing at no series is broken state, and auto-linking re-forms the
   * group if the series returns).
   */
  async removeSeries(key: string): Promise<void> {
    await this.leaveGroup(key);
    await this.store.deleteCollectionItems([this.seriesItemId(key)]);
    await this.store.deleteActivityForEntry(key);
    await this.store.deleteSeriesDetail(key);
    await this.store.deleteCachedChapters(key);
  }

  /**
   * Delete item records, cascading each series item through {@link removeSeries}.
   *
   * A series item is the only record that owns progress, activity, offline detail, the chapter
   * cache and a group membership, so dropping one by any route has to take those with it. Chapter
   * and page items own nothing, so they are one batched delete. Their records SURVIVE their
   * series being uncollected — a page's membership is its own, not a lease on the series'.
   */
  private async dropItems(items: CollectionItem[]): Promise<void> {
    const plain = items.filter((i) => i.type !== "series");
    if (plain.length > 0) await this.store.deleteCollectionItems(plain.map((i) => i.id));
    for (const item of items) {
      if (item.type === "series") await this.removeSeries(entryKey(item.bridgeId, item.seriesId));
    }
  }

  /** The bytes the library's persisted documents occupy, when the store can measure them. */
  async diskUsage(): Promise<number | undefined> {
    return this.store.diskUsage?.();
  }

  // ── Offline metadata cache ─────────────────────────────────────────────────────
  // The series page's offline data: the full SeriesInfo and the full renderable chapter list,
  // captured from fetches the system makes anyway (collect, browsing, background sync) and served
  // back by the router when the bridge can't answer. See `cachedSeriesDetailSchema`.

  /**
   * Cache the full series detail for offline rendering. No-op unless the series is collected.
   * Preserves the existing cover pointer fields — detail refreshes must never orphan captured covers.
   */
  async cacheSeriesDetail(key: string, info: SeriesInfo): Promise<void> {
    if (!(await this.isCollected(key))) return;
    const existing = await this.store.getSeriesDetail(key);
    const doc: CachedSeriesDetail = { info, cachedAt: this.now() };
    if (existing?.coverFile !== undefined) doc.coverFile = existing.coverFile;
    if (existing?.coverSourceUrl !== undefined) doc.coverSourceUrl = existing.coverSourceUrl;
    await this.store.putSeriesDetail(key, doc);
  }

  /** Record where the host stored this series' cover bytes (and the URL they came from, for the
   *  staleness check). No-op without a cached detail doc. */
  async setCachedCover(key: string, coverFile: string, coverSourceUrl?: string): Promise<void> {
    const doc = await this.store.getSeriesDetail(key);
    if (!doc) return;
    const next: CachedSeriesDetail = { ...doc, coverFile };
    if (coverSourceUrl !== undefined) next.coverSourceUrl = coverSourceUrl;
    await this.store.putSeriesDetail(key, next);
  }

  /**
   * Reconcile the series item's display snapshot (what the library grid/history render) with a
   * fresh, successful `SeriesInfo` — the source is authoritative for its own metadata, so a renamed
   * series or changed cover/author heals on the next browse instead of staying frozen at collect
   * time. New `externalIds` merge in (never removed); `collectedAt`/progress/memberships are
   * untouched. No-op when nothing changed or the series isn't collected.
   */
  async refreshSnapshot(key: string, info: SeriesInfo): Promise<void> {
    const item = await this.getSeriesItem(key);
    if (!item) return;
    let changed = false;
    if (info.title && info.title !== item.seriesTitle) {
      item.seriesTitle = info.title;
      changed = true;
    }
    if (info.thumbnailUrl !== undefined && info.thumbnailUrl !== item.thumbnailUrl) {
      item.thumbnailUrl = info.thumbnailUrl;
      changed = true;
    }
    if (info.author !== undefined && info.author !== item.author) {
      item.author = info.author;
      changed = true;
    }
    if (info.externalIds) {
      for (const [tracker, id] of Object.entries(info.externalIds)) {
        if (item.externalIds?.[tracker] !== id) {
          item.externalIds = { ...item.externalIds, [tracker]: id };
          changed = true;
        }
      }
    }
    if (!changed) return;
    item.updatedAt = this.now();
    await this.putSeriesItem(item);
  }

  /** The cached detail, or undefined (not captured / schema-drifted doc, which is discarded). */
  async getCachedDetail(key: string): Promise<CachedSeriesDetail | undefined> {
    const doc = await this.store.getSeriesDetail(key);
    if (!doc) return undefined;
    const parsed = cachedSeriesDetailSchema.safeParse(doc);
    return parsed.success ? parsed.data : undefined;
  }

  /** The cached chapter list, or undefined (not captured / schema-drifted doc, which is discarded). */
  async getCachedChapters(key: string): Promise<CachedChapters | undefined> {
    const doc = await this.store.getCachedChapters(key);
    if (!doc) return undefined;
    const parsed = cachedChaptersSchema.safeParse(doc);
    return parsed.success ? parsed.data : undefined;
  }

  /** Whether this series is collected — the successor to `isCollected`. */
  async isCollected(key: string): Promise<boolean> {
    return (await this.getSeriesItem(key)) !== undefined;
  }

  /** The collected series record, or undefined. */
  async getSeries(key: string): Promise<CollectionSeriesItem | undefined> {
    return this.getSeriesItem(key);
  }

  /**
   * Query the library: filter by collection/search/read-state and sort, each series carrying a
   * derived `unreadCount`. All options are optional; with none, returns every collected series
   * sorted newest-collected-first.
   */
  async getLibrary(opts: LibraryQuery = {}): Promise<CollectionSeriesItemView[]> {
    let filtered = await this.listSeriesItems();

    // Memberships live on the item itself now — the collection filter is a field test, not a join.
    const collectionIds = opts.collections ?? (opts.collection !== undefined ? [opts.collection] : undefined);
    if (opts.uncollected) {
      filtered = filtered.filter((i) => i.collectionIds.length === 0);
    } else if (collectionIds && collectionIds.length > 0) {
      filtered = filtered.filter((i) => i.collectionIds.some((id) => collectionIds.includes(id)));
    }

    // Free-text search: case-insensitive substring over title + author.
    const q = opts.q?.trim().toLowerCase();
    if (q) {
      filtered = filtered.filter(
        (i) => i.seriesTitle.toLowerCase().includes(q) || (i.author?.toLowerCase().includes(q) ?? false),
      );
    }

    let views = await Promise.all(filtered.map((i) => this.toView(i)));
    if (opts.unreadOnly) views = views.filter((v) => v.unreadCount > 0);

    // Sort. Title defaults to ascending (A–Z); the recency/count keys default to descending
    // (newest / most-unread first) since that's the useful direction.
    const sort = opts.sort ?? "added";
    const sign = (opts.dir ?? (sort === "title" ? "asc" : "desc")) === "asc" ? 1 : -1;
    views.sort((a, b) => sign * compareSeries(a, b, sort));
    return views;
  }

  private async toView(item: CollectionSeriesItem): Promise<CollectionSeriesItemView> {
    const progress = await this.store.listProgress(entryKey(item.bridgeId, item.seriesId));
    return { ...item, unreadCount: unreadLogicalCount(item, progress) };
  }

  // ── New-chapter detection ────────────────────────────────────────────────────

  /**
   * Reconcile a freshly-fetched chapter list against what we last knew. Returns the chapters that
   * are new since the previous sync (empty on the first sync — there's no baseline to diff against).
   */
  async syncChapters(key: string, chapters: Chapter[], revision?: SeriesRevision): Promise<{ added: Chapter[] }> {
    const entry = await this.requireSeries(key);
    // Diff by logical chapter `(number, language)` — a fresh scanlation-group copy of a chapter we
    // already know is NOT a new chapter.
    const known = new Set(entry.knownChapters.map((c) => logicalChapterKey(c, c.id)));
    const firstSync = entry.chaptersSyncedAt === undefined;
    // A logical chapter is "added" once: dedupe both against what we knew AND within this batch, so
    // two scanlation-group copies of the same new chapter yield a single new-chapter event.
    const seenLogical = new Set<string>();
    const added = firstSync
      ? []
      : chapters.filter((c) => {
          const lk = logicalChapterKey(c, c.id);
          if (known.has(lk) || seenLogical.has(lk)) return false;
          seenLogical.add(lk);
          // A chapter only counts as "new" if it was published after the series was collected.
          // The `firstSync` baseline assumes the very first list we see is complete; in practice it
          // often isn't (favorites import adds without syncing, a paginated/empty first fetch), and a
          // later fuller sync would otherwise flag the entire back-catalogue as new. Gating on publish
          // time keeps old chapters out of the feed regardless of baseline completeness. Chapters with
          // no `publishedAt` fall back to the diff alone (best effort for bridges that omit dates).
          if (c.publishedAt !== undefined && c.publishedAt <= entry.collectedAt) return false;
          return true;
        });
    // Re-anchor this series' chapter/page favorites BEFORE the baseline is overwritten — the
    // vanished-chapter remap is built from the previous `knownChapters`. Skipped on the first sync
    // (no baseline means no way to tell a re-upload from a first look).
    if (!firstSync) {
      await this.reanchorChapterItems(entry.bridgeId, entry.seriesId, entry.knownChapters ?? [], chapters);
    }

    const t = this.now();
    entry.knownChapters = chapters.map((c): KnownChapter => {
      const k: KnownChapter = { id: c.id };
      if (c.number !== undefined) k.number = c.number;
      if (c.languageCode !== undefined) k.languageCode = c.languageCode;
      return k;
    });
    entry.chaptersSyncedAt = t;
    // Record the fingerprint this list came with, so the next batch check has a baseline to compare
    // against. Written only alongside a real chapter list: a revision without the chapters it
    // describes would let a later check match and skip a fetch that never actually happened.
    if (revision !== undefined) entry.revision = revision;
    else delete entry.revision;
    await this.putSeriesItem(entry);

    // Write the full renderable list through to the offline cache — one sync now produces both
    // artifacts (unread reconciliation above + the series page's offline chapter list).
    await this.store.putCachedChapters(key, { chapters, cachedAt: t });

    // Record each newly-detected chapter as an activity event (the "new chapters" feed). Snapshots
    // the series display fields so the feed renders offline / after the bridge is removed.
    for (const c of added) {
      const item: ActivityItem = {
        bridgeId: entry.bridgeId,
        seriesId: entry.seriesId,
        chapterId: c.id,
        title: entry.seriesTitle,
        detectedAt: t,
      };
      if (entry.thumbnailUrl !== undefined) item.thumbnailUrl = entry.thumbnailUrl;
      if (c.name !== undefined) item.chapterName = c.name;
      if (c.number !== undefined) item.number = c.number;
      if (c.languageCode !== undefined) item.languageCode = c.languageCode;
      if (c.publishedAt !== undefined) item.publishedAt = c.publishedAt;
      await this.store.putActivity(item);
    }

    return { added };
  }

  /**
   * Record that a batch update check answered "nothing changed" for this entry: refresh
   * `chaptersSyncedAt` without touching `knownChapters`, the cached list, or the activity feed.
   *
   * The timestamp bump is the point. `backgroundSync` orders candidates stalest-first and uses that
   * ordering as its incremental cursor, so an entry that was checked but not fetched still has to
   * move to the back of the queue — otherwise it stays permanently stale and every run spends its
   * budget re-checking the same entries while newer ones starve.
   */
  async markChaptersUnchanged(key: string, revision: SeriesRevision): Promise<void> {
    const entry = await this.requireSeries(key);
    entry.chaptersSyncedAt = this.now();
    entry.revision = revision;
    await this.putSeriesItem(entry);
  }

  // ── Read state ────────────────────────────────────────────────────────────────

  async markRead(key: string, chapterId: string, read: boolean, chapterName?: string, number?: number): Promise<void> {
    const patch: Partial<ChapterProgress> = { read };
    if (number !== undefined) patch.number = number;
    await this.writeProgress(key, chapterId, patch, chapterName);
  }

  /**
   * Mark every chapter up to and including `chapterId` as read, in reading order (ascending chapter
   * number when available, else the order chapters were supplied in). The common "I've read up to
   * here" action.
   */
  async markReadUpTo(key: string, chapters: Chapter[], chapterId: string): Promise<void> {
    const ordered = orderForReading(chapters);
    const cut = ordered.findIndex((c) => c.id === chapterId);
    if (cut === -1) throw new Error(`chapter not found in list: ${chapterId}`);
    const target = ordered[cut]!;
    // Stay within the target chapter's language — clicking "read to here" on an EN row must not mark
    // a different-language copy read. Within that language, mark every copy up to and including the
    // cut (by chapter number when known, else reading-order position), covering all scanlation groups.
    for (let i = 0; i < ordered.length; i++) {
      const c = ordered[i]!;
      if (c.languageCode !== target.languageCode) continue;
      const within =
        target.number !== undefined && c.number !== undefined ? c.number <= target.number : i <= cut;
      if (!within) continue;
      const patch: Partial<ChapterProgress> = { read: true };
      if (c.number !== undefined) patch.number = c.number;
      await this.writeProgress(key, c.id, patch, c.name);
    }
  }

  /**
   * Record a reading position within a chapter. Auto-marks the chapter read once the last page is
   * reached (`lastPage >= pageCount - 1`).
   */
  async setProgress(
    key: string,
    chapterId: string,
    lastPage: number,
    pageCount?: number,
    chapterName?: string,
    number?: number,
  ): Promise<void> {
    const reachedEnd = pageCount !== undefined && pageCount > 0 && lastPage >= pageCount - 1;
    const patch: Partial<ChapterProgress> = { lastPage };
    if (pageCount !== undefined) patch.pageCount = pageCount;
    if (reachedEnd) patch.read = true;
    if (number !== undefined) patch.number = number;
    await this.writeProgress(key, chapterId, patch, chapterName);
  }

  /**
   * Mark chapters read from an EXTERNAL source (a bridge or tracker pull). Union semantics: only
   * ever sets the read flag — it never un-reads. Unlike {@link markRead} it does NOT advance the
   * resume pointer or `lastReadAt`: those reflect the user's own local reading, so a sync that
   * pulls in a fully-read series cannot hijack where the user is or flood their history. Records
   * each chapter's `number` when supplied so later tracker pushes can compute the high-water mark.
   */
  async reconcileRead(
    key: string,
    chapters: Array<{ chapterId: string; number?: number }>,
  ): Promise<{ marked: number }> {
    await this.requireSeries(key);
    const read = new Set((await this.store.listProgress(key)).filter((p) => p.read).map((p) => p.chapterId));
    let marked = 0;
    for (const { chapterId, number } of chapters) {
      if (read.has(chapterId)) continue; // union — never downgrade an already-read chapter
      const patch: Partial<ChapterProgress> = { read: true };
      if (number !== undefined) patch.number = number;
      await this.writeProgress(key, chapterId, patch, undefined, { touchResume: false });
      marked++;
    }
    return { marked };
  }

  /**
   * The highest chapter `number` among read chapters — the value trackers expect as `chaptersRead`.
   * Falls back to the count of read chapters when no numbers are recorded, so a tracker still
   * receives a monotonic, non-zero value.
   */
  async maxReadChapterNumber(key: string): Promise<number> {
    const read = (await this.store.listProgress(key)).filter((p) => p.read);
    const numbers = read.map((p) => p.number).filter((n): n is number => n !== undefined);
    return numbers.length > 0 ? Math.max(...numbers) : read.length;
  }

  /**
   * Has the user finished this series — every known chapter read, and the series itself over?
   * The local half of deciding whether to tell a tracker `status: "completed"`.
   *
   * Deliberately counts CHAPTERS, never chapter numbers: a source whose numbering stops below the
   * tracker's chapter count (BLAME! numbers its logs 1–65 plus extras 3.5 and 7.5 — 67 chapters,
   * highest number 65, against AniList's count of 66) is finished all the same, and comparing
   * numbers would never say so.
   *
   * `fullyRead` alone is not enough to report completion: catching up on an ongoing series is not
   * finishing it, hence `seriesFinished`. And an entry with no synced chapter list trivially has
   * "0 unread" — a favourites import seeds exactly that — so a synced, non-empty `knownChapters` is
   * required before `fullyRead` can be true at all.
   */
  async getSeriesCompletion(key: string): Promise<SeriesCompletion> {
    const seriesStatus = (await this.getCachedDetail(key))?.info.status ?? "unknown";
    // "hiatus" can resume, and "unknown" is what bridges that don't report status map to — neither
    // is evidence the series is over. Those entries complete via the tracker's own chapter count.
    const seriesFinished = seriesStatus === "completed" || seriesStatus === "cancelled";
    const entry = await this.getSeriesItem(key);
    if (!entry || entry.chaptersSyncedAt === undefined || (entry.knownChapters ?? []).length === 0) {
      return { fullyRead: false, seriesStatus, seriesFinished };
    }
    const progress = await this.store.listProgress(key);
    return { fullyRead: unreadLogicalCount(entry, progress) === 0, seriesStatus, seriesFinished };
  }

  async getProgress(key: string): Promise<ChapterProgress[]> {
    return this.store.listProgress(key);
  }

  /**
   * Drop every chapter's read state for a series, and the resume point with it.
   *
   * The deliberate counterpart to `removeSeries` keeping progress: destroying read state is now
   * something the user asks for explicitly, never a side effect of uncollecting or of tidying
   * collections. It is also how progress left behind by an uncollected series gets reclaimed, so it
   * does NOT require the series to still be collected — an orphan is exactly what it must be able
   * to reach.
   */
  async resetProgress(key: string): Promise<void> {
    await this.store.deleteProgressForEntry(key);
    const item = await this.getSeriesItem(key);
    if (!item) return; // orphaned progress — nothing left to clear the resume point on
    const { lastReadAt: _a, lastReadChapterId: _b, lastReadChapterName: _c, ...rest } = item;
    await this.putSeriesItem({ ...rest, updatedAt: this.now() });
  }

  /** Where to resume: the last-read chapter and the page within it. */
  async getResume(key: string): Promise<ResumePoint | undefined> {
    const entry = await this.getSeriesItem(key);
    if (entry?.lastReadChapterId) {
      const progress = await this.store.listProgress(key);
      const p = progress.find((x) => x.chapterId === entry.lastReadChapterId);
      return { chapterId: entry.lastReadChapterId, lastPage: p?.lastPage ?? 0 };
    }
    // Not in the library — resume from the reading log, which tracks the page for non-library reads.
    const { bridgeId, seriesId } = parseEntryKey(key);
    const log = (await this.store.listReadingLog()).find(
      (i) => i.bridgeId === bridgeId && i.seriesId === seriesId,
    );
    if (log?.lastReadChapterId) return { chapterId: log.lastReadChapterId, lastPage: log.lastPage ?? 0 };
    return undefined;
  }

  /** Recently-read series, newest first (one row per series for v1). */
  async getHistory(limit = 50): Promise<HistoryItem[]> {
    const entries = await this.listSeriesItems();
    const libraryItems = await Promise.all(
      entries
        .filter((e): e is CollectionSeriesItem & { lastReadAt: number } => e.lastReadAt !== undefined)
        .map(async (e): Promise<HistoryItem> => {
          // Surface the resume page/count for the last-read chapter so history renders "page X / N".
          const p = e.lastReadChapterId === undefined
            ? undefined
            : (await this.store.listProgress(entryKey(e.bridgeId, e.seriesId)))
                .find((x) => x.chapterId === e.lastReadChapterId);
          return {
            bridgeId: e.bridgeId,
            seriesId: e.seriesId,
            title: e.seriesTitle,
            lastReadAt: e.lastReadAt,
            ...(e.thumbnailUrl !== undefined && { thumbnailUrl: e.thumbnailUrl }),
            ...(e.lastReadChapterId !== undefined && { lastReadChapterId: e.lastReadChapterId }),
            ...(e.lastReadChapterName !== undefined && { lastReadChapterName: e.lastReadChapterName }),
            ...(p?.lastPage !== undefined && { lastPage: p.lastPage }),
            ...(p?.pageCount !== undefined && { pageCount: p.pageCount }),
          };
        }),
    );

    const libraryKeys = new Set(libraryItems.map((i) => `${i.bridgeId}:${i.seriesId}`));
    const logItems = (await this.store.listReadingLog()).filter(
      (i) => !libraryKeys.has(`${i.bridgeId}:${i.seriesId}`),
    );

    const merged = [...libraryItems, ...logItems];
    // Drop reads from bridges whose history tracking is turned off (covers both library and log rows).
    const muted = await this.historyDisabledBridges(merged.map((i) => i.bridgeId));
    return merged
      .filter((i) => !muted.has(i.bridgeId))
      .sort((a, b) => b.lastReadAt - a.lastReadAt)
      .slice(0, limit);
  }

  /** The subset of the given bridge ids whose `historyDisabled` pref is set. */
  private async historyDisabledBridges(bridgeIds: string[]): Promise<Set<string>> {
    const muted = new Set<string>();
    for (const id of new Set(bridgeIds)) {
      if ((await this.getBridgePrefs(id)).historyDisabled) muted.add(id);
    }
    return muted;
  }

  /** Record a non-library read. Ignored if the series is already in the library (setProgress handles those). */
  async recordRead(item: HistoryItem): Promise<void> {
    const existing = await this.getSeriesItem(entryKey(item.bridgeId, item.seriesId));
    if (existing) return;
    if ((await this.getBridgePrefs(item.bridgeId)).historyDisabled) return;
    await this.store.upsertReadingLog(item);
  }

  /** Remove a series from reading history. For library entries, clears last-read fields; for log entries, deletes the record. */
  async clearHistoryEntry(bridgeId: string, seriesId: string): Promise<void> {
    const key = entryKey(bridgeId, seriesId);
    const existing = await this.getSeriesItem(key);
    if (existing) {
      const { lastReadAt: _a, lastReadChapterId: _b, lastReadChapterName: _c, ...rest } = existing;
      await this.putSeriesItem({ ...rest, updatedAt: this.now() });
    } else {
      await this.store.deleteReadingLog(bridgeId, seriesId);
    }
  }

  // ── Activity feed (newly-detected chapters) ─────────────────────────────────────

  /**
   * The new-chapter feed, newest first. Each item's `read` flag is derived live from chapter
   * progress, so an item drops out of the unread count the moment the user reads its chapter.
   * `since` keeps only items detected strictly after that time — the badge watermark filter.
   */
  async getActivity(opts: { limit?: number; unreadOnly?: boolean; since?: number } = {}): Promise<ActivityItemView[]> {
    const items = (await this.store.listActivity()).sort((a, b) => b.detectedAt - a.detectedAt);
    const readByKey = new Map<string, Set<string>>();
    const readSet = async (key: string): Promise<Set<string>> => {
      let set = readByKey.get(key);
      if (!set) {
        const progress = await this.store.listProgress(key);
        // Logical read set: an item is read once any scanlation-group copy of its `(number, language)` is read.
        set = new Set(progress.filter((p) => p.read).map((p) => logicalChapterKey(p, p.chapterId)));
        readByKey.set(key, set);
      }
      return set;
    };
    const views: ActivityItemView[] = [];
    for (const item of items) {
      // Sorted newest-first, so the first at-or-before-`since` item ends the scan (large-feed fast path).
      if (opts.since !== undefined && item.detectedAt <= opts.since) break;
      const read = (await readSet(entryKey(item.bridgeId, item.seriesId))).has(logicalChapterKey(item, item.chapterId));
      if (opts.unreadOnly && read) continue;
      views.push({ ...item, read });
      if (opts.limit !== undefined && views.length >= opts.limit) break;
    }
    return views;
  }

  /**
   * Count of feed items whose chapter the user hasn't read yet — the "new" badge value.
   * `since` restricts the count to items detected after that time (the client's seen watermark).
   */
  async unreadActivityCount(since?: number): Promise<number> {
    return (await this.getActivity({ unreadOnly: true, ...(since !== undefined && { since }) })).length;
  }

  /** Empty the feed (user "clear" action). */
  async clearActivity(): Promise<void> {
    await this.store.clearActivity();
  }

  /** Drop every feed entry for ONE library entry — the Activity row's swipe-away, which coalesces a
   *  series' new chapters into a single row and clears them together. */
  async clearActivityForEntry(bridgeId: string, seriesId: string): Promise<void> {
    await this.store.deleteActivityForEntry(entryKey(bridgeId, seriesId));
  }

  /**
   * Mark every feed chapter for ONE library entry as read — the Activity row's "mark read" action.
   * Goes through {@link reconcileRead} (union semantics, `touchResume: false`): it never un-reads,
   * and dismissing a feed row is not reading, so the resume pointer and history stay where the
   * user's own reading left them. The items stay in the feed, now `read` (the row dims), and drop
   * out of the unread badge count.
   */
  async markActivityRead(bridgeId: string, seriesId: string): Promise<{ marked: number }> {
    const key = entryKey(bridgeId, seriesId);
    const items = (await this.store.listActivity()).filter(
      (a) => a.bridgeId === bridgeId && a.seriesId === seriesId,
    );
    return this.reconcileRead(
      key,
      items.map((a) => ({ chapterId: a.chapterId, ...(a.number !== undefined && { number: a.number }) })),
    );
  }

  /**
   * Cap the feed at the newest `keepNewest` items so it can't grow unbounded — every sync
   * appends detections and nothing else ever removes them. Returns how many were dropped.
   */
  async pruneActivity(keepNewest = 500): Promise<number> {
    const items = await this.store.listActivity();
    if (items.length <= keepNewest) return 0;
    const keep = items.sort((a, b) => b.detectedAt - a.detectedAt).slice(0, keepNewest);
    await this.store.clearActivity();
    for (const item of keep) await this.store.putActivity(item);
    return items.length - keepNewest;
  }

  // ── Collection items (series / chapter / page) ───────────────────────────────
  // PURE COLLECTIONS: an item exists to be a member of collections, and one whose memberships reach
  // zero is removed (a freshly-created item is allowed to be transiently uncollected until its
  // first filing — the two-PUT flow depends on that). Local user data, independent of the library:
  // a page can be collected from a series that was never added, and removing a series from the
  // library leaves its items alone. The word "favorites" is deliberately absent from this surface —
  // it belongs to the bridge-account capability behind `/bridges/{id}/favorites`.
  //
  // Favoriting MERGES over the stored record — a supplied field wins as the fresher value, an
  // OMITTED one is preserved. Never a rebuild from the snapshot alone, because a partial PUT is a
  // legitimate client pattern: comical-app favorites a page the moment the user taps and follows up
  // with a second PUT once it has the `contentHash` (hashing a ~1MB page on Hermes' JS crypto shim
  // is far too slow to block the tap). `collectedAt` and `collectionIds` likewise carry over; the
  // one field NOT carried is `stale` — the user is looking at the target as they tap, so its
  // coordinates are current by definition.

  async collectChapter(coord: ChapterItemCoord, snap: ChapterItemSnapshot): Promise<CollectionChapterItem> {
    const id = collectionItemId({ type: "chapter", ...coord });
    const prev = await this.store.getCollectionItem(id);
    const existing = prev?.type === "chapter" ? prev : undefined;
    const chapterName = snap.chapterName ?? existing?.chapterName;
    const number = snap.number ?? existing?.number;
    const languageCode = snap.languageCode ?? existing?.languageCode;
    const item: CollectionChapterItem = {
      type: "chapter",
      ...coord,
      id,
      collectedAt: existing?.collectedAt ?? this.now(),
      collectionIds: existing?.collectionIds ?? [],
      seriesTitle: snap.seriesTitle,
      ...(chapterName !== undefined && { chapterName }),
      ...(number !== undefined && { number }),
      ...(languageCode !== undefined && { languageCode }),
    };
    await this.store.putCollectionItems([item]);
    return item;
  }

  async collectPage(coord: PageItemCoord, snap: PageItemSnapshot): Promise<CollectionPageItem> {
    const id = collectionItemId({ type: "page", ...coord });
    const prev = await this.store.getCollectionItem(id);
    const existing = prev?.type === "page" ? prev : undefined;
    const chapterName = snap.chapterName ?? existing?.chapterName;
    const pageCount = snap.pageCount ?? existing?.pageCount;
    const sourceUrl = snap.sourceUrl ?? existing?.sourceUrl;
    const contentHash = snap.contentHash ?? existing?.contentHash;
    const item: CollectionPageItem = {
      type: "page",
      ...coord,
      id,
      collectedAt: existing?.collectedAt ?? this.now(),
      collectionIds: existing?.collectionIds ?? [],
      seriesTitle: snap.seriesTitle,
      ...(chapterName !== undefined && { chapterName }),
      ...(pageCount !== undefined && { pageCount }),
      ...(sourceUrl !== undefined && { sourceUrl }),
      ...(contentHash !== undefined && { contentHash }),
    };
    await this.store.putCollectionItems([item]);
    return item;
  }

  /** Unfavorite by typed coordinates. Returns the removed record, or undefined if it was not
   *  favorited. Idempotent — a double-tap must not throw. */
  async uncollectItem(coord: CollectionItemCoord): Promise<CollectionItem | undefined> {
    return this.deleteCollectionItem(collectionItemId(coord));
  }

  /** Uncollect by derived id. Returns the removed record, or undefined if there was none. */
  async deleteCollectionItem(id: string): Promise<CollectionItem | undefined> {
    const existing = await this.store.getCollectionItem(id);
    if (!existing) return undefined;
    await this.dropItems([existing]);
    return existing;
  }

  async getCollectionItem(id: string): Promise<CollectionItem | undefined> {
    return this.store.getCollectionItem(id);
  }

  /** Filter + sort the favorites. All of it happens HERE, not in a store or a client, so every host
   *  and every platform browses identically — the same split as `getLibrary`. */
  async getCollectionItems(query: CollectionItemsQuery = {}): Promise<CollectionItem[]> {
    // Push series (and type) filters down to the store: on a per-series grid this is the
    // difference between loading one series' favorites and every favorite the user has.
    const scoped = query.series ? parseEntryKey(query.series) : undefined;
    let items = await this.store.listCollectionItems({
      ...(query.type && { type: query.type }),
      ...(scoped && { bridgeId: scoped.bridgeId, seriesId: scoped.seriesId }),
    });
    if (query.collection) {
      items = items.filter((i) => i.collectionIds.includes(query.collection!));
    }
    if (query.q) {
      const q = query.q.toLowerCase();
      items = items.filter(
        (i) =>
          i.seriesTitle.toLowerCase().includes(q) ||
          (i.type !== "series" && (i.chapterName?.toLowerCase().includes(q) ?? false)),
      );
    }
    // Same shape as getLibrary: the comparator is ascending and one sign applies the direction.
    // `added` defaults to descending (newest first); the title-led keys default to ascending.
    const sort = query.sort ?? "added";
    const sign = (query.dir ?? (sort === "added" ? "desc" : "asc")) === "asc" ? 1 : -1;
    return items.sort((a, b) => sign * compareCollectionItems(a, b, sort));
  }

  /**
   * The favorited page indices for ONE chapter, ascending.
   *
   * This is the reader's shape: it loads the set once when the chapter opens and keeps the favorite
   * button correct across every page turn with zero further requests. A per-page "is this favorited"
   * check would fire once per turn, which is why none exists.
   *
   * Stale favorites are excluded — an index we know no longer points at the saved page must not
   * light up the button or drive navigation.
   */
  async getCollectedPageIndices(bridgeId: string, seriesId: string, chapterId: string): Promise<number[]> {
    return (await this.store.listCollectionItems({ type: "page", bridgeId, seriesId, chapterId }))
      .filter((i): i is CollectionPageItem => i.type === "page" && !i.stale)
      .map((i) => i.pageIndex)
      .sort((a, b) => a - b);
  }

  /**
   * Re-anchor a chapter's page favorites against a freshly-fetched page list, and return the
   * indices the reader should treat as favorited.
   *
   * WHY this exists: a page favorite is located by `(bridge, series, chapter, pageIndex)` and
   * sources mutate chapters underneath it — a page inserted at the front shifts every index after
   * it, and a re-upload can replace the chapter wholesale. Without reconciliation those favorites
   * silently point at the wrong page. This is the favorites-side counterpart of `syncChapters`: the
   * caller already holds the fresh list, so repair costs no extra fetch.
   *
   * COST: one scoped store read plus at most two batched writes, for the ONE chapter being opened.
   * It never walks a series' other chapters and never fetches a page image — `pages` is the list the
   * reader already fetched to render this chapter, so a huge series costs no more than a small one.
   *
   * Matching is deliberately ASYMMETRIC, because both signals are unreliable in opposite ways:
   * `contentHash` is sparse (a client can only hash pages it has rendered — see `ChapterPageRef`)
   * and `sourceUrl` rotates on sources that sign or expire URLs. So a miss of either kind proves
   * nothing and only HITS are acted on, which is what makes each signal purely additive rather than
   * a new way to get it wrong. The ladder: hash hit, then URL hit, then the one informative miss (a
   * hash at the favorite's own index that differs — proof the saved page is not there), then the
   * page count. A favorite that ends up unplaceable is marked `stale`, never deleted.
   *
   * Nothing here ever asks the caller to hash a whole chapter: that would mean downloading it just
   * to open it. Callers pass whatever hashes they happen to hold, and favorites ADOPT hashes they
   * are handed, so coverage grows as the user reads rather than through any extra fetch.
   *
   * Repairing an index RE-KEYS the record, because the id is derived from the coordinates. Callers
   * holding an id from before a reconcile must refresh.
   *
   * @param pages The chapter's pages in order — position IS the page index. A ref with no `url`
   *              stands in for a page whose URL the caller doesn't know; it still counts toward the
   *              length, which is the fallback signal.
   */
  async reconcileChapterPages(
    bridgeId: string,
    seriesId: string,
    chapterId: string,
    pages: ChapterPageRef[],
  ): Promise<{ indices: number[]; repaired: number; stale: number }> {
    const mine = (await this.store.listCollectionItems({ type: "page", bridgeId, seriesId, chapterId })).filter(
      (i): i is CollectionPageItem => i.type === "page",
    );
    // An empty list is far likelier a failed fetch than a chapter that genuinely lost every page.
    // Treating it as authoritative would mark the user's whole chapter stale, so it's a no-op.
    if (pages.length === 0 || mine.length === 0) {
      return {
        indices: await this.getCollectedPageIndices(bridgeId, seriesId, chapterId),
        repaired: 0,
        stale: mine.filter((i) => i.stale).length,
      };
    }

    // Two O(pages) indexes, then every favorite resolves by lookup — no per-favorite scan of the
    // list. First occurrence wins, so a chapter that repeats a page resolves deterministically.
    const byHash = new Map<string, number>();
    const byUrl = new Map<string, number>();
    pages.forEach((page, i) => {
      if (page.contentHash && !byHash.has(page.contentHash)) byHash.set(page.contentHash, i);
      if (page.url && !byUrl.has(page.url)) byUrl.set(page.url, i);
    });

    /**
     * Where this favorite's page lives in the fresh list, or undefined if it's gone.
     *
     * Ordered so each signal can only ever HELP. That is forced by both inputs being unreliable in
     * opposite ways: hashes are sparse (a client only hashes what it rendered), and URLs rotate on
     * plenty of sources. So a miss of either kind is not evidence, and only hits are acted on —
     * which is what makes adding hashes strictly an improvement rather than a new way to be wrong.
     */
    const locate = (fav: CollectionPageItem): number | undefined => {
      // 1. A hash HIT is the strongest evidence there is: same bytes, wherever they now sit.
      //    Survives URL rot and a chapter re-uploaded under a new id.
      if (fav.contentHash) {
        const at = byHash.get(fav.contentHash);
        if (at !== undefined) return at;
      }
      // 2. A URL HIT is authoritative too, and costs nothing to check.
      if (fav.sourceUrl) {
        const at = byUrl.get(fav.sourceUrl);
        if (at !== undefined) return at;
      }
      // 3. Negative proof, the one case a miss DOES tell us something: the caller hashed this
      //    favorite's own index and got something else. The saved page is provably not there, and
      //    steps 1-2 already failed to find it elsewhere. This is what catches a same-length
      //    re-upload — the case the page-count fallback below is blind to.
      const here = pages[fav.pageIndex]?.contentHash;
      if (fav.contentHash && here && here !== fav.contentHash) return undefined;
      // 4. Nothing conclusive. Fall back to the signal that survives both rotation and sparseness:
      //    the page count. Unchanged means assume unchanged; changed means something really did
      //    happen and we genuinely cannot place this page.
      if (fav.pageCount !== undefined && fav.pageCount !== pages.length) return undefined;
      return fav.pageIndex < pages.length ? fav.pageIndex : undefined;
    };

    let repaired = 0;
    const next = new Map<string, CollectionPageItem>();
    for (const fav of mine) {
      const at = locate(fav);
      if (at === undefined) {
        this.landItem(next, { ...fav, pageCount: pages.length, stale: true });
        continue;
      }
      if (at !== fav.pageIndex) repaired++;
      const coord = { bridgeId, seriesId, chapterId, pageIndex: at };
      const healed: CollectionPageItem = {
        ...fav,
        ...coord,
        id: collectionItemId({ type: "page", ...coord }),
        pageCount: pages.length,
        // Adopt whatever the fresh list knows. The URL keeps the cheap signal current; a hash we
        // didn't have upgrades this favorite permanently, so the more of a chapter the user
        // actually reads, the more of it becomes rot-proof — no extra fetch, ever.
        ...(pages[at]?.url ? { sourceUrl: pages[at].url } : {}),
        ...(fav.contentHash === undefined && pages[at]?.contentHash
          ? { contentHash: pages[at].contentHash }
          : {}),
      };
      delete healed.stale; // located again — a source can revert a bad re-upload
      this.landItem(next, healed);
    }

    // Two batched writes for the whole chapter, however many favorites it holds: a store rewrites
    // its favorites document per call, so a write per record would re-serialize every favorite the
    // user has, once per record. Re-keying can free an id (page 3 → 4) — drop only ids nothing
    // landed on.
    await this.store.deleteCollectionItems(mine.filter((f) => !next.has(f.id)).map((f) => f.id));
    await this.store.putCollectionItems([...next.values()]);

    return {
      indices: [...next.values()].filter((i) => !i.stale).map((i) => i.pageIndex).sort((a, b) => a - b),
      repaired,
      stale: [...next.values()].filter((i) => i.stale).length,
    };
  }

  /** Merge two records of the same item that relocated onto one target: keep the earlier
   *  collectedAt and the union of collections, so a merge never loses user intent. */
  private mergeItemRecords<T extends CollectionItem>(a: T, b: T): T {
    const merged: T = {
      ...a,
      ...b,
      collectedAt: Math.min(a.collectedAt, b.collectedAt),
      collectionIds: [...new Set([...a.collectionIds, ...b.collectionIds])],
    };
    // Set explicitly, never by spread: a healed record carries no `stale` key at all, which would
    // otherwise let the other side's `stale: true` survive the merge.
    if (a.stale === true && b.stale === true) merged.stale = true;
    else delete merged.stale;
    return merged;
  }

  /** Land a re-anchored record, merging if two of them relocated onto the same target. */
  private landItem<T extends CollectionItem>(into: Map<string, T>, item: T): void {
    const existing = into.get(item.id);
    into.set(item.id, existing ? this.mergeItemRecords(existing, item) : item);
  }

  /**
   * Re-anchor this series' CHAPTER and PAGE favorites against a fresh chapter list — the chapter
   * counterpart of `reconcileChapterPages`, run for free inside `syncChapters` (which already
   * receives that list for every library series; favorites on non-library series never sync and so
   * have no drift detection — accepted).
   *
   * Chapters have ids, not indices, so there is no index repair: a favorite whose `chapterId` is
   * still present is verified (and un-staled). A vanished id is re-anchored by LOGICAL chapter
   * `(number, languageCode)` — the same collapse `knownChapters` uses — which is what heals a
   * chapter re-uploaded under a new id. The remap is built from the entry's previous
   * `knownChapters`, so page favorites in a re-uploaded chapter heal too, even with no chapter
   * item present. Anything unmatchable is marked `stale`, never deleted.
   */
  private async reanchorChapterItems(
    bridgeId: string,
    seriesId: string,
    previouslyKnown: KnownChapter[],
    chapters: Chapter[],
  ): Promise<void> {
    if (chapters.length === 0) return; // failed-fetch guard, same as the page reconcile
    const items = (await this.store.listCollectionItems({ bridgeId, seriesId })).filter(
      (i): i is CollectionChapterItem | CollectionPageItem => i.type !== "series",
    );
    if (items.length === 0) return;

    const freshIds = new Set(chapters.map((c) => c.id));
    const logicalKey = (number: number, languageCode?: string) => `${number}:${languageCode ?? ""}`;
    const freshByLogical = new Map<string, Chapter>();
    for (const c of chapters) {
      if (c.number === undefined) continue;
      const lk = logicalKey(c.number, c.languageCode);
      if (!freshByLogical.has(lk)) freshByLogical.set(lk, c);
    }
    // Vanished old chapter id → its logical replacement in the fresh list.
    const remap = new Map<string, Chapter>();
    for (const k of previouslyKnown) {
      if (freshIds.has(k.id) || k.number === undefined) continue;
      const match = freshByLogical.get(logicalKey(k.number, k.languageCode));
      if (match) remap.set(k.id, match);
    }

    const byId = new Map(items.map((i) => [i.id, i]));
    const next = new Map<string, CollectionChapterItem | CollectionPageItem>();
    const dropped: string[] = [];
    for (const item of items) {
      if (freshIds.has(item.chapterId)) {
        // Target verified. Un-stale if a previous sync had lost it (a source reverting).
        if (item.stale) {
          const healed = { ...item };
          delete healed.stale;
          this.landItem(next, healed);
        }
        continue;
      }
      // A chapter item favorited before any sync baseline can still self-anchor by its own snapshot.
      const target =
        remap.get(item.chapterId) ??
        (item.type === "chapter" && item.number !== undefined
          ? freshByLogical.get(logicalKey(item.number, item.languageCode))
          : undefined);
      if (!target) {
        if (!item.stale) this.landItem(next, { ...item, stale: true });
        continue;
      }
      dropped.push(item.id);
      const rekeyed: CollectionChapterItem | CollectionPageItem =
        item.type === "chapter"
          ? {
              ...item,
              chapterId: target.id,
              id: collectionItemId({ type: "chapter", bridgeId, seriesId, chapterId: target.id }),
              ...(target.name !== undefined && { chapterName: target.name }),
            }
          : {
              ...item,
              chapterId: target.id,
              id: collectionItemId({ type: "page", bridgeId, seriesId, chapterId: target.id, pageIndex: item.pageIndex }),
            };
      delete rekeyed.stale;
      // A re-key can land on coordinates the user favorited separately — merge, never clobber.
      const collide = next.get(rekeyed.id) ?? (byId.get(rekeyed.id) as typeof rekeyed | undefined);
      this.landItem(next, collide && !next.has(rekeyed.id) ? this.mergeItemRecords(collide, rekeyed) : rekeyed);
    }

    await this.store.deleteCollectionItems(dropped.filter((id) => !next.has(id)));
    await this.store.putCollectionItems([...next.values()]);
  }

  /**
   * Replace an item's collection memberships. Unknown collection ids are dropped.
   *
   * PURE COLLECTIONS: an item is its memberships. Emptying them (an empty array, or one that
   * resolves empty after unknown ids are dropped) REMOVES the item — returns undefined — rather
   * than leaving an uncollected record behind. There is no bare-heart exception for any type.
   */
  async setItemCollections(id: string, collectionIds: string[]): Promise<CollectionItem | undefined> {
    const item = await this.store.getCollectionItem(id);
    if (!item) throw new Error(`item not found: ${id}`);
    const known = new Set((await this.store.listCollections()).map((c) => c.id));
    const resolved = [...new Set(collectionIds)].filter((c) => known.has(c));
    if (resolved.length === 0) {
      await this.dropItems([item]);
      return undefined;
    }
    const next: CollectionItem = { ...item, collectionIds: resolved };
    await this.store.putCollectionItems([next]);
    return next;
  }

  // ── Favorite collections ──────────────────────────────────────────────────────

  async getCollections(): Promise<Collection[]> {
    return (await this.store.listCollections()).sort((a, b) => a.order - b.order);
  }

  async createCollection(name: string): Promise<Collection> {
    const existing = await this.store.listCollections();
    const order = existing.reduce((max, c) => Math.max(max, c.order), -1) + 1;
    const collection: Collection = { id: crypto.randomUUID(), name, order };
    await this.store.putCollections([...existing, collection]);
    return collection;
  }

  async renameCollection(id: string, name: string): Promise<void> {
    const collections = await this.store.listCollections();
    if (!collections.some((c) => c.id === id)) throw new Error(`favorite collection not found: ${id}`);
    await this.store.putCollections(collections.map((c) => (c.id === id ? { ...c, name } : c)));
  }

  async reorderCollections(orderedIds: string[]): Promise<void> {
    const collections = await this.store.listCollections();
    await this.store.putCollections(
      collections.map((c) => {
        const idx = orderedIds.indexOf(c.id);
        return idx === -1 ? c : { ...c, order: idx };
      }),
    );
  }

  /**
   * Delete a collection and strip its id from every member.
   *
   * PURE COLLECTIONS: any item — series, chapter, or page — left with zero memberships is removed
   * with it. An item exists only as a member of collections; there is no standalone "favorite"
   * concept (that word belongs to bridge accounts). Items in other collections merely lose one
   * membership.
   */
  async deleteCollection(id: string): Promise<void> {
    const collections = await this.store.listCollections();
    await this.store.putCollections(collections.filter((c) => c.id !== id));
    // One batched write per side for the whole cascade — a per-member write would rewrite the
    // items document once per member.
    const members = (await this.store.listCollectionItems()).filter((i) => i.collectionIds.includes(id));
    const stripped = members.map((i) => ({ ...i, collectionIds: i.collectionIds.filter((c) => c !== id) }));
    await this.dropItems(stripped.filter((i) => i.collectionIds.length === 0));
    await this.store.putCollectionItems(stripped.filter((i) => i.collectionIds.length > 0));
  }

  // ── Series groups ─────────────────────────────────────────────────────────────

  async listGroups(): Promise<SeriesGroup[]> {
    return this.store.listGroups();
  }

  /** Link two or more existing library entries as the same title from different bridges. */
  async createGroup(memberKeys: string[], primaryKey: string): Promise<SeriesGroup> {
    if (!memberKeys.includes(primaryKey)) throw new Error("primaryKey must be in memberKeys");
    if (memberKeys.length < 2) throw new Error("a group requires at least 2 members");
    const primary = await this.getSeriesItem(primaryKey);
    if (!primary) throw new Error(`series not collected: ${primaryKey}`);
    const deduped = [...new Set(memberKeys)];
    const group: SeriesGroup = {
      id: crypto.randomUUID(),
      title: primary.seriesTitle,
      primaryKey,
      memberKeys: deduped,
      createdAt: this.now(),
    };
    await this.store.putGroup(group);
    for (const key of deduped) {
      const e = await this.getSeriesItem(key);
      if (e) await this.putSeriesItem({ ...e, seriesGroupId: group.id, updatedAt: this.now() });
    }
    return group;
  }

  /**
   * Link a newly-added entry to one already in the library: join the existing entry's group if it
   * has one, else create a two-member group with the EXISTING entry as primary. It was there first,
   * so it's the one carrying progress — the newcomer must never hijack the reading source.
   *
   * Both the external-id auto-link in {@link collectSeries} and the user-confirmed title match in a
   * favorites import go through here, so "linking" means exactly one thing. No-op when both keys
   * are already in the same group (or are the same key).
   */
  async linkEntries(existingKey: string, newKey: string): Promise<void> {
    if (existingKey === newKey) return;
    const existing = await this.getSeriesItem(existingKey);
    if (!existing) throw new Error(`series not collected: ${existingKey}`);
    if (existing.seriesGroupId) {
      await this.joinGroup(existing.seriesGroupId, newKey);
    } else {
      await this.createGroup([existingKey, newKey], existingKey);
    }
  }

  /**
   * Every collected series bucketed by {@link normalizeTitle} — the index for spotting the same work
   * already present from another bridge. Built in one pass so a caller classifying a whole favorites
   * list scans the library once rather than once per candidate. Entries whose title normalizes to
   * nothing (punctuation only) are omitted rather than bucketed together under "".
   */
  async titleIndex(): Promise<Map<string, CollectionSeriesItem[]>> {
    const index = new Map<string, CollectionSeriesItem[]>();
    for (const entry of await this.listSeriesItems()) {
      const key = normalizeTitle(entry.seriesTitle);
      if (!key) continue;
      const bucket = index.get(key);
      if (bucket) bucket.push(entry);
      else index.set(key, [entry]);
    }
    return index;
  }

  /** Add an entry to an existing group. */
  async joinGroup(groupId: string, key: string): Promise<void> {
    const groups = await this.store.listGroups();
    const group = groups.find((g) => g.id === groupId);
    if (!group) throw new Error(`group not found: ${groupId}`);
    if (group.memberKeys.includes(key)) return;
    group.memberKeys = [...group.memberKeys, key];
    await this.store.putGroup(group);
    const entry = await this.getSeriesItem(key);
    if (entry) await this.putSeriesItem({ ...entry, seriesGroupId: groupId, updatedAt: this.now() });
  }

  /**
   * Remove an entry from its group. Dissolves the group if fewer than 2 members would remain.
   * No-op if the entry has no group.
   */
  async leaveGroup(key: string): Promise<void> {
    const entry = await this.getSeriesItem(key);
    if (!entry?.seriesGroupId) return;
    const { seriesGroupId: groupId, ...entryWithoutGroup } = entry;
    await this.putSeriesItem({ ...entryWithoutGroup, updatedAt: this.now() });

    const groups = await this.store.listGroups();
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    const remaining = group.memberKeys.filter((k) => k !== key);
    if (remaining.length < 2) {
      // Dissolve — remove groupId from the last remaining member too.
      await this.store.deleteGroup(groupId);
      for (const rk of remaining) {
        const re = await this.getSeriesItem(rk);
        if (re) {
          const { seriesGroupId: _drop, ...rest } = re;
          await this.putSeriesItem({ ...rest, updatedAt: this.now() });
        }
      }
    } else {
      group.memberKeys = remaining;
      if (group.primaryKey === key) group.primaryKey = remaining[0]!;
      await this.store.putGroup(group);
    }
  }

  /** Get the group this entry belongs to, if any. */
  async getGroup(key: string): Promise<SeriesGroup | undefined> {
    const entry = await this.getSeriesItem(key);
    if (!entry?.seriesGroupId) return undefined;
    const groups = await this.store.listGroups();
    return groups.find((g) => g.id === entry.seriesGroupId);
  }

  /** Change which bridge is the preferred reading source for a group. */
  async setPrimarySource(groupId: string, newPrimaryKey: string): Promise<void> {
    const groups = await this.store.listGroups();
    const group = groups.find((g) => g.id === groupId);
    if (!group) throw new Error(`group not found: ${groupId}`);
    if (!group.memberKeys.includes(newPrimaryKey)) {
      throw new Error(`${newPrimaryKey} is not a member of group ${groupId}`);
    }
    await this.store.putGroup({ ...group, primaryKey: newPrimaryKey });
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /**
   * Merge a progress patch and (for local reads) refresh the entry's resume cache.
   *
   * `opts.touchResume` defaults to true: a local read advances the resume/history point. External
   * reconciliation passes `false` so a pulled-in read can update the read flag without hijacking
   * the user's reading position or recency.
   */
  private async writeProgress(
    key: string,
    chapterId: string,
    patch: Partial<ChapterProgress>,
    chapterName?: string,
    opts: { touchResume?: boolean } = {},
  ): Promise<void> {
    const entry = await this.requireSeries(key);
    const t = this.now();
    const existing = (await this.store.listProgress(key)).find((p) => p.chapterId === chapterId);
    const next: ChapterProgress = {
      chapterId,
      read: patch.read ?? existing?.read ?? false,
      updatedAt: t,
    };
    const lastPage = patch.lastPage ?? existing?.lastPage;
    if (lastPage !== undefined) next.lastPage = lastPage;
    const pageCount = patch.pageCount ?? existing?.pageCount;
    if (pageCount !== undefined) next.pageCount = pageCount;
    // Backfill the logical-chapter metadata from the synced chapter list when the caller didn't
    // supply it, so read state always collapses by `(number, language)` — e.g. a "mark read"
    // checkbox that only sends a chapter id still gets grouped correctly.
    const meta = entry.knownChapters.find((c) => c.id === chapterId);
    const number = patch.number ?? existing?.number ?? meta?.number;
    if (number !== undefined) next.number = number;
    const languageCode = patch.languageCode ?? existing?.languageCode ?? meta?.languageCode;
    if (languageCode !== undefined) next.languageCode = languageCode;
    await this.store.putProgress(key, next);

    // Advancing a LOCAL read (marking read, or recording a page) makes this the resume/history
    // point. Pulled-in reads pass touchResume:false so a sync can't move where the user is.
    const touchResume = opts.touchResume ?? true;
    if (touchResume && (next.read || patch.lastPage !== undefined)) {
      entry.lastReadChapterId = chapterId;
      if (chapterName !== undefined) entry.lastReadChapterName = chapterName;
      entry.lastReadAt = t;
      entry.updatedAt = t;
      await this.putSeriesItem(entry);
    }
  }

  private async requireSeries(key: string): Promise<CollectionSeriesItem> {
    const entry = await this.getSeriesItem(key);
    if (!entry) {
      const { bridgeId, seriesId } = parseEntryKey(key);
      throw new Error(`series not collected: ${bridgeId}/${seriesId}`);
    }
    return entry;
  }

  private async findExternalIdMatch(
    newKey: string,
    ids: NonNullable<SeriesItemSnapshot["externalIds"]>,
  ): Promise<CollectSeriesResult["autoLinked"]> {
    const entries = await this.listSeriesItems();
    for (const e of entries) {
      const ek = entryKey(e.bridgeId, e.seriesId);
      if (ek === newKey || !e.externalIds) continue;
      for (const [service, id] of Object.entries(ids)) {
        if (e.externalIds[service] === id) {
          return { matchedKey: ek, sharedId: { service, value: id } };
        }
      }
    }
    return undefined;
  }

  // ── Tracker links ─────────────────────────────────────────────────────────────

  async linkTracker(key: string, trackerId: string, externalId: string | number): Promise<void> {
    await this.requireSeries(key);
    const existing = (await this.store.listTrackerLinks(key)).find((l) => l.trackerId === trackerId);
    const link: TrackerLink = { ...existing, trackerId, externalId };
    await this.store.putTrackerLink(key, link);
  }

  async unlinkTracker(key: string, trackerId: string): Promise<void> {
    await this.store.deleteTrackerLink(key, trackerId);
  }

  async getTrackerLink(key: string, trackerId: string): Promise<TrackerLink | undefined> {
    return (await this.store.listTrackerLinks(key)).find((l) => l.trackerId === trackerId);
  }

  async listTrackerLinks(key: string): Promise<TrackerLink[]> {
    return this.store.listTrackerLinks(key);
  }

  async updateTrackerLink(key: string, trackerId: string, patch: Partial<TrackerLink>): Promise<void> {
    const existing = await this.getTrackerLink(key, trackerId);
    if (!existing) throw new Error(`tracker link not found: ${key} / ${trackerId}`);
    await this.store.putTrackerLink(key, { ...existing, ...patch, trackerId });
  }

  // ── Bridge preferences ─────────────────────────────────────────────────────

  async getBridgePrefs(bridgeId: string): Promise<BridgePrefs> {
    return (await this.store.getBridgePrefs(bridgeId)) ?? { bridgeId, trackersDisabled: false, historyDisabled: false };
  }

  /** Merge a partial update so toggling one flag (e.g. history) never clears another (e.g. trackers). */
  async setBridgePrefs(
    bridgeId: string,
    update: Partial<Pick<BridgePrefs, "trackersDisabled" | "historyDisabled">>,
  ): Promise<void> {
    const current = await this.getBridgePrefs(bridgeId);
    await this.store.setBridgePrefs(bridgeId, { ...current, ...update, bridgeId });
  }
}

/**
 * Key for a logical chapter — what the reader thinks of as "chapter N" regardless of which
 * scanlation group produced this copy. Copies that share `(number, languageCode)` collapse to one
 * logical chapter; a chapter with no `number` can't be safely grouped, so it stands alone (keyed by
 * its id). The leading tag keeps the number- and id-namespaces from ever colliding.
 */
function logicalChapterKey(c: { number?: number | undefined; languageCode?: string | undefined }, id: string): string {
  return c.number !== undefined ? `n:${c.number}:${c.languageCode ?? ""}` : `i:${id}`;
}

/**
 * A stored series item, hardened against records written BEFORE the library dissolved into
 * collections.
 *
 * Back then a series item was a thin membership pointer — it had `collectedAt`, `collectionIds`
 * and a title, and nothing else, because the tracking state lived on the separate `LibraryEntry`.
 * The dissolution added `knownChapters` and `updatedAt` and did NOT change the id (`series:b:s`),
 * so those old records survive a version bump completely intact and reach code that assumes the
 * current shape. One of them is enough to fail the entire library listing, which is exactly what
 * it did: `unreadLogicalCount` dereferenced an absent `knownChapters` and the whole `GET /library`
 * response 500'd.
 *
 * `importLegacyEntries` upgrades the ones it has a legacy row for, but it can't reach a series that
 * was filed into a collection without ever being in the library — that was a legal state, so this
 * has to hold regardless. Filling the gaps on read costs a shape check per item and means no single
 * stale record can take the surface down.
 */
function hydrateSeriesItem(item: CollectionSeriesItem): CollectionSeriesItem {
  if (item.knownChapters !== undefined && item.updatedAt !== undefined) return item;
  return {
    ...item,
    knownChapters: item.knownChapters ?? [],
    // Never been synced, so the closest honest answer is when it was collected.
    updatedAt: item.updatedAt ?? item.collectedAt,
  };
}

/**
 * Known logical chapters `(number, language)` with no read copy in any scanlation group. Shared by
 * the library view's `unreadCount` and by `getSeriesCompletion`, so "0 unread" can never mean two
 * different things depending on which one asked.
 */
function unreadLogicalCount(item: CollectionSeriesItem, progress: ChapterProgress[]): number {
  const readLogical = new Set(progress.filter((p) => p.read).map((p) => logicalChapterKey(p, p.chapterId)));
  const knownLogical = new Set(item.knownChapters.map((c) => logicalChapterKey(c, c.id)));
  return [...knownLogical].filter((k) => !readLogical.has(k)).length;
}

/**
 * Reading order: ascending chapter number when present, falling back to the supplied order for
 * chapters without a number (stable). Backends may return chapters newest-first; "read up to here"
 * needs them oldest-first.
 */
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
