/**
 * Moving one bridge's downloads onto new ids, for a bridge update that changed the ids it gives its
 * series or chapters — the downloads half of `@comical/library`'s `remapLibraryIds`. Only the
 * manifest moves: each page keeps its `file`, which is a path, not an id, so the bytes stay put.
 */
import { entryKey, type DownloadedChapter } from "./models.ts";
import { DIRECT_CHAPTER_ID } from "./paths.ts";
import type { DownloadsStore } from "./store.ts";

/** Old → new ids for one bridge; `chapters` is keyed by the OLD series id. Same shape as the library's. */
export interface IdRemap {
  series: ReadonlyMap<string, string>;
  chapters: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

export interface DownloadsRemapResult {
  /** A chapter mid-download was left on its old id: run the remap again once it settles. */
  deferred: boolean;
  /** Files of a chapter dropped because the same chapter was already downloaded under its new id. */
  files: string[];
}

/** Every downloaded series of `bridgeId`, with its downloaded chapter ids. */
export async function downloadIdReferences(store: DownloadsStore, bridgeId: string): Promise<Map<string, Set<string>>> {
  const refs = new Map<string, Set<string>>();
  for (const series of await store.listSeries()) {
    if (series.bridgeId !== bridgeId) continue;
    const chapters = new Set<string>();
    for (const c of await store.listChapters(entryKey(bridgeId, series.seriesId))) {
      if (c.chapterId !== DIRECT_CHAPTER_ID) chapters.add(c.chapterId);
    }
    refs.set(series.seriesId, chapters);
  }
  return refs;
}

/**
 * Apply `remap` to `bridgeId`'s downloads. A chapter that is `downloading` stays where it is — the
 * engine is writing its pages under the old key — and the result says so.
 */
export async function remapDownloadIds(store: DownloadsStore, bridgeId: string, remap: IdRemap): Promise<DownloadsRemapResult> {
  const result: DownloadsRemapResult = { deferred: false, files: [] };
  for (const s of new Set([...remap.series.keys(), ...remap.chapters.keys()])) {
    const key = entryKey(bridgeId, s);
    const series = await store.getSeries(key);
    if (!series) continue;
    const ns = remap.series.get(s) ?? s;
    const nkey = entryKey(bridgeId, ns);
    const chapterTo = (c: string) => remap.chapters.get(s)?.get(c) ?? c;

    if (nkey !== key && !(await store.getSeries(nkey))) await store.putSeries({ ...series, seriesId: ns });
    let left = 0;
    for (const chapter of await store.listChapters(key)) {
      const nc = chapterTo(chapter.chapterId);
      if (nkey === key && nc === chapter.chapterId) continue;
      if (chapter.state === "downloading") {
        result.deferred = true;
        left++;
        continue;
      }
      await moveChapter(store, chapter, nkey, ns, nc, result.files);
    }
    if (nkey !== key && left === 0 && (await store.listChapters(key)).length === 0) await store.deleteSeries(key);
    await rollUp(store, nkey);
    if (nkey !== key) await rollUp(store, key);
  }
  return result;
}

async function moveChapter(
  store: DownloadsStore,
  chapter: DownloadedChapter,
  nkey: string,
  ns: string,
  nc: string,
  dropped: string[],
): Promise<void> {
  const key = entryKey(chapter.bridgeId, chapter.seriesId);
  const pages = await store.listPages(key, chapter.chapterId);
  const there = await store.getChapter(nkey, nc);
  if (there && there.completedPages >= chapter.completedPages) {
    // Downloaded again under its new id before the migration ran: that copy is at least as far along.
    for (const p of pages) if (p.file) dropped.push(p.file);
  } else {
    if (there) {
      for (const p of await store.listPages(nkey, nc)) if (p.file) dropped.push(p.file);
      await store.deletePagesForChapter(nkey, nc);
    }
    for (const p of pages) await store.putPage(nkey, nc, p);
    await store.putChapter({ ...chapter, seriesId: ns, chapterId: nc });
  }
  await store.deletePagesForChapter(key, chapter.chapterId);
  await store.deleteChapter(key, chapter.chapterId);
}

async function rollUp(store: DownloadsStore, key: string): Promise<void> {
  const series = await store.getSeries(key);
  if (!series) return;
  const chapters = await store.listChapters(key);
  await store.putSeries({ ...series, chapterCount: chapters.length, bytes: chapters.reduce((sum, c) => sum + c.bytes, 0) });
}
