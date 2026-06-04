/**
 * In-memory `LibraryStore` — the portable reference implementation. Used by the test suite and as a
 * fallback for hosts without durable storage. Deep-clones on the way in and out so callers can't
 * mutate stored objects by reference.
 */
import type { Category, ChapterProgress, LibraryEntry, SeriesGroup, TrackerLink } from "./models.ts";
import type { LibraryStore } from "./store.ts";

const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryLibraryStore implements LibraryStore {
  private entries = new Map<string, LibraryEntry>();
  private progress = new Map<string, Map<string, ChapterProgress>>();
  private categories = new Map<string, Category>();
  private groups = new Map<string, SeriesGroup>();
  private trackerLinks = new Map<string, Map<string, TrackerLink>>();

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

  async listCategories(): Promise<Category[]> {
    return [...this.categories.values()].map(clone);
  }
  async putCategory(category: Category): Promise<void> {
    this.categories.set(category.id, clone(category));
  }
  async deleteCategory(id: string): Promise<void> {
    this.categories.delete(id);
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
}

function entryKeyOf(entry: LibraryEntry): string {
  return `${entry.bridgeId}:${entry.seriesId}`;
}
