/** Id migrations for downloads: moving a bridge's manifest onto new ids, with the bytes left in place. */
import { describe, expect, test } from "bun:test";
import { Downloads, entryKey, InMemoryDownloadsStore, type DownloadPageInput, type IdRemap } from "../src/index.ts";

const OLD = entryKey("demo", "old");
const NEW = entryKey("demo", "new");

function fakeClock() {
  let t = 1_000;
  return () => ++t;
}

function makeDownloads() {
  return new Downloads(new InMemoryDownloadsStore(), { now: fakeClock() });
}

function pages(n: number): DownloadPageInput[] {
  return Array.from({ length: n }, (_, i) => ({ index: i, sourceUrl: `/img/${i}` }));
}

/** Download `done` of `n` pages of `chapterId` in `seriesId`, each written to a file named after both. */
async function download(dl: Downloads, seriesId: string, chapterId: string, n: number, done = n) {
  await dl.enqueueChapter({ bridgeId: "demo", seriesId, title: "T" }, { chapterId }, pages(n));
  for (let i = 0; i < done; i++) await dl.recordPage(entryKey("demo", seriesId), chapterId, i, `${seriesId}/${chapterId}/${i}`, 10);
}

function remap(series: Record<string, string>, chapters: Record<string, Record<string, string>> = {}): IdRemap {
  return {
    series: new Map(Object.entries(series)),
    chapters: new Map(Object.entries(chapters).map(([s, m]) => [s, new Map(Object.entries(m))])),
  };
}

describe("idReferences", () => {
  test("lists the bridge's downloaded series with their chapters", async () => {
    const dl = makeDownloads();
    await download(dl, "old", "c1", 1);
    await download(dl, "old", "c2", 1);
    await dl.enqueueChapter({ bridgeId: "other", seriesId: "x", title: "X" }, { chapterId: "y" }, pages(1));

    const refs = await dl.idReferences("demo");
    expect([...refs.keys()]).toEqual(["old"]);
    expect([...refs.get("old")!].sort()).toEqual(["c1", "c2"]);
  });
});

describe("remapIds", () => {
  test("moves series and chapters, keeping each page's file", async () => {
    const dl = makeDownloads();
    await download(dl, "old", "c1", 2);

    const result = await dl.remapIds("demo", remap({ old: "new" }, { old: { c1: "n1" } }));

    expect(result).toEqual({ deferred: false, files: [] });
    expect(await dl.getSeries(OLD)).toBeUndefined();
    expect((await dl.getSeries(NEW))?.chapterCount).toBe(1);
    const chapter = await dl.getChapter(NEW, "n1");
    expect(chapter?.state).toBe("complete");
    expect((await dl.getManifestPages(NEW, "n1")).map((p) => p.file)).toEqual(["old/c1/0", "old/c1/1"]);
    expect(await dl.getManifestPages(OLD, "c1")).toHaveLength(0);
  });

  test("a chapter mid-download stays on its old id and the result says to run again", async () => {
    const dl = makeDownloads();
    await download(dl, "old", "c1", 1);
    await download(dl, "old", "c2", 3, 1);
    expect((await dl.getChapter(OLD, "c2"))?.state).toBe("downloading");

    const r = remap({ old: "new" }, { old: { c2: "n2" } });
    const first = await dl.remapIds("demo", r);
    expect(first.deferred).toBe(true);
    expect(await dl.getChapter(NEW, "c1")).toBeDefined();
    expect(await dl.getChapter(OLD, "c2")).toBeDefined();
    expect(await dl.getSeries(OLD)).toBeDefined();

    // It settles; the same remap now finishes the job.
    await dl.recordPage(OLD, "c2", 1, "old/c2/1", 10);
    await dl.recordPage(OLD, "c2", 2, "old/c2/2", 10);
    const second = await dl.remapIds("demo", r);
    expect(second.deferred).toBe(false);
    expect(await dl.getSeries(OLD)).toBeUndefined();
    expect((await dl.listChapters(NEW)).map((c) => c.chapterId).sort()).toEqual(["c1", "n2"]);
  });

  test("a chapter already downloaded under its new id keeps the further-along copy and returns the other's files", async () => {
    const dl = makeDownloads();
    await download(dl, "old", "c1", 2);
    await download(dl, "new", "n1", 2, 1);

    const result = await dl.remapIds("demo", remap({ old: "new" }, { old: { c1: "n1" } }));

    expect(result.files).toEqual(["new/n1/0"]);
    expect((await dl.getChapter(NEW, "n1"))?.completedPages).toBe(2);
    expect((await dl.getManifestPages(NEW, "n1")).map((p) => p.file)).toEqual(["old/c1/0", "old/c1/1"]);
  });

  test("an equal copy under the new id wins, and the old one's files are returned", async () => {
    const dl = makeDownloads();
    await download(dl, "old", "c1", 1);
    await download(dl, "new", "n1", 1);

    const result = await dl.remapIds("demo", remap({ old: "new" }, { old: { c1: "n1" } }));

    expect(result.files).toEqual(["old/c1/0"]);
    expect((await dl.getManifestPages(NEW, "n1")).map((p) => p.file)).toEqual(["new/n1/0"]);
    expect(await dl.getSeries(OLD)).toBeUndefined();
  });

  test("repeating a finished remap is a no-op", async () => {
    const dl = makeDownloads();
    await download(dl, "old", "c1", 1);
    const r = remap({ old: "new" }, { old: { c1: "n1" } });
    await dl.remapIds("demo", r);
    expect(await dl.remapIds("demo", r)).toEqual({ deferred: false, files: [] });
    expect((await dl.listChapters(NEW)).map((c) => c.chapterId)).toEqual(["n1"]);
  });
});
