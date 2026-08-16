/**
 * Filesystem-backed `LibraryStore`. Mirrors `SettingsStore`'s style: an in-memory cache with
 * write-through to JSON under `{dir}/`:
 *
 *   {dir}/entries.json                  → { [entryKey]: LibraryEntry }
 *   {dir}/favorite-items/{key}.json     → { [favoriteItemId]: FavoriteItem }
 *   {dir}/progress/{encoded-key}.json   → { [chapterId]: ChapterProgress }
 *
 * Single-user, local scale: small files, full read/parse on first touch, then cached.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activityKey, entryKey, parseFavoriteItemId, type ActivityItem, type BridgePrefs, type CachedChapters, type CachedSeriesDetail, type ChapterProgress, type FavoriteCollection, type FavoriteItem, type FavoriteItemScope, type HistoryItem, type LibraryEntry, type LibraryStore, type SeriesGroup, type TrackerLink } from "@comical/library";

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
  private favoriteCollectionsCache?: FavoriteCollection[];

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
  private get favoriteCollectionsPath(): string {
    return join(this.dir, "favorite-collections.json");
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

  // ── Favorites (series / chapter / page items) ─────────────────────────────────
  // Sharded per series (`favorite-items/{bridge:series}.json`), the same shape `progress/` and
  // `details/` already use here — and for the same reason. Favorites are the one collection with no
  // natural ceiling, and every flush rewrites a whole document: as ONE document, opening a chapter
  // of a heavily-favorited library re-serialized every favorite the user had. Sharded, a write
  // costs one series' favorites no matter how many the library holds, and the reader's paths
  // (chapter open, reconcile) are naturally scoped to a single shard. A series ANCHOR lives in its
  // own series' shard, so the layout covers all three item types.

  private favoriteShards = new Map<string, Map<string, FavoriteItem>>();
  /** Set once every shard has been read, so an unscoped listing doesn't re-scan the directory. */
  private allFavoriteShardsLoaded = false;

  private get favoritesDir(): string {
    return join(this.dir, "favorite-items");
  }
  private favoriteShardPath(shard: string): string {
    return join(this.favoritesDir, `${encodeURIComponent(shard)}.json`);
  }
  /** Which shard an item belongs to. Derivable from the id alone (every coord type carries
   *  bridge+series), which is what lets `getFavoriteItem` be a keyed lookup rather than a scan. */
  private static favoriteShardOf(item: { bridgeId: string; seriesId: string }): string {
    return entryKey(item.bridgeId, item.seriesId);
  }

  private async favoriteShard(shard: string): Promise<Map<string, FavoriteItem>> {
    let map = this.favoriteShards.get(shard);
    if (!map) {
      const obj = await readJson<Record<string, FavoriteItem>>(this.favoriteShardPath(shard), {});
      map = new Map(Object.entries(obj));
      this.favoriteShards.set(shard, map);
    }
    return map;
  }

  /** Load every shard — only for genuinely cross-series work (the full grid, a collection cascade). */
  private async allFavoriteShards(): Promise<Map<string, Map<string, FavoriteItem>>> {
    if (!this.allFavoriteShardsLoaded) {
      let files: string[] = [];
      try {
        files = await readdir(this.favoritesDir);
      } catch {
        files = []; // never written to yet
      }
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        await this.favoriteShard(decodeURIComponent(file.slice(0, -".json".length)));
      }
      this.allFavoriteShardsLoaded = true;
    }
    return this.favoriteShards;
  }

  private async flushFavoriteShard(shard: string): Promise<void> {
    const map = await this.favoriteShard(shard);
    if (map.size === 0) {
      await rm(this.favoriteShardPath(shard), { force: true });
      return;
    }
    await mkdir(this.favoritesDir, { recursive: true });
    await writeFile(this.favoriteShardPath(shard), JSON.stringify(Object.fromEntries(map), null, 2), "utf8");
  }

  async listFavoriteItems(scope?: FavoriteItemScope): Promise<FavoriteItem[]> {
    // A bridge+series scope names exactly one shard — the whole point of the layout. Anything
    // broader has to consider every series.
    const shards =
      scope?.bridgeId !== undefined && scope.seriesId !== undefined
        ? [await this.favoriteShard(entryKey(scope.bridgeId, scope.seriesId))]
        : [...(await this.allFavoriteShards()).values()];
    const out: FavoriteItem[] = [];
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

  async getFavoriteItem(id: string): Promise<FavoriteItem | undefined> {
    const coord = parseFavoriteItemId(id);
    if (!coord) return undefined;
    return (await this.favoriteShard(FileLibraryStore.favoriteShardOf(coord))).get(id);
  }

  /** One flush per SERIES touched — a reconcile repairs a chapter, so that is a single write. */
  async putFavoriteItems(items: FavoriteItem[]): Promise<void> {
    const touched = new Set<string>();
    for (const item of items) {
      const shard = FileLibraryStore.favoriteShardOf(item);
      (await this.favoriteShard(shard)).set(item.id, item);
      touched.add(shard);
    }
    for (const shard of touched) await this.flushFavoriteShard(shard);
  }

  async deleteFavoriteItems(ids: string[]): Promise<void> {
    const touched = new Set<string>();
    for (const id of ids) {
      const coord = parseFavoriteItemId(id);
      if (!coord) continue;
      const shard = FileLibraryStore.favoriteShardOf(coord);
      if ((await this.favoriteShard(shard)).delete(id)) touched.add(shard);
    }
    for (const shard of touched) await this.flushFavoriteShard(shard);
  }

  async listFavoriteCollections(): Promise<FavoriteCollection[]> {
    if (!this.favoriteCollectionsCache) {
      this.favoriteCollectionsCache = await readJson<FavoriteCollection[]>(this.favoriteCollectionsPath, []);
    }
    return [...this.favoriteCollectionsCache];
  }
  async putFavoriteCollections(collections: FavoriteCollection[]): Promise<void> {
    this.favoriteCollectionsCache = [...collections];
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.favoriteCollectionsPath, JSON.stringify(collections, null, 2), "utf8");
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
