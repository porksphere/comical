/**
 * Filesystem-backed `DownloadsStore`. Mirrors `FileLibraryStore`'s style: an in-memory cache with
 * write-through to JSON under `{dir}/`:
 *
 *   {dir}/series.json                        → { [entryKey]: DownloadedSeries }
 *   {dir}/chapters/{encoded-key}.json        → { [chapterId]: DownloadedChapter }
 *   {dir}/pages/{encoded-key}/{chapterId}.json → { [index]: DownloadedPage }
 *   {dir}/prefs.json                         → DownloadPrefs
 *
 * This persists only the download MANIFEST — the image bytes themselves are the caller's concern
 * (host-server does not fetch or serve page bytes; a host that does writes them wherever it likes and
 * records the relative `file` path here). Single-user, local scale: small files, full read/parse on
 * first touch, then cached.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DownloadPrefs, DownloadedChapter, DownloadedPage, DownloadedSeries, DownloadsStore } from "@comical/downloads";

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export class FileDownloadsStore implements DownloadsStore {
  private seriesCache?: Map<string, DownloadedSeries>;
  private chaptersCache = new Map<string, Map<string, DownloadedChapter>>();
  private pagesCache = new Map<string, Map<number, DownloadedPage>>();
  private prefsCache?: DownloadPrefs | null;

  constructor(private readonly dir: string) {}

  private get seriesPath(): string {
    return join(this.dir, "series.json");
  }
  private get prefsPath(): string {
    return join(this.dir, "prefs.json");
  }
  private chaptersPath(key: string): string {
    return join(this.dir, "chapters", `${encodeURIComponent(key)}.json`);
  }
  private pagesPath(key: string, chapterId: string): string {
    return join(this.dir, "pages", encodeURIComponent(key), `${encodeURIComponent(chapterId)}.json`);
  }
  private pagesCacheKey(key: string, chapterId: string): string {
    return `${key} ${chapterId}`;
  }

  // ── Series ─────────────────────────────────────────────────────────────────────

  private async series(): Promise<Map<string, DownloadedSeries>> {
    if (!this.seriesCache) {
      const obj = await readJson<Record<string, DownloadedSeries>>(this.seriesPath, {});
      this.seriesCache = new Map(Object.entries(obj));
    }
    return this.seriesCache;
  }

  private async flushSeries(): Promise<void> {
    const obj = Object.fromEntries((await this.series()).entries());
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.seriesPath, JSON.stringify(obj, null, 2), "utf8");
  }

  async listSeries(): Promise<DownloadedSeries[]> {
    return [...(await this.series()).values()];
  }
  async getSeries(key: string): Promise<DownloadedSeries | undefined> {
    return (await this.series()).get(key);
  }
  async putSeries(series: DownloadedSeries): Promise<void> {
    (await this.series()).set(`${series.bridgeId}:${series.seriesId}`, series);
    await this.flushSeries();
  }
  async deleteSeries(key: string): Promise<void> {
    if ((await this.series()).delete(key)) await this.flushSeries();
  }

  // ── Chapters ───────────────────────────────────────────────────────────────────

  private async chapters(key: string): Promise<Map<string, DownloadedChapter>> {
    let map = this.chaptersCache.get(key);
    if (!map) {
      const obj = await readJson<Record<string, DownloadedChapter>>(this.chaptersPath(key), {});
      map = new Map(Object.entries(obj));
      this.chaptersCache.set(key, map);
    }
    return map;
  }

  private async flushChapters(key: string): Promise<void> {
    const obj = Object.fromEntries((await this.chapters(key)).entries());
    await mkdir(join(this.dir, "chapters"), { recursive: true });
    await writeFile(this.chaptersPath(key), JSON.stringify(obj, null, 2), "utf8");
  }

  async listChapters(key: string): Promise<DownloadedChapter[]> {
    return [...(await this.chapters(key)).values()];
  }
  async getChapter(key: string, chapterId: string): Promise<DownloadedChapter | undefined> {
    return (await this.chapters(key)).get(chapterId);
  }
  async putChapter(chapter: DownloadedChapter): Promise<void> {
    const key = `${chapter.bridgeId}:${chapter.seriesId}`;
    (await this.chapters(key)).set(chapter.chapterId, chapter);
    await this.flushChapters(key);
  }
  async deleteChapter(key: string, chapterId: string): Promise<void> {
    if ((await this.chapters(key)).delete(chapterId)) await this.flushChapters(key);
  }
  async deleteChaptersForEntry(key: string): Promise<void> {
    this.chaptersCache.set(key, new Map());
    await rm(this.chaptersPath(key), { force: true });
  }

  // ── Pages ──────────────────────────────────────────────────────────────────────

  private async pages(key: string, chapterId: string): Promise<Map<number, DownloadedPage>> {
    const cacheKey = this.pagesCacheKey(key, chapterId);
    let map = this.pagesCache.get(cacheKey);
    if (!map) {
      const obj = await readJson<Record<string, DownloadedPage>>(this.pagesPath(key, chapterId), {});
      map = new Map(Object.values(obj).map((p) => [p.index, p]));
      this.pagesCache.set(cacheKey, map);
    }
    return map;
  }

  private async flushPages(key: string, chapterId: string): Promise<void> {
    const map = await this.pages(key, chapterId);
    const obj = Object.fromEntries([...map.values()].map((p) => [String(p.index), p]));
    await mkdir(join(this.dir, "pages", encodeURIComponent(key)), { recursive: true });
    await writeFile(this.pagesPath(key, chapterId), JSON.stringify(obj, null, 2), "utf8");
  }

  async listPages(key: string, chapterId: string): Promise<DownloadedPage[]> {
    return [...(await this.pages(key, chapterId)).values()].sort((a, b) => a.index - b.index);
  }
  async putPage(key: string, chapterId: string, page: DownloadedPage): Promise<void> {
    (await this.pages(key, chapterId)).set(page.index, page);
    await this.flushPages(key, chapterId);
  }
  async deletePagesForChapter(key: string, chapterId: string): Promise<void> {
    this.pagesCache.set(this.pagesCacheKey(key, chapterId), new Map());
    await rm(this.pagesPath(key, chapterId), { force: true });
  }

  // ── Preferences ───────────────────────────────────────────────────────────────

  async getPrefs(): Promise<DownloadPrefs | undefined> {
    if (this.prefsCache === undefined) {
      this.prefsCache = await readJson<DownloadPrefs | null>(this.prefsPath, null);
    }
    return this.prefsCache ?? undefined;
  }

  async setPrefs(prefs: DownloadPrefs): Promise<void> {
    this.prefsCache = prefs;
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.prefsPath, JSON.stringify(prefs, null, 2), "utf8");
  }
}
