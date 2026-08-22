/**
 * In-memory `LibraryStore` — the portable reference implementation. Used by the test suite and as a
 * fallback for hosts without durable storage. Deep-clones on the way in and out so callers can't
 * mutate stored objects by reference.
 */
import { activityKey, type ActivityItem, type BridgePrefs, type CachedChapters, type CachedSeriesDetail, type ChapterProgress, type Collection, type CollectionItem, type CollectionItemScope, type HistoryItem, type SeriesGroup, type TrackerLink } from "./models.ts";
import type { LibraryStore } from "./store.ts";

const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryLibraryStore implements LibraryStore {
  private progress = new Map<string, Map<string, ChapterProgress>>();
  private groups = new Map<string, SeriesGroup>();
  private trackerLinks = new Map<string, Map<string, TrackerLink>>();
  private readingLog = new Map<string, HistoryItem>();
  private bridgePrefs = new Map<string, BridgePrefs>();
  private activity = new Map<string, ActivityItem>();
  private details = new Map<string, CachedSeriesDetail>();
  private chaptersCache = new Map<string, CachedChapters>();
  private collectionItems = new Map<string, CollectionItem>();
  private collections: Collection[] = [];

  async getSeriesDetail(key: string): Promise<CachedSeriesDetail | undefined> {
    const d = this.details.get(key);
    return d ? clone(d) : undefined;
  }
  async putSeriesDetail(key: string, detail: CachedSeriesDetail): Promise<void> {
    this.details.set(key, clone(detail));
  }
  async deleteSeriesDetail(key: string): Promise<void> {
    this.details.delete(key);
  }
  async getCachedChapters(key: string): Promise<CachedChapters | undefined> {
    const c = this.chaptersCache.get(key);
    return c ? clone(c) : undefined;
  }
  async putCachedChapters(key: string, doc: CachedChapters): Promise<void> {
    this.chaptersCache.set(key, clone(doc));
  }
  async deleteCachedChapters(key: string): Promise<void> {
    this.chaptersCache.delete(key);
  }

  async listProgress(key: string): Promise<ChapterProgress[]> {
    return [...(this.progress.get(key)?.values() ?? [])].map(clone);
  }
  async putProgress(key: string, progress: ChapterProgress): Promise<void> {
    let map = this.progress.get(key);
    if (!map) this.progress.set(key, (map = new Map()));
    map.set(progress.chapterId, clone(progress));
  }
  async deleteProgressForEntry(key: string): Promise<void> {
    this.progress.delete(key);
  }

  async listGroups(): Promise<SeriesGroup[]> {
    return [...this.groups.values()].map(clone);
  }
  async putGroup(group: SeriesGroup): Promise<void> {
    this.groups.set(group.id, clone(group));
  }
  async deleteGroup(id: string): Promise<void> {
    this.groups.delete(id);
  }

  /** Filters BEFORE cloning: the clone is what makes a full listing expensive, so a scoped call
   *  must not pay for records it is going to discard. */
  async listCollectionItems(scope?: CollectionItemScope): Promise<CollectionItem[]> {
    const out: CollectionItem[] = [];
    for (const item of this.collectionItems.values()) {
      if (scope?.type !== undefined && item.type !== scope.type) continue;
      if (scope?.bridgeId !== undefined && item.bridgeId !== scope.bridgeId) continue;
      if (scope?.seriesId !== undefined && item.seriesId !== scope.seriesId) continue;
      if (scope?.chapterId !== undefined && (item.type === "series" || item.chapterId !== scope.chapterId)) continue;
      out.push(clone(item));
    }
    return out;
  }
  async getCollectionItem(id: string): Promise<CollectionItem | undefined> {
    const item = this.collectionItems.get(id);
    return item ? clone(item) : undefined;
  }
  async putCollectionItems(items: CollectionItem[]): Promise<void> {
    for (const item of items) this.collectionItems.set(item.id, clone(item));
  }
  async deleteCollectionItems(ids: string[]): Promise<void> {
    for (const id of ids) this.collectionItems.delete(id);
  }

  async listCollections(): Promise<Collection[]> {
    return this.collections.map(clone);
  }
  async putCollections(collections: Collection[]): Promise<void> {
    this.collections = collections.map(clone);
  }

  async listTrackerLinks(key: string): Promise<TrackerLink[]> {
    return [...(this.trackerLinks.get(key)?.values() ?? [])].map(clone);
  }
  async putTrackerLink(key: string, link: TrackerLink): Promise<void> {
    let map = this.trackerLinks.get(key);
    if (!map) this.trackerLinks.set(key, (map = new Map()));
    map.set(link.trackerId, clone(link));
  }
  async deleteTrackerLink(key: string, trackerId: string): Promise<void> {
    this.trackerLinks.get(key)?.delete(trackerId);
  }

  async listReadingLog(): Promise<HistoryItem[]> {
    return [...this.readingLog.values()].map(clone);
  }
  async upsertReadingLog(item: HistoryItem): Promise<void> {
    this.readingLog.set(`${item.bridgeId}:${item.seriesId}`, clone(item));
  }
  async deleteReadingLog(bridgeId: string, seriesId: string): Promise<void> {
    this.readingLog.delete(`${bridgeId}:${seriesId}`);
  }

  async getBridgePrefs(bridgeId: string): Promise<BridgePrefs | undefined> {
    const p = this.bridgePrefs.get(bridgeId);
    return p ? clone(p) : undefined;
  }
  async setBridgePrefs(bridgeId: string, prefs: BridgePrefs): Promise<void> {
    this.bridgePrefs.set(bridgeId, clone(prefs));
  }

  async listActivity(): Promise<ActivityItem[]> {
    return [...this.activity.values()].map(clone);
  }
  async putActivity(item: ActivityItem): Promise<void> {
    this.activity.set(activityKey(item.bridgeId, item.seriesId, item.chapterId), clone(item));
  }
  async deleteActivityForEntry(key: string): Promise<void> {
    const prefix = `${key}:`;
    for (const k of this.activity.keys()) {
      if (k.startsWith(prefix)) this.activity.delete(k);
    }
  }
  async clearActivity(): Promise<void> {
    this.activity.clear();
  }
}
