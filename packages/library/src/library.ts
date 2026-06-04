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
  type Category,
  type ChapterProgress,
  type HistoryItem,
  type LibraryEntry,
  type LibraryEntryView,
  type ResumePoint,
} from "./models.ts";
import type { LibraryStore } from "./store.ts";

/** A series snapshot supplied when adding to the library (cached for offline rendering). */
export interface SeriesSnapshot {
  bridgeId: string;
  seriesId: string;
  title: string;
  thumbnailUrl?: string;
  author?: string;
  categoryIds?: string[];
}

export interface LibraryOptions {
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
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

  async addSeries(snap: SeriesSnapshot): Promise<LibraryEntry> {
    const key = entryKey(snap.bridgeId, snap.seriesId);
    const existing = await this.store.getEntry(key);
    const t = this.now();
    const entry: LibraryEntry = existing
      ? { ...existing, title: snap.title, updatedAt: t }
      : {
          bridgeId: snap.bridgeId,
          seriesId: snap.seriesId,
          title: snap.title,
          categoryIds: snap.categoryIds ?? [],
          addedAt: t,
          updatedAt: t,
          knownChapterIds: [],
        };
    // Optional snapshot fields: only set when provided (exactOptionalPropertyTypes-friendly).
    if (snap.thumbnailUrl !== undefined) entry.thumbnailUrl = snap.thumbnailUrl;
    if (snap.author !== undefined) entry.author = snap.author;
    if (!existing && snap.categoryIds) entry.categoryIds = snap.categoryIds;
    await this.store.putEntry(entry);
    return entry;
  }

  async removeSeries(key: string): Promise<void> {
    await this.store.deleteEntry(key);
    await this.store.deleteProgressForEntry(key);
  }

  async isInLibrary(key: string): Promise<boolean> {
    return (await this.store.getEntry(key)) !== undefined;
  }

  async getEntry(key: string): Promise<LibraryEntry | undefined> {
    return this.store.getEntry(key);
  }

  async setCategories(key: string, categoryIds: string[]): Promise<void> {
    const entry = await this.requireEntry(key);
    entry.categoryIds = [...new Set(categoryIds)];
    entry.updatedAt = this.now();
    await this.store.putEntry(entry);
  }

  /** All entries (optionally filtered to a category), each with a derived `unreadCount`. */
  async getLibrary(opts: { categoryId?: string } = {}): Promise<LibraryEntryView[]> {
    const entries = await this.store.listEntries();
    const filtered = opts.categoryId
      ? entries.filter((e) => e.categoryIds.includes(opts.categoryId!))
      : entries;
    return Promise.all(filtered.map((e) => this.toView(e)));
  }

  private async toView(entry: LibraryEntry): Promise<LibraryEntryView> {
    const progress = await this.store.listProgress(entryKey(entry.bridgeId, entry.seriesId));
    const readIds = new Set(progress.filter((p) => p.read).map((p) => p.chapterId));
    const unreadCount = entry.knownChapterIds.filter((id) => !readIds.has(id)).length;
    return { ...entry, unreadCount };
  }

  // ── New-chapter detection ────────────────────────────────────────────────────

  /**
   * Reconcile a freshly-fetched chapter list against what we last knew. Returns the chapters that
   * are new since the previous sync (empty on the first sync — there's no baseline to diff against).
   */
  async syncChapters(key: string, chapters: Chapter[]): Promise<{ added: Chapter[] }> {
    const entry = await this.requireEntry(key);
    const known = new Set(entry.knownChapterIds);
    const firstSync = entry.chaptersSyncedAt === undefined;
    const added = firstSync ? [] : chapters.filter((c) => !known.has(c.id));
    entry.knownChapterIds = chapters.map((c) => c.id);
    entry.chaptersSyncedAt = this.now();
    await this.store.putEntry(entry);
    return { added };
  }

  // ── Read state ────────────────────────────────────────────────────────────────

