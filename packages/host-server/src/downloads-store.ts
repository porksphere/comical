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
 *
 * Like `FileLibraryStore`, every document goes through `@comical/host-bun`'s json-file (corrupt
 * files are moved aside rather than read as empty, writes are atomic and serialized per path).
 */
import { join } from "node:path";
import { asJsonRecord, DELETE_FILE, JsonDoc, jsonMapDoc } from "@comical/host-bun";
import type { DownloadPrefs, DownloadedChapter, DownloadedPage, DownloadedSeries, DownloadsStore } from "@comical/downloads";

export class FileDownloadsStore implements DownloadsStore {
  private readonly seriesDoc: JsonDoc<Map<string, DownloadedSeries>>;
  private readonly chapterDocs = new Map<string, JsonDoc<Map<string, DownloadedChapter> | null>>();
  private readonly pageDocs = new Map<string, JsonDoc<Map<number, DownloadedPage> | null>>();
  private readonly prefsDoc: JsonDoc<DownloadPrefs | null>;

  constructor(private readonly dir: string) {
    this.seriesDoc = jsonMapDoc(join(dir, "series.json"));
    this.prefsDoc = new JsonDoc<DownloadPrefs | null>(join(dir, "prefs.json"), {
      empty: () => null,
      decode: (raw) => asJsonRecord(raw) as unknown as DownloadPrefs,
    });
  }

  // ── Series ─────────────────────────────────────────────────────────────────────

  async listSeries(): Promise<DownloadedSeries[]> {
    return [...(await this.seriesDoc.get()).values()];
  }
  async getSeries(key: string): Promise<DownloadedSeries | undefined> {
    return (await this.seriesDoc.get()).get(key);
  }
  async putSeries(series: DownloadedSeries): Promise<void> {
    await this.seriesDoc.update((map) => map.set(`${series.bridgeId}:${series.seriesId}`, series));
  }
  async deleteSeries(key: string): Promise<void> {
    if ((await this.seriesDoc.get()).delete(key)) await this.seriesDoc.flush();
  }

  // ── Chapters ───────────────────────────────────────────────────────────────────
  // `null` is "deleted": the doc's flush removes the file, through the same per-path queue as its
  // writes, so a delete can't race a still-pending write of the old contents.

  private chapterDoc(key: string): JsonDoc<Map<string, DownloadedChapter> | null> {
    let doc = this.chapterDocs.get(key);
    if (!doc) {
      doc = new JsonDoc<Map<string, DownloadedChapter> | null>(join(this.dir, "chapters", `${encodeURIComponent(key)}.json`), {
        empty: () => new Map(),
        decode: (raw) => new Map(Object.entries(asJsonRecord<DownloadedChapter>(raw))),
        encode: (map) => (map === null ? DELETE_FILE : Object.fromEntries(map)),
      });
      this.chapterDocs.set(key, doc);
    }
    return doc;
  }

  async listChapters(key: string): Promise<DownloadedChapter[]> {
    return [...((await this.chapterDoc(key).get())?.values() ?? [])];
  }
  async getChapter(key: string, chapterId: string): Promise<DownloadedChapter | undefined> {
    return (await this.chapterDoc(key).get())?.get(chapterId);
  }
  async putChapter(chapter: DownloadedChapter): Promise<void> {
    const key = `${chapter.bridgeId}:${chapter.seriesId}`;
    // The first write after a delete starts a fresh document.
    await this.chapterDoc(key).transform((map) => (map ?? new Map()).set(chapter.chapterId, chapter));
  }
  async deleteChapter(key: string, chapterId: string): Promise<void> {
    if (!(await this.chapterDoc(key).get())?.has(chapterId)) return;
    await this.chapterDoc(key).update((map) => map?.delete(chapterId));
  }
  async deleteChaptersForEntry(key: string): Promise<void> {
    await this.chapterDoc(key).replace(null);
  }

  // ── Pages ──────────────────────────────────────────────────────────────────────

  private pageDoc(key: string, chapterId: string): JsonDoc<Map<number, DownloadedPage> | null> {
    const cacheKey = `${key} ${chapterId}`;
    let doc = this.pageDocs.get(cacheKey);
    if (!doc) {
      doc = new JsonDoc<Map<number, DownloadedPage> | null>(join(this.dir, "pages", encodeURIComponent(key), `${encodeURIComponent(chapterId)}.json`), {
        empty: () => new Map(),
        decode: (raw) => new Map(Object.values(asJsonRecord<DownloadedPage>(raw)).map((p) => [p.index, p])),
        encode: (map) => (map === null ? DELETE_FILE : Object.fromEntries([...map.values()].map((p) => [String(p.index), p]))),
      });
      this.pageDocs.set(cacheKey, doc);
    }
    return doc;
  }

  async listPages(key: string, chapterId: string): Promise<DownloadedPage[]> {
    return [...((await this.pageDoc(key, chapterId).get())?.values() ?? [])].sort((a, b) => a.index - b.index);
  }
  async putPage(key: string, chapterId: string, page: DownloadedPage): Promise<void> {
    await this.pageDoc(key, chapterId).transform((map) => (map ?? new Map()).set(page.index, page));
  }
  async deletePagesForChapter(key: string, chapterId: string): Promise<void> {
    await this.pageDoc(key, chapterId).replace(null);
  }

  // ── Preferences ───────────────────────────────────────────────────────────────

  async getPrefs(): Promise<DownloadPrefs | undefined> {
    return (await this.prefsDoc.get()) ?? undefined;
  }

  async setPrefs(prefs: DownloadPrefs): Promise<void> {
    await this.prefsDoc.replace(prefs);
  }
}
