/**
 * In-memory `LibraryStore` — the portable reference implementation. Used by the test suite and as a
 * fallback for hosts without durable storage. Deep-clones on the way in and out so callers can't
 * mutate stored objects by reference.
 */
import { activityKey, type ActivityItem, type BridgePrefs, type ChapterProgress, type HistoryItem, type KnownChapter, type LibraryEntry, type LibraryList, type SeriesGroup, type TrackerLink } from "./models.ts";
import type { LibraryStore } from "./store.ts";

const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryLibraryStore implements LibraryStore {
  private entries = new Map<string, LibraryEntry>();
  private chapters = new Map<string, KnownChapter[]>();
  private progress = new Map<string, Map<string, ChapterProgress>>();
  private lists = new Map<string, LibraryList>();
  private groups = new Map<string, SeriesGroup>();
  private trackerLinks = new Map<string, Map<string, TrackerLink>>();
  private readingLog = new Map<string, HistoryItem>();
  private bridgePrefs = new Map<string, BridgePrefs>();
  private activity = new Map<string, ActivityItem>();

  async listEntries(): Promise<LibraryEntry[]> {
    return [...this.entries.values()].map(clone);
  }
  async getEntry(key: string): Promise<LibraryEntry | undefined> {
    const e = this.entries.get(key);
    return e ? clone(e) : undefined;
  }
  async putEntry(entry: LibraryEntry): Promise<void> {
    this.entries.set(entryKeyOf(entry), clone(entry));
  }
  async deleteEntry(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async listChapters(key: string): Promise<KnownChapter[]> {
    return (this.chapters.get(key) ?? []).map(clone);
  }
  async putChapters(key: string, chapters: KnownChapter[]): Promise<void> {
    this.chapters.set(key, chapters.map(clone));
  }
  async deleteChaptersForEntry(key: string): Promise<void> {
    this.chapters.delete(key);
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

  async listLists(): Promise<LibraryList[]> {
    return [...this.lists.values()].map(clone);
  }
  async putList(list: LibraryList): Promise<void> {
    this.lists.set(list.id, clone(list));
  }
  async deleteList(id: string): Promise<void> {
    this.lists.delete(id);
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

function entryKeyOf(entry: LibraryEntry): string {
  return `${entry.bridgeId}:${entry.seriesId}`;
}
