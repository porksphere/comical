/**
 * Filesystem-backed `LibraryStore`. Mirrors `SettingsStore`'s style: an in-memory cache with
 * write-through to JSON under `{dir}/`:
 *
 *   {dir}/entries.json                  → { [entryKey]: LibraryEntry }
 *   {dir}/categories.json               → Category[]
 *   {dir}/progress/{encoded-key}.json   → { [chapterId]: ChapterProgress }
 *
 * Single-user, local scale: small files, full read/parse on first touch, then cached.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Category, ChapterProgress, LibraryEntry, LibraryStore, SeriesGroup } from "@comical/library";

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export class FileLibraryStore implements LibraryStore {
  private entriesCache?: Map<string, LibraryEntry>;
  private categoriesCache?: Category[];
  private groupsCache?: Map<string, SeriesGroup>;
  private progressCache = new Map<string, Map<string, ChapterProgress>>();

  constructor(private readonly dir: string) {}

  private get entriesPath(): string {
    return join(this.dir, "entries.json");
  }
  private get categoriesPath(): string {
    return join(this.dir, "categories.json");
  }
  private get groupsPath(): string {
    return join(this.dir, "groups.json");
  }
  private progressPath(key: string): string {
    return join(this.dir, "progress", `${encodeURIComponent(key)}.json`);
  }

  // ── Entries ──────────────────────────────────────────────────────────────────

  private async entries(): Promise<Map<string, LibraryEntry>> {
    if (!this.entriesCache) {
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

  // ── Categories ───────────────────────────────────────────────────────────────────

  private async categories(): Promise<Category[]> {
    if (!this.categoriesCache) {
      this.categoriesCache = await readJson<Category[]>(this.categoriesPath, []);
    }
    return this.categoriesCache;
  }

  private async flushCategories(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.categoriesPath, JSON.stringify(await this.categories(), null, 2), "utf8");
  }

  async listCategories(): Promise<Category[]> {
    return [...(await this.categories())];
  }
  async putCategory(category: Category): Promise<void> {
    const cats = await this.categories();
    const idx = cats.findIndex((c) => c.id === category.id);
    if (idx === -1) cats.push(category);
    else cats[idx] = category;
    await this.flushCategories();
  }
  async deleteCategory(id: string): Promise<void> {
    this.categoriesCache = (await this.categories()).filter((c) => c.id !== id);
    await this.flushCategories();
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
}
