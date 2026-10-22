/**
 * Filesystem-backed `LibraryStore`. Mirrors `SettingsStore`'s style: an in-memory cache with
 * write-through to JSON under `{dir}/`:
 *
 *   {dir}/collection-items/{key}.json     → { [collectionItemId]: CollectionItem }
 *   {dir}/progress/{encoded-key}.json   → { [chapterId]: ChapterProgress }
 *
 * Single-user, local scale: small files, full read/parse on first touch, then cached.
 *
 * Every document goes through `@comical/host-bun`'s json-file: a file that won't parse is moved
 * aside (never read as "empty" and then overwritten), writes are atomic, and writes to one path are
 * serialized. Cached documents are `JsonDoc`s, so concurrent first touches share one load.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { asJsonArray, asJsonRecord, deleteJsonFile, JsonDoc, jsonMapDoc, readJsonFile, writeJsonFile } from "@comical/host-bun";
import { activityKey, entryKey, parseCollectionItemId, type ActivityItem, type BridgePrefs, type CachedChapters, type CachedSeriesDetail, type ChapterProgress, type Collection, type CollectionItem, type CollectionItemScope, type HistoryItem, type LibraryStore, type SeriesGroup, type TrackerLink } from "@comical/library";

export class FileLibraryStore implements LibraryStore {
  private readonly groupsDoc: JsonDoc<Map<string, SeriesGroup>>;
  private readonly progressDocs = new Map<string, JsonDoc<Map<string, ChapterProgress>>>();
  private readonly trackerLinksDoc: JsonDoc<Map<string, TrackerLink[]>>;
  private readonly readingLogDoc: JsonDoc<Map<string, HistoryItem>>;
  private readonly bridgePrefsDoc: JsonDoc<Map<string, BridgePrefs>>;
  private readonly activityDoc: JsonDoc<Map<string, ActivityItem>>;
  private readonly collectionsDoc: JsonDoc<Collection[]>;
  private readonly idMigrationsDoc: JsonDoc<Map<string, string>>;

  constructor(private readonly dir: string) {
    this.idMigrationsDoc = jsonMapDoc(join(dir, "id-migrations.json"));
    this.groupsDoc = jsonMapDoc(join(dir, "groups.json"));
    this.trackerLinksDoc = jsonMapDoc(join(dir, "tracker-links.json"));
    this.readingLogDoc = jsonMapDoc(join(dir, "reading-log.json"));
    this.bridgePrefsDoc = jsonMapDoc(join(dir, "bridge-prefs.json"));
    this.activityDoc = jsonMapDoc(join(dir, "activity.json"));
    this.collectionsDoc = new JsonDoc(join(dir, "collections.json"), { empty: () => [], decode: (raw) => asJsonArray<Collection>(raw) });
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
    return readJsonFile<CachedSeriesDetail | undefined>(this.detailPath(key), undefined, {
      decode: (raw) => asJsonRecord(raw) as unknown as CachedSeriesDetail,
    });
  }
  async putSeriesDetail(key: string, detail: CachedSeriesDetail): Promise<void> {
    await writeJsonFile(this.detailPath(key), detail);
  }
  async deleteSeriesDetail(key: string): Promise<void> {
    await deleteJsonFile(this.detailPath(key));
  }
  async getCachedChapters(key: string): Promise<CachedChapters | undefined> {
    return readJsonFile<CachedChapters | undefined>(this.cachedChaptersPath(key), undefined, {
      decode: (raw) => asJsonRecord(raw) as unknown as CachedChapters,
    });
  }
  async putCachedChapters(key: string, doc: CachedChapters): Promise<void> {
    await writeJsonFile(this.cachedChaptersPath(key), doc);
  }
  async deleteCachedChapters(key: string): Promise<void> {
    await deleteJsonFile(this.cachedChaptersPath(key));
  }

  // ── Progress ───────────────────────────────────────────────────────────────────

  private progressDoc(key: string): JsonDoc<Map<string, ChapterProgress>> {
    let doc = this.progressDocs.get(key);
    if (!doc) {
      doc = jsonMapDoc(this.progressPath(key));
      this.progressDocs.set(key, doc);
    }
    return doc;
  }

  async listProgress(key: string): Promise<ChapterProgress[]> {
    return [...(await this.progressDoc(key).get()).values()];
  }
  async listProgressKeys(): Promise<string[]> {
    const files = await readdir(join(this.dir, "progress")).catch(() => [] as string[]);
    return files.filter((f) => f.endsWith(".json")).map((f) => decodeURIComponent(f.slice(0, -".json".length)));
  }
  async putProgress(key: string, progress: ChapterProgress): Promise<void> {
    await this.progressDoc(key).update((map) => map.set(progress.chapterId, progress));
  }
  async deleteProgressForEntry(key: string): Promise<void> {
    await this.progressDoc(key).replace(new Map());
  }
  async deleteProgress(key: string, chapterIds: string[]): Promise<void> {
    const current = await this.progressDoc(key).get();
    if (!chapterIds.some((id) => current.has(id))) return;
    await this.progressDoc(key).update((map) => {
      for (const id of chapterIds) map.delete(id);
    });
  }

  // ── Groups ───────────────────────────────────────────────────────────────────────

  async listGroups(): Promise<SeriesGroup[]> {
    return [...(await this.groupsDoc.get()).values()];
  }
  async putGroup(group: SeriesGroup): Promise<void> {
    await this.groupsDoc.update((map) => map.set(group.id, group));
  }
  async deleteGroup(id: string): Promise<void> {
    if ((await this.groupsDoc.get()).delete(id)) await this.groupsDoc.flush();
  }

  // ── Collection items (series / chapter / page) ────────────────────────────────
  // Sharded per series (`collection-items/{bridge:series}.json`), the same shape `progress/` and
  // `details/` already use here — and for the same reason. Items are the one data set with no
  // natural ceiling, and every flush rewrites a whole document: as ONE document, opening a chapter
  // of a heavily-collected library re-serialized every item the user had. Sharded, a write
  // costs one series' items no matter how many the library holds, and the reader's paths
  // (chapter open, reconcile) are naturally scoped to a single shard. A series ANCHOR lives in its
  // own series' shard, so the layout covers all three item types.

  private itemShards = new Map<string, JsonDoc<Map<string, CollectionItem>>>();
  /** Set once every shard has been read, so an unscoped listing doesn't re-scan the directory. */
  private allItemShardsLoaded = false;

  private get itemsDir(): string {
    return join(this.dir, "collection-items");
  }
  /** Which shard an item belongs to. Derivable from the id alone (every coord type carries
   *  bridge+series), which is what lets `getCollectionItem` be a keyed lookup rather than a scan. */
  private static itemShardOf(item: { bridgeId: string; seriesId: string }): string {
    return entryKey(item.bridgeId, item.seriesId);
  }

  // An emptied shard is deleted rather than written as `{}` — decided when its flush RUNS, so a
  // delete queued behind a re-add can't remove the re-added item.
  private itemShardDoc(shard: string): JsonDoc<Map<string, CollectionItem>> {
    let doc = this.itemShards.get(shard);
    if (!doc) {
      doc = jsonMapDoc(join(this.itemsDir, `${encodeURIComponent(shard)}.json`), { deleteWhenEmpty: true });
      this.itemShards.set(shard, doc);
    }
    return doc;
  }

  private itemShard(shard: string): Promise<Map<string, CollectionItem>> {
    return this.itemShardDoc(shard).get();
  }

  /** Load every shard — only for genuinely cross-series work (the full grid, a collection cascade). */
  private async allItemShards(): Promise<Map<string, CollectionItem>[]> {
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
    return Promise.all([...this.itemShards.values()].map((doc) => doc.get()));
  }

  async listCollectionItems(scope?: CollectionItemScope): Promise<CollectionItem[]> {
    // A bridge+series scope names exactly one shard — the whole point of the layout. Anything
    // broader has to consider every series.
    const shards =
      scope?.bridgeId !== undefined && scope.seriesId !== undefined
        ? [await this.itemShard(entryKey(scope.bridgeId, scope.seriesId))]
        : await this.allItemShards();
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
    for (const shard of touched) await this.itemShardDoc(shard).flush();
  }

  async deleteCollectionItems(ids: string[]): Promise<void> {
    const touched = new Set<string>();
    for (const id of ids) {
      const coord = parseCollectionItemId(id);
      if (!coord) continue;
      const shard = FileLibraryStore.itemShardOf(coord);
      if ((await this.itemShard(shard)).delete(id)) touched.add(shard);
    }
    for (const shard of touched) await this.itemShardDoc(shard).flush();
  }

  async listCollections(): Promise<Collection[]> {
    return [...(await this.collectionsDoc.get())];
  }
  async updateCollections(next: (current: Collection[]) => Collection[]): Promise<void> {
    await this.collectionsDoc.transform((current) => [...next([...current])]);
  }

  // ── Tracker links ─────────────────────────────────────────────────────────────

  async listTrackerLinks(key: string): Promise<TrackerLink[]> {
    return (await this.trackerLinksDoc.get()).get(key) ?? [];
  }
  async putTrackerLink(key: string, link: TrackerLink): Promise<void> {
    await this.trackerLinksDoc.update((map) => {
      const existing = map.get(key) ?? [];
      const idx = existing.findIndex((l) => l.trackerId === link.trackerId);
      if (idx === -1) existing.push(link);
      else existing[idx] = link;
      map.set(key, existing);
    });
  }
  async deleteTrackerLink(key: string, trackerId: string): Promise<void> {
    const map = await this.trackerLinksDoc.get();
    const existing = map.get(key);
    if (!existing) return;
    const next = existing.filter((l) => l.trackerId !== trackerId);
    if (next.length === existing.length) return;
    if (next.length === 0) map.delete(key);
    else map.set(key, next);
    await this.trackerLinksDoc.flush();
  }

  // ── Reading log ───────────────────────────────────────────────────────────────

  async listReadingLog(): Promise<HistoryItem[]> {
    return [...(await this.readingLogDoc.get()).values()];
  }
  async upsertReadingLog(item: HistoryItem): Promise<void> {
    await this.readingLogDoc.update((map) => map.set(`${item.bridgeId}:${item.seriesId}`, item));
  }
  async deleteReadingLog(bridgeId: string, seriesId: string): Promise<void> {
    if ((await this.readingLogDoc.get()).delete(`${bridgeId}:${seriesId}`)) await this.readingLogDoc.flush();
  }

  // ── Bridge preferences ────────────────────────────────────────────────────

  async getBridgePrefs(bridgeId: string): Promise<BridgePrefs | undefined> {
    return (await this.bridgePrefsDoc.get()).get(bridgeId);
  }

  async listBridgePrefs(): Promise<BridgePrefs[]> {
    return [...(await this.bridgePrefsDoc.get()).values()];
  }

  async setBridgePrefs(bridgeId: string, prefs: BridgePrefs): Promise<void> {
    await this.bridgePrefsDoc.update((map) => map.set(bridgeId, prefs));
  }

  // ── Activity feed ───────────────────────────────────────────────────────────────

  async listActivity(): Promise<ActivityItem[]> {
    return [...(await this.activityDoc.get()).values()];
  }
  // `clearActivity` swaps the whole map, so every other write goes through `update` (which mutates
  // the CURRENT map) after a read-only check that skips the write when nothing would change.
  async putActivity(item: ActivityItem): Promise<boolean> {
    const key = activityKey(item.bridgeId, item.seriesId, item.chapterId);
    if ((await this.activityDoc.get()).has(key)) return false;
    return this.activityDoc.update((map) => {
      if (map.has(key)) return false;
      map.set(key, item);
      return true;
    });
  }
  async deleteActivityForEntry(key: string): Promise<void> {
    const prefix = `${key}:`;
    if (![...(await this.activityDoc.get()).keys()].some((k) => k.startsWith(prefix))) return;
    await this.activityDoc.update((map) => {
      for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k);
    });
  }
  async clearActivity(): Promise<void> {
    await this.activityDoc.replace(new Map());
  }
  async dropActivity(keys: string[]): Promise<void> {
    const current = await this.activityDoc.get();
    if (!keys.some((k) => current.has(k))) return;
    await this.activityDoc.update((map) => {
      for (const k of keys) map.delete(k);
    });
  }

  // ── Id migration marks ──────────────────────────────────────────────────────

  async getIdMigrationMark(bridgeId: string): Promise<string | undefined> {
    return (await this.idMigrationsDoc.get()).get(bridgeId);
  }
  async setIdMigrationMark(bridgeId: string, version: string): Promise<void> {
    await this.idMigrationsDoc.update((map) => map.set(bridgeId, version));
  }
  async clearIdMigrationMarks(): Promise<void> {
    await this.idMigrationsDoc.replace(new Map());
  }
}