  async markRead(key: string, chapterId: string, read: boolean, chapterName?: string): Promise<void> {
    await this.writeProgress(key, chapterId, { read }, chapterName);
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
    for (const c of ordered.slice(0, cut + 1)) {
      await this.writeProgress(key, c.id, { read: true }, c.name);
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
  ): Promise<void> {
    const reachedEnd = pageCount !== undefined && pageCount > 0 && lastPage >= pageCount - 1;
    const patch: Partial<ChapterProgress> = { lastPage };
    if (pageCount !== undefined) patch.pageCount = pageCount;
    if (reachedEnd) patch.read = true;
    await this.writeProgress(key, chapterId, patch, chapterName);
  }

  async getProgress(key: string): Promise<ChapterProgress[]> {
    return this.store.listProgress(key);
  }

  /** Where to resume: the last-read chapter and the page within it. */
  async getResume(key: string): Promise<ResumePoint | undefined> {
    const entry = await this.store.getEntry(key);
    if (!entry?.lastReadChapterId) return undefined;
    const progress = await this.store.listProgress(key);
    const p = progress.find((x) => x.chapterId === entry.lastReadChapterId);
    return { chapterId: entry.lastReadChapterId, lastPage: p?.lastPage ?? 0 };
  }

  /** Recently-read series, newest first (one row per series for v1). */
  async getHistory(limit = 50): Promise<HistoryItem[]> {
    const entries = await this.store.listEntries();
    return entries
      .filter((e): e is LibraryEntry & { lastReadAt: number } => e.lastReadAt !== undefined)
      .sort((a, b) => b.lastReadAt - a.lastReadAt)
      .slice(0, limit)
      .map((e) => {
        const item: HistoryItem = {
          bridgeId: e.bridgeId,
          seriesId: e.seriesId,
          title: e.title,
          lastReadAt: e.lastReadAt,
        };
        if (e.thumbnailUrl !== undefined) item.thumbnailUrl = e.thumbnailUrl;
        if (e.lastReadChapterId !== undefined) item.lastReadChapterId = e.lastReadChapterId;
        if (e.lastReadChapterName !== undefined) item.lastReadChapterName = e.lastReadChapterName;
        return item;
      });
  }

  // ── Categories ────────────────────────────────────────────────────────────────

  async listCategories(): Promise<Category[]> {
    return (await this.store.listCategories()).sort((a, b) => a.order - b.order);
  }

  async createCategory(name: string): Promise<Category> {
    const existing = await this.store.listCategories();
    const order = existing.reduce((max, c) => Math.max(max, c.order), -1) + 1;
    const category: Category = { id: crypto.randomUUID(), name, order };
    await this.store.putCategory(category);
    return category;
  }

  async renameCategory(id: string, name: string): Promise<void> {
    const category = (await this.store.listCategories()).find((c) => c.id === id);
    if (!category) throw new Error(`category not found: ${id}`);
    await this.store.putCategory({ ...category, name });
  }

  async reorderCategories(orderedIds: string[]): Promise<void> {
    const categories = await this.store.listCategories();
    for (const c of categories) {
      const idx = orderedIds.indexOf(c.id);
      if (idx !== -1 && idx !== c.order) await this.store.putCategory({ ...c, order: idx });
    }
  }

  /** Delete a category and strip its id from every entry that referenced it. */
  async deleteCategory(id: string): Promise<void> {
    await this.store.deleteCategory(id);
    for (const entry of await this.store.listEntries()) {
      if (entry.categoryIds.includes(id)) {
        entry.categoryIds = entry.categoryIds.filter((c) => c !== id);
        entry.updatedAt = this.now();
        await this.store.putEntry(entry);
      }
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /** Merge a progress patch and refresh the entry's resume cache when a read advances. */
  private async writeProgress(
    key: string,
    chapterId: string,
    patch: Partial<ChapterProgress>,
    chapterName?: string,
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
    await this.store.putProgress(key, next);

    // Advancing a read (marking read, or recording a page) makes this the resume/history point.
    if (next.read || patch.lastPage !== undefined) {
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
