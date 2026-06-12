/**
 * The library domain service. ALL behaviour lives here so every store backend (memory, file,
 * IndexedDB, SQLite) and every host behaves identically — a store only persists documents.
 *
 * Identity is the cross-bridge pair `(bridgeId, seriesId)`, encoded via `entryKey`. The library is
 * fully independent of any bridge's backend `favorites`: adding here never touches a bridge.
 */
import type { Chapter } from "@comical/contract";
import {
  entryKey,
  parseEntryKey,
  type ActivityItem,
  type ActivityItemView,
  type BridgePrefs,
  type ChapterProgress,
  type HistoryItem,
  type KnownChapter,
  type LibraryEntry,
  type LibraryEntryView,
  type LibraryList,
  type ResumePoint,
  type SeriesGroup,
  type TrackerLink,
} from "./models.ts";
import type { LibraryStore } from "./store.ts";

/** A series snapshot supplied when adding to the library (cached for offline rendering). */
export interface SeriesSnapshot {
  bridgeId: string;
  seriesId: string;
  title: string;
  thumbnailUrl?: string;
  author?: string;
  listIds?: string[];
  /** Cross-service ids from `SeriesInfo.externalIds`, keyed by tracker id — persisted for auto-grouping + sync. */
  externalIds?: Record<string, string | number>;
}

/** Returned when adding a series. `autoLinked` is set when the new entry was automatically grouped with an existing one via a shared external id. */
export interface AddSeriesResult {
  entry: LibraryEntry;
  /** Present when the new entry was automatically grouped with an existing library entry via a shared external id. */
  autoLinked?: {
    matchedKey: string;
    sharedId: { service: string; value: number | string };
  };
}

