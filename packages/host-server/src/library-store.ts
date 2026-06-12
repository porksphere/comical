/**
 * Filesystem-backed `LibraryStore`. Mirrors `SettingsStore`'s style: an in-memory cache with
 * write-through to JSON under `{dir}/`:
 *
 *   {dir}/entries.json                  → { [entryKey]: LibraryEntry }
 *   {dir}/lists.json                    → LibraryList[]
 *   {dir}/progress/{encoded-key}.json   → { [chapterId]: ChapterProgress }
 *
 * Single-user, local scale: small files, full read/parse on first touch, then cached.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activityKey, type ActivityItem, type BridgePrefs, type ChapterProgress, type HistoryItem, type LibraryEntry, type LibraryList, type LibraryStore, type SeriesGroup, type TrackerLink } from "@comical/library";

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export class FileLibraryStore implements LibraryStore {
  private entriesCache?: Map<string, LibraryEntry>;
  private listsCache?: LibraryList[];
  private groupsCache?: Map<string, SeriesGroup>;
  private progressCache = new Map<string, Map<string, ChapterProgress>>();
  private trackerLinksCache?: Map<string, TrackerLink[]>;
  private readingLogCache?: Map<string, HistoryItem>;
  private bridgePrefsCache?: Map<string, BridgePrefs>;
  private activityCache?: Map<string, ActivityItem>;

  constructor(private readonly dir: string) {}

  private get entriesPath(): string {
    return join(this.dir, "entries.json");
  }
  private get listsPath(): string {
    return join(this.dir, "lists.json");
  }
  private get groupsPath(): string {
    return join(this.dir, "groups.json");
  }
  private get trackerLinksPath(): string {
    return join(this.dir, "tracker-links.json");
  }
  private get readingLogPath(): string {
    return join(this.dir, "reading-log.json");
  }
  private get bridgePrefsPath(): string {
    return join(this.dir, "bridge-prefs.json");
  }
  private get activityPath(): string {
    return join(this.dir, "activity.json");
  }
  private progressPath(key: string): string {
    return join(this.dir, "progress", `${encodeURIComponent(key)}.json`);
  }

  // ── Entries ──────────────────────────────────────────────────────────────────

  private async entries(): Promise<Map<string, LibraryEntry>> {
    if (!this.entriesCache) {
      const obj = await readJson<Record<string, LibraryEntry & { categoryIds?: unknown }>>(this.entriesPath, {});
      // One-time migration: entries written before the "categories → lists" rename carry
      // `categoryIds` and no `listIds`. Give them an empty `listIds` (memberships are dropped — the
      // list ids were regenerated) and drop the stale field, persisting the fix so it runs once.
      let migrated = false;
      for (const entry of Object.values(obj)) {
        if (entry.listIds === undefined || "categoryIds" in entry) {
          entry.listIds ??= [];
          delete entry.categoryIds;
          migrated = true;
        }
      }
      this.entriesCache = new Map(Object.entries(obj));
      if (migrated) await this.flushEntries();
    }
    return this.entriesCache;
  }

  private async flushEntries(): Promise<void> {
    const obj = Object.fromEntries((await this.entries()).entries());
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.entriesPath, JSON.stringify(obj, null, 2), "utf8");
  }

  async listEntries(): Promise<LibraryEntry[]> {
    return [...(await this.entries()).values()];
  }
  async getEntry(key: string): Promise<LibraryEntry | undefined> {
    return (await this.entries()).get(key);
  }
  async putEntry(entry: LibraryEntry): Promise<void> {
    (await this.entries()).set(`${entry.bridgeId}:${entry.seriesId}`, entry);
    await this.flushEntries();
  }
  async deleteEntry(key: string): Promise<void> {
    if ((await this.entries()).delete(key)) await this.flushEntries();
  }

  // ── Progress ───────────────────────────────────────────────────────────────────

  private async progress(key: string): Promise<Map<string, ChapterProgress>> {
    let map = this.progressCache.get(key);
    if (!map) {
      const obj = await readJson<Record<string, ChapterProgress>>(this.progressPath(key), {});
      map = new Map(Object.entries(obj));
      this.progressCache.set(key, map);
    }
    return map;
  }

  private async flushProgress(key: string): Promise<void> {
    const obj = Object.fromEntries((await this.progress(key)).entries());
    await mkdir(join(this.dir, "progress"), { recursive: true });
    await writeFile(this.progressPath(key), JSON.stringify(obj, null, 2), "utf8");
  }

  async listProgress(key: string): Promise<ChapterProgress[]> {
    return [...(await this.progress(key)).values()];
  }
  async putProgress(key: string, progress: ChapterProgress): Promise<void> {
    (await this.progress(key)).set(progress.chapterId, progress);
    await this.flushProgress(key);
  }
  async deleteProgressForEntry(key: string): Promise<void> {
    this.progressCache.set(key, new Map());
    await this.flushProgress(key);
  }

  // ── Lists ────────────────────────────────────────────────────────────────────────

  private async lists(): Promise<LibraryList[]> {
    if (!this.listsCache) {
      this.listsCache = await readJson<LibraryList[]>(this.listsPath, []);
    }
    return this.listsCache;
  }

  private async flushLists(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.listsPath, JSON.stringify(await this.lists(), null, 2), "utf8");
  }

  async listLists(): Promise<LibraryList[]> {
    return [...(await this.lists())];
  }
  async putList(list: LibraryList): Promise<void> {
    const lists = await this.lists();
    const idx = lists.findIndex((c) => c.id === list.id);
    if (idx === -1) lists.push(list);
    else lists[idx] = list;
    await this.flushLists();
  }
  async deleteList(id: string): Promise<void> {
    this.listsCache = (await this.lists()).filter((c) => c.id !== id);
    await this.flushLists();
  }

  // ── Groups ───────────────────────────────────────────────────────────────────────

  private async groups(): Promise<Map<string, SeriesGroup>> {
    if (!this.groupsCache) {
      const obj = await readJson<Record<string, SeriesGroup>>(this.groupsPath, {});
      this.groupsCache = new Map(Object.entries(obj));
    }
    return this.groupsCache;
  }

  private async flushGroups(): Promise<void> {
    const obj = Object.fromEntries((await this.groups()).entries());
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.groupsPath, JSON.stringify(obj, null, 2), "utf8");
  }

  async listGroups(): Promise<SeriesGroup[]> {
    return [...(await this.groups()).values()];
  }
  async putGroup(group: SeriesGroup): Promise<void> {
    (await this.groups()).set(group.id, group);
    await this.flushGroups();
  }
  async deleteGroup(id: string): Promise<void> {
    if ((await this.groups()).delete(id)) await this.flushGroups();
  }

  // ── Tracker links ─────────────────────────────────────────────────────────────

  private async trackerLinks(): Promise<Map<string, TrackerLink[]>> {
    if (!this.trackerLinksCache) {
      const obj = await readJson<Record<string, TrackerLink[]>>(this.trackerLinksPath, {});
      this.trackerLinksCache = new Map(Object.entries(obj));
    }
    return this.trackerLinksCache;
  }

  private async flushTrackerLinks(): Promise<void> {
    const obj = Object.fromEntries((await this.trackerLinks()).entries());
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.trackerLinksPath, JSON.stringify(obj, null, 2), "utf8");
  }

  async listTrackerLinks(key: string): Promise<TrackerLink[]> {
    return (await this.trackerLinks()).get(key) ?? [];
  }
  async putTrackerLink(key: string, link: TrackerLink): Promise<void> {
    const map = await this.trackerLinks();
    const existing = map.get(key) ?? [];
    const idx = existing.findIndex((l) => l.trackerId === link.trackerId);
    if (idx === -1) existing.push(link);
    else existing[idx] = link;
    map.set(key, existing);
    await this.flushTrackerLinks();
  }
  async deleteTrackerLink(key: string, trackerId: string): Promise<void> {
    const map = await this.trackerLinks();
    const existing = map.get(key);
    if (!existing) return;
    const next = existing.filter((l) => l.trackerId !== trackerId);
    if (next.length === existing.length) return;
    if (next.length === 0) map.delete(key);
    else map.set(key, next);
    await this.flushTrackerLinks();
  }

  // ── Reading log ───────────────────────────────────────────────────────────────

  private async readingLog(): Promise<Map<string, HistoryItem>> {
    if (!this.readingLogCache) {
      const obj = await readJson<Record<string, HistoryItem>>(this.readingLogPath, {});
      this.readingLogCache = new Map(Object.entries(obj));
    }
    return this.readingLogCache;
  }

  private async flushReadingLog(): Promise<void> {
    const obj = Object.fromEntries((await this.readingLog()).entries());
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.readingLogPath, JSON.stringify(obj, null, 2), "utf8");
  }

  async listReadingLog(): Promise<HistoryItem[]> {
    return [...(await this.readingLog()).values()];
  }
  async upsertReadingLog(item: HistoryItem): Promise<void> {
    (await this.readingLog()).set(`${item.bridgeId}:${item.seriesId}`, item);
    await this.flushReadingLog();
  }
  async deleteReadingLog(bridgeId: string, seriesId: string): Promise<void> {
    if ((await this.readingLog()).delete(`${bridgeId}:${seriesId}`)) await this.flushReadingLog();
  }

  // ── Bridge preferences ────────────────────────────────────────────────────

  private async bridgePrefs(): Promise<Map<string, BridgePrefs>> {
    if (!this.bridgePrefsCache) {
      const obj = await readJson<Record<string, BridgePrefs>>(this.bridgePrefsPath, {});
      this.bridgePrefsCache = new Map(Object.entries(obj));
    }
    return this.bridgePrefsCache;
  }

  private async flushBridgePrefs(): Promise<void> {
    const obj = Object.fromEntries((await this.bridgePrefs()).entries());
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.bridgePrefsPath, JSON.stringify(obj, null, 2), "utf8");
  }

  async getBridgePrefs(bridgeId: string): Promise<BridgePrefs | undefined> {
    return (await this.bridgePrefs()).get(bridgeId);
  }

  async setBridgePrefs(bridgeId: string, prefs: BridgePrefs): Promise<void> {
    (await this.bridgePrefs()).set(bridgeId, prefs);
    await this.flushBridgePrefs();
  }

  // ── Activity feed ───────────────────────────────────────────────────────────────

  private async activity(): Promise<Map<string, ActivityItem>> {
    if (!this.activityCache) {
      const obj = await readJson<Record<string, ActivityItem>>(this.activityPath, {});
      this.activityCache = new Map(Object.entries(obj));
    }
    return this.activityCache;
  }

  private async flushActivity(): Promise<void> {
    const obj = Object.fromEntries((await this.activity()).entries());
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.activityPath, JSON.stringify(obj, null, 2), "utf8");
  }

  async listActivity(): Promise<ActivityItem[]> {
    return [...(await this.activity()).values()];
  }
  async putActivity(item: ActivityItem): Promise<void> {
    (await this.activity()).set(activityKey(item.bridgeId, item.seriesId, item.chapterId), item);
    await this.flushActivity();
  }
  async deleteActivityForEntry(key: string): Promise<void> {
    const map = await this.activity();
    const prefix = `${key}:`;
    let changed = false;
    for (const k of map.keys()) {
      if (k.startsWith(prefix) && map.delete(k)) changed = true;
    }
    if (changed) await this.flushActivity();
  }
  async clearActivity(): Promise<void> {
    this.activityCache = new Map();
    await this.flushActivity();
  }
}
