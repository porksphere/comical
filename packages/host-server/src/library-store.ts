/**
 * Filesystem-backed `LibraryStore`. Mirrors `SettingsStore`'s style: an in-memory cache with
 * write-through to JSON under `{dir}/`:
 *
 *   {dir}/entries.json                  → { [entryKey]: LibraryEntry }
 *   {dir}/collection-items/{key}.json     → { [collectionItemId]: CollectionItem }
 *   {dir}/progress/{encoded-key}.json   → { [chapterId]: ChapterProgress }
 *
 * Single-user, local scale: small files, full read/parse on first touch, then cached.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activityKey, entryKey, parseCollectionItemId, type ActivityItem, type BridgePrefs, type CachedChapters, type CachedSeriesDetail, type ChapterProgress, type Collection, type CollectionItem, type CollectionItemScope, type HistoryItem, type LibraryEntry, type LibraryStore, type SeriesGroup, type TrackerLink } from "@comical/library";

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export class FileLibraryStore implements LibraryStore {
  private entriesCache?: Map<string, LibraryEntry>;
  private groupsCache?: Map<string, SeriesGroup>;
  private progressCache = new Map<string, Map<string, ChapterProgress>>();
  private trackerLinksCache?: Map<string, TrackerLink[]>;
  private readingLogCache?: Map<string, HistoryItem>;
  private bridgePrefsCache?: Map<string, BridgePrefs>;
  private activityCache?: Map<string, ActivityItem>;
  private collectionsCache?: Collection[];

  constructor(private readonly dir: string) {}

  private get entriesPath(): string {
    return join(this.dir, "entries.json");
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
  private get collectionsPath(): string {
    return join(this.dir, "collections.json");
  }
  private progressPath(key: string): string {
    return join(this.dir, "progress", `${encodeURIComponent(key)}.json`);
  }
  private detailPath(key: string): string {
    return join(this.dir, "details", `${encodeURIComponent(key)}.json`);
  }
  private cachedChaptersPath(key: string): string {
    return join(this.dir, "chapters-cache", `${encodeURIComponent(key)}.json`);
  }

  // ── Entries ──────────────────────────────────────────────────────────────────

  private async entries(): Promise<Map<string, LibraryEntry>> {
    if (!this.entriesCache) {
      // Stray keys from retired schema fields (`categoryIds`, `listIds`) may linger in old
      // documents; they are inert and simply carried, never read.
      const obj = await readJson<Record<string, LibraryEntry>>(this.entriesPath, {});
      this.entriesCache = new Map(Object.entries(obj));
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

  // ── Disk usage ───────────────────────────────────────────────────────────────

  /** Actual bytes under the library dir, EXCLUDING the covers subdir — the covers `BlobStore` is
   *  rooted inside it (`{dir}/covers`) and reports its own usage; counting it here would double. */
  async diskUsage(): Promise<number> {
    let total = 0;
    const walk = async (dir: string, atRoot: boolean): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // dir missing / transient — report what we could see
      }
      for (const entry of entries) {
        if (atRoot && entry.isDirectory() && entry.name === "covers") continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path, false);
        else total += (await stat(path).catch(() => null))?.size ?? 0;
      }
    };
    await walk(this.dir, true);
    return total;
  }

  // ── Offline metadata cache ──────────────────────────────────────────────────
  // One JSON doc per entry (chapter lists are bulky), read lazily on demand — never bulk-loaded.

  async getSeriesDetail(key: string): Promise<CachedSeriesDetail | undefined> {
    return readJson<CachedSeriesDetail | undefined>(this.detailPath(key), undefined);
  }
  async putSeriesDetail(key: string, detail: CachedSeriesDetail): Promise<void> {
    await mkdir(join(this.dir, "details"), { recursive: true });
    await writeFile(this.detailPath(key), JSON.stringify(detail, null, 2), "utf8");
  }
  async deleteSeriesDetail(key: string): Promise<void> {
    await rm(this.detailPath(key), { force: true });
  }
  async getCachedChapters(key: string): Promise<CachedChapters | undefined> {
    return readJson<CachedChapters | undefined>(this.cachedChaptersPath(key), undefined);
  }
  async putCachedChapters(key: string, doc: CachedChapters): Promise<void> {
    await mkdir(join(this.dir, "chapters-cache"), { recursive: true });
    await writeFile(this.cachedChaptersPath(key), JSON.stringify(doc, null, 2), "utf8");
  }
  async deleteCachedChapters(key: string): Promise<void> {
    await rm(this.cachedChaptersPath(key), { force: true });
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

  // ── Collection items (series / chapter / page) ────────────────────────────────
  // Sharded per series (`collection-items/{bridge:series}.json`), the same shape `progress/` and
  // `details/` already use here — and for the same reason. Items are the one data set with no
  // natural ceiling, and every flush rewrites a whole document: as ONE document, opening a chapter
  // of a heavily-collected library re-serialized every item the user had. Sharded, a write
  // costs one series' items no matter how many the library holds, and the reader's paths
  // (chapter open, reconcile) are naturally scoped to a single shard. A series ANCHOR lives in its
  // own series' shard, so the layout covers all three item types.

  private itemShards = new Map<string, Map<string, CollectionItem>>();
  /** Set once every shard has been read, so an unscoped listing doesn't re-scan the directory. */
  private allItemShardsLoaded = false;

  private get itemsDir(): string {
    return join(this.dir, "collection-items");
  }
  private itemShardPath(shard: string): string {
    return join(this.itemsDir, `${encodeURIComponent(shard)}.json`);
  }
  /** Which shard an item belongs to. Derivable from the id alone (every coord type carries
   *  bridge+series), which is what lets `getCollectionItem` be a keyed lookup rather than a scan. */
  private static itemShardOf(item: { bridgeId: string; seriesId: string }): string {
    return entryKey(item.bridgeId, item.seriesId);
  }

  private async itemShard(shard: string): Promise<Map<string, CollectionItem>> {
    let map = this.itemShards.get(shard);
    if (!map) {
      const obj = await readJson<Record<string, CollectionItem>>(this.itemShardPath(shard), {});
      map = new Map(Object.entries(obj));
      this.itemShards.set(shard, map);
    }
    return map;
  }

  /** Load every shard — only for genuinely cross-series work (the full grid, a collection cascade). */
  private async allItemShards(): Promise<Map<string, Map<string, CollectionItem>>> {
    if (!this.allItemShardsLoaded) {
      let files: string[] = [];
      try {
        files = await readdir(this.itemsDir);
      } catch {
        files = []; // never written to yet
      }
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        await this.itemShard(decodeURIComponent(file.slice(0, -".json".length)));
      }
      this.allItemShardsLoaded = true;
    }
    return this.itemShards;
  }

  private async flushFavoriteShard(shard: string): Promise<void> {
    const map = await this.itemShard(shard);
    if (map.size === 0) {
      await rm(this.itemShardPath(shard), { force: true });
      return;
    }
    await mkdir(this.itemsDir, { recursive: true });
    await writeFile(this.itemShardPath(shard), JSON.stringify(Object.fromEntries(map), null, 2), "utf8");
  }

  async listCollectionItems(scope?: CollectionItemScope): Promise<CollectionItem[]> {
    // A bridge+series scope names exactly one shard — the whole point of the layout. Anything
    // broader has to consider every series.
    const shards =
      scope?.bridgeId !== undefined && scope.seriesId !== undefined
        ? [await this.itemShard(entryKey(scope.bridgeId, scope.seriesId))]
        : [...(await this.allItemShards()).values()];
    const out: CollectionItem[] = [];
    for (const map of shards) {
      for (const item of map.values()) {
        if (scope?.type !== undefined && item.type !== scope.type) continue;
        if (scope?.bridgeId !== undefined && item.bridgeId !== scope.bridgeId) continue;
        if (scope?.seriesId !== undefined && item.seriesId !== scope.seriesId) continue;
        if (scope?.chapterId !== undefined && (item.type === "series" || item.chapterId !== scope.chapterId)) continue;
        out.push(item);
      }
    }
    return out;
  }

  async getCollectionItem(id: string): Promise<CollectionItem | undefined> {
    const coord = parseCollectionItemId(id);
    if (!coord) return undefined;
    return (await this.itemShard(FileLibraryStore.itemShardOf(coord))).get(id);
  }

  /** One flush per SERIES touched — a reconcile repairs a chapter, so that is a single write. */
  async putCollectionItems(items: CollectionItem[]): Promise<void> {
    const touched = new Set<string>();
    for (const item of items) {
      const shard = FileLibraryStore.itemShardOf(item);
      (await this.itemShard(shard)).set(item.id, item);
      touched.add(shard);
    }
    for (const shard of touched) await this.flushFavoriteShard(shard);
  }

  async deleteCollectionItems(ids: string[]): Promise<void> {
    const touched = new Set<string>();
    for (const id of ids) {
      const coord = parseCollectionItemId(id);
      if (!coord) continue;
      const shard = FileLibraryStore.itemShardOf(coord);
      if ((await this.itemShard(shard)).delete(id)) touched.add(shard);
    }
    for (const shard of touched) await this.flushFavoriteShard(shard);
  }

  async listCollections(): Promise<Collection[]> {
    if (!this.collectionsCache) {
      this.collectionsCache = await readJson<Collection[]>(this.collectionsPath, []);
    }
    return [...this.collectionsCache];
  }
  async putCollections(collections: Collection[]): Promise<void> {
    this.collectionsCache = [...collections];
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.collectionsPath, JSON.stringify(collections, null, 2), "utf8");
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