export interface LibraryOptions {
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Sort keys for {@link Library.getLibrary}. */
export type LibrarySort = "added" | "title" | "lastRead" | "unread";

/** Filter + sort options for {@link Library.getLibrary}. All optional. */
export interface LibraryQuery {
  /** Single-list filter (back-compat). Prefer `listIds`. */
  listId?: string;
  /** Filter to entries assigned to ANY of these lists. Empty/absent means all lists. */
  listIds?: string[];
  /** Only entries with no lists assigned. Takes precedence over `listId`/`listIds`. */
  unlisted?: boolean;
  /** Case-insensitive substring search over title + author. */
  q?: string;
  /** Only entries with at least one unread chapter. */
  unreadOnly?: boolean;
  /** Sort key. Defaults to `"added"`. */
  sort?: LibrarySort;
  /** Sort direction. Defaults to `"asc"` for `title`, `"desc"` otherwise. */
  dir?: "asc" | "desc";
}

/** Compare two entry views by `sort` key in ascending order (callers apply direction). */
function compareEntries(a: LibraryEntryView, b: LibraryEntryView, sort: LibrarySort): number {
  switch (sort) {
    case "title":
      return a.title.localeCompare(b.title);
    case "lastRead":
      return (a.lastReadAt ?? 0) - (b.lastReadAt ?? 0);
    case "unread":
      return a.unreadCount - b.unreadCount;
    case "added":
      return a.addedAt - b.addedAt;
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

  // ── Collection ─────────────────────────────────────────────────────────────

  async addSeries(snap: SeriesSnapshot): Promise<AddSeriesResult> {
    const key = entryKey(snap.bridgeId, snap.seriesId);
    const existing = await this.store.getEntry(key);
    const t = this.now();
    const entry: LibraryEntry = existing
      ? { ...existing, title: snap.title, updatedAt: t }
      : {
          bridgeId: snap.bridgeId,
          seriesId: snap.seriesId,
          title: snap.title,
          listIds: snap.listIds ?? [],
          addedAt: t,
          updatedAt: t,
          knownChapters: [],
        };
    // Optional snapshot fields: only set when provided (exactOptionalPropertyTypes-friendly).
    if (snap.thumbnailUrl !== undefined) entry.thumbnailUrl = snap.thumbnailUrl;
    if (snap.author !== undefined) entry.author = snap.author;
    if (!existing && snap.listIds) entry.listIds = snap.listIds;
    if (snap.externalIds !== undefined) entry.externalIds = snap.externalIds;
    await this.store.putEntry(entry);

    // Auto-link: for new entries with externalIds, find any existing entry that shares an id
    // and automatically create/join a group. No user action required.
    let autoLinked: AddSeriesResult["autoLinked"];
    if (!existing && snap.externalIds) {
      const match = await this.findExternalIdMatch(key, snap.externalIds);
      if (match) {
        const matchedEntry = await this.store.getEntry(match.matchedKey);
        if (matchedEntry?.seriesGroupId) {
          await this.joinGroup(matchedEntry.seriesGroupId, key);
        } else {
          // Existing entry is primary (it was added first); new entry joins.
          await this.createGroup([match.matchedKey, key], match.matchedKey);
        }
        autoLinked = match;
      }
    }

    return { entry, ...(autoLinked !== undefined && { autoLinked }) };
  }

  async removeSeries(key: string): Promise<void> {
    await this.leaveGroup(key);
    await this.store.deleteEntry(key);
    await this.store.deleteProgressForEntry(key);
    await this.store.deleteActivityForEntry(key);
  }

  async isInLibrary(key: string): Promise<boolean> {
    return (await this.store.getEntry(key)) !== undefined;
  }

  async getEntry(key: string): Promise<LibraryEntry | undefined> {
    return this.store.getEntry(key);
  }

  async setLists(key: string, listIds: string[]): Promise<void> {
    const entry = await this.requireEntry(key);
    entry.listIds = [...new Set(listIds)];
    entry.updatedAt = this.now();
    await this.store.putEntry(entry);
  }

  /**
   * Query the library: filter by list/search/read-state and sort, each entry carrying a derived
   * `unreadCount`. All options are optional; with none, returns every entry sorted newest-added-first.
   */
  async getLibrary(opts: LibraryQuery = {}): Promise<LibraryEntryView[]> {
    const entries = await this.store.listEntries();

    // List scope: `unlisted` (no lists) wins; else single `listId` (back-compat) or
    // `listIds` (OR across the set). An empty/absent set means "all".
    const listIds = opts.listIds ?? (opts.listId !== undefined ? [opts.listId] : undefined);
    let filtered = entries;
    if (opts.unlisted) {
      filtered = filtered.filter((e) => e.listIds.length === 0);
    } else if (listIds && listIds.length > 0) {
      filtered = filtered.filter((e) => e.listIds.some((id) => listIds.includes(id)));
    }

    // Free-text search: case-insensitive substring over title + author.
    const q = opts.q?.trim().toLowerCase();
    if (q) {
      filtered = filtered.filter(
        (e) => e.title.toLowerCase().includes(q) || (e.author?.toLowerCase().includes(q) ?? false),
      );
    }

    let views = await Promise.all(filtered.map((e) => this.toView(e)));
    if (opts.unreadOnly) views = views.filter((v) => v.unreadCount > 0);

    // Sort. Title defaults to ascending (A–Z); the recency/count keys default to descending
    // (newest / most-unread first) since that's the useful direction.
    const sort = opts.sort ?? "added";
    const sign = (opts.dir ?? (sort === "title" ? "asc" : "desc")) === "asc" ? 1 : -1;
    views.sort((a, b) => sign * compareEntries(a, b, sort));
    return views;
  }

  private async toView(entry: LibraryEntry): Promise<LibraryEntryView> {
    const progress = await this.store.listProgress(entryKey(entry.bridgeId, entry.seriesId));
    // Collapse to logical chapters `(number, language)`: a logical chapter is unread when no
    // scanlation-group copy of it has been read.
    const readLogical = new Set(progress.filter((p) => p.read).map((p) => logicalChapterKey(p, p.chapterId)));
    const knownLogical = new Set((entry.knownChapters ?? []).map((c) => logicalChapterKey(c, c.id)));
    const unreadCount = [...knownLogical].filter((k) => !readLogical.has(k)).length;
    return { ...entry, unreadCount };
  }

  // ── New-chapter detection ────────────────────────────────────────────────────

  /**
   * Reconcile a freshly-fetched chapter list against what we last knew. Returns the chapters that
   * are new since the previous sync (empty on the first sync — there's no baseline to diff against).
   */
  async syncChapters(key: string, chapters: Chapter[]): Promise<{ added: Chapter[] }> {
    const entry = await this.requireEntry(key);
    // Diff by logical chapter `(number, language)` — a fresh scanlation-group copy of a chapter we
    // already know is NOT a new chapter.
    const known = new Set((entry.knownChapters ?? []).map((c) => logicalChapterKey(c, c.id)));
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
          // A chapter only counts as "new" if it was published after the series joined the library.
          // The `firstSync` baseline assumes the very first list we see is complete; in practice it
          // often isn't (favorites import adds without syncing, a paginated/empty first fetch), and a
          // later fuller sync would otherwise flag the entire back-catalogue as new. Gating on publish
          // time keeps old chapters out of the feed regardless of baseline completeness. Chapters with
          // no `publishedAt` fall back to the diff alone (best effort for bridges that omit dates).
          if (c.publishedAt !== undefined && c.publishedAt <= entry.addedAt) return false;
          return true;
        });
    const t = this.now();
    entry.knownChapters = chapters.map((c): KnownChapter => {
      const k: KnownChapter = { id: c.id };
      if (c.number !== undefined) k.number = c.number;
      if (c.languageCode !== undefined) k.languageCode = c.languageCode;
      return k;
    });
    entry.chaptersSyncedAt = t;
    await this.store.putEntry(entry);

    // Record each newly-detected chapter as an activity event (the "new chapters" feed). Snapshots
    // the series display fields so the feed renders offline / after the bridge is removed.
    for (const c of added) {
      const item: ActivityItem = {
        bridgeId: entry.bridgeId,
        seriesId: entry.seriesId,
        chapterId: c.id,
        title: entry.title,
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
    await this.requireEntry(key);
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

  async getProgress(key: string): Promise<ChapterProgress[]> {
    return this.store.listProgress(key);
  }

  /** Where to resume: the last-read chapter and the page within it. */
  async getResume(key: string): Promise<ResumePoint | undefined> {
    const entry = await this.store.getEntry(key);
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
    const entries = await this.store.listEntries();
    const libraryItems = await Promise.all(
      entries
        .filter((e): e is LibraryEntry & { lastReadAt: number } => e.lastReadAt !== undefined)
        .map(async (e): Promise<HistoryItem> => {
          // Surface the resume page/count for the last-read chapter so history renders "page X / N".
          const p = e.lastReadChapterId === undefined
            ? undefined
            : (await this.store.listProgress(entryKey(e.bridgeId, e.seriesId)))
                .find((x) => x.chapterId === e.lastReadChapterId);
          return {
            bridgeId: e.bridgeId,
            seriesId: e.seriesId,
            title: e.title,
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
    const existing = await this.store.getEntry(entryKey(item.bridgeId, item.seriesId));
    if (existing) return;
    if ((await this.getBridgePrefs(item.bridgeId)).historyDisabled) return;
    await this.store.upsertReadingLog(item);
  }

  /** Remove a series from reading history. For library entries, clears last-read fields; for log entries, deletes the record. */
  async clearHistoryEntry(bridgeId: string, seriesId: string): Promise<void> {
    const key = entryKey(bridgeId, seriesId);
    const existing = await this.store.getEntry(key);
    if (existing) {
      const { lastReadAt: _a, lastReadChapterId: _b, lastReadChapterName: _c, ...rest } = existing;
      await this.store.putEntry({ ...rest, updatedAt: this.now() });
    } else {
      await this.store.deleteReadingLog(bridgeId, seriesId);
    }
  }

  // ── Activity feed (newly-detected chapters) ─────────────────────────────────────

  /**
   * The new-chapter feed, newest first. Each item's `read` flag is derived live from chapter
   * progress, so an item drops out of the unread count the moment the user reads its chapter.
   */
  async getActivity(opts: { limit?: number; unreadOnly?: boolean } = {}): Promise<ActivityItemView[]> {
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
      const read = (await readSet(entryKey(item.bridgeId, item.seriesId))).has(logicalChapterKey(item, item.chapterId));
      if (opts.unreadOnly && read) continue;
      views.push({ ...item, read });
      if (opts.limit !== undefined && views.length >= opts.limit) break;
    }
    return views;
  }

  /** Count of feed items whose chapter the user hasn't read yet — the "new" badge value. */
  async unreadActivityCount(): Promise<number> {
    return (await this.getActivity({ unreadOnly: true })).length;
  }

  /** Empty the feed (user "clear" action). */
  async clearActivity(): Promise<void> {
    await this.store.clearActivity();
  }

  // ── Lists ────────────────────────────────────────────────────────────────────

  async getLists(): Promise<LibraryList[]> {
    return (await this.store.listLists()).sort((a, b) => a.order - b.order);
  }

  async createList(name: string): Promise<LibraryList> {
    const existing = await this.store.listLists();
    const order = existing.reduce((max, c) => Math.max(max, c.order), -1) + 1;
    const list: LibraryList = { id: crypto.randomUUID(), name, order };
    await this.store.putList(list);
    return list;
  }

  async renameList(id: string, name: string): Promise<void> {
    const list = (await this.store.listLists()).find((c) => c.id === id);
    if (!list) throw new Error(`list not found: ${id}`);
    await this.store.putList({ ...list, name });
  }

  async reorderLists(orderedIds: string[]): Promise<void> {
    const lists = await this.store.listLists();
    for (const c of lists) {
      const idx = orderedIds.indexOf(c.id);
      if (idx !== -1 && idx !== c.order) await this.store.putList({ ...c, order: idx });
    }
  }

  /** Delete a list and strip its id from every entry that referenced it. */
  async deleteList(id: string): Promise<void> {
    await this.store.deleteList(id);
    for (const entry of await this.store.listEntries()) {
      if (entry.listIds.includes(id)) {
        entry.listIds = entry.listIds.filter((c) => c !== id);
        entry.updatedAt = this.now();
        await this.store.putEntry(entry);
      }
    }
  }

  // ── Series groups ─────────────────────────────────────────────────────────────

  async listGroups(): Promise<SeriesGroup[]> {
    return this.store.listGroups();
  }

  /** Link two or more existing library entries as the same title from different bridges. */
  async createGroup(memberKeys: string[], primaryKey: string): Promise<SeriesGroup> {
    if (!memberKeys.includes(primaryKey)) throw new Error("primaryKey must be in memberKeys");
    if (memberKeys.length < 2) throw new Error("a group requires at least 2 members");
    const primary = await this.store.getEntry(primaryKey);
    if (!primary) throw new Error(`entry not in library: ${primaryKey}`);
    const deduped = [...new Set(memberKeys)];
    const group: SeriesGroup = {
      id: crypto.randomUUID(),
      title: primary.title,
      primaryKey,
      memberKeys: deduped,
      createdAt: this.now(),
    };
    await this.store.putGroup(group);
    for (const key of deduped) {
      const e = await this.store.getEntry(key);
      if (e) await this.store.putEntry({ ...e, seriesGroupId: group.id, updatedAt: this.now() });
    }
    return group;
  }

  /** Add an entry to an existing group. */
  async joinGroup(groupId: string, key: string): Promise<void> {
    const groups = await this.store.listGroups();
    const group = groups.find((g) => g.id === groupId);
    if (!group) throw new Error(`group not found: ${groupId}`);
    if (group.memberKeys.includes(key)) return;
    group.memberKeys = [...group.memberKeys, key];
    await this.store.putGroup(group);
    const entry = await this.store.getEntry(key);
    if (entry) await this.store.putEntry({ ...entry, seriesGroupId: groupId, updatedAt: this.now() });
  }

  /**
   * Remove an entry from its group. Dissolves the group if fewer than 2 members would remain.
   * No-op if the entry has no group.
   */
  async leaveGroup(key: string): Promise<void> {
    const entry = await this.store.getEntry(key);
    if (!entry?.seriesGroupId) return;
    const { seriesGroupId: groupId, ...entryWithoutGroup } = entry;
    await this.store.putEntry({ ...entryWithoutGroup, updatedAt: this.now() });

    const groups = await this.store.listGroups();
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    const remaining = group.memberKeys.filter((k) => k !== key);
    if (remaining.length < 2) {
      // Dissolve — remove groupId from the last remaining member too.
      await this.store.deleteGroup(groupId);
      for (const rk of remaining) {
        const re = await this.store.getEntry(rk);
        if (re) {
          const { seriesGroupId: _drop, ...rest } = re;
          await this.store.putEntry({ ...rest, updatedAt: this.now() });
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
    const entry = await this.store.getEntry(key);
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
    const entry = await this.requireEntry(key);
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
    const meta = (entry.knownChapters ?? []).find((c) => c.id === chapterId);
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
      await this.store.putEntry(entry);
    }
  }

  private async requireEntry(key: string): Promise<LibraryEntry> {
    const entry = await this.store.getEntry(key);
    if (!entry) {
      const { bridgeId, seriesId } = parseEntryKey(key);
      throw new Error(`series not in library: ${bridgeId}/${seriesId}`);
    }
    return entry;
  }

  private async findExternalIdMatch(
    newKey: string,
    ids: NonNullable<SeriesSnapshot["externalIds"]>,
  ): Promise<AddSeriesResult["autoLinked"]> {
    const entries = await this.store.listEntries();
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
    await this.requireEntry(key);
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
