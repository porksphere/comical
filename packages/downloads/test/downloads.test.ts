import { describe, expect, test } from "bun:test";
import {
  Downloads,
  InMemoryDownloadsStore,
  entryKey,
  type DownloadChapterMeta,
  type DownloadPageInput,
  type DownloadSeriesSnapshot,
} from "../src/index.ts";

const SNAP: DownloadSeriesSnapshot = { bridgeId: "demo", seriesId: "s1", title: "Series One" };
const KEY = entryKey(SNAP.bridgeId, SNAP.seriesId);
const CH: DownloadChapterMeta = { chapterId: "c1", chapterName: "Chapter 1", number: 1 };

/** A monotonic clock so addedAt/completedAt assertions are deterministic. */
function fakeClock() {
  let t = 1_000;
  return () => ++t;
}

function makeDownloads() {
  return new Downloads(new InMemoryDownloadsStore(), { now: fakeClock() });
}

function pages(n: number): DownloadPageInput[] {
  return Array.from({ length: n }, (_, i) => ({ index: i, sourceUrl: `/img/${i}`, headers: { referer: "x" } }));
}

/** Drive a chapter to fully complete, recording `bytesPerPage` for each of its `n` pages. */
async function completeChapter(dl: Downloads, n: number, bytesPerPage: number) {
  await dl.enqueueChapter(SNAP, CH, pages(n));
  for (let i = 0; i < n; i++) {
    await dl.recordPage(KEY, CH.chapterId, i, `demo/s1/c1/${i}.jpg`, bytesPerPage);
  }
}

describe("enqueue + progress", () => {
  test("enqueue creates a queued chapter with queued pages", async () => {
    const dl = makeDownloads();
    const chapter = await dl.enqueueChapter(SNAP, CH, pages(3));
    expect(chapter.state).toBe("queued");
    expect(chapter.pageCount).toBe(3);
    expect(chapter.chapterName).toBe("Chapter 1");
    const manifest = await dl.getManifestPages(KEY, CH.chapterId);
    expect(manifest.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(manifest.every((p) => p.state === "queued")).toBe(true);
    expect(manifest[0]?.headers).toEqual({ referer: "x" });
  });

  test("recordPage rolls up bytes and flips to downloading then complete", async () => {
    const dl = makeDownloads();
    await dl.enqueueChapter(SNAP, CH, pages(2));

    let chapter = await dl.recordPage(KEY, CH.chapterId, 0, "demo/s1/c1/0.jpg", 100);
    expect(chapter.state).toBe("downloading");
    expect(chapter.bytes).toBe(100);
    expect(chapter.completedAt).toBeUndefined();

    chapter = await dl.recordPage(KEY, CH.chapterId, 1, "demo/s1/c1/1.jpg", 150);
    expect(chapter.state).toBe("complete");
    expect(chapter.bytes).toBe(250);
    expect(chapter.completedAt).toBeGreaterThan(0);

    // Series rollup reflects the chapter.
    const series = await dl.getSeries(KEY);
    expect(series?.chapterCount).toBe(1);
    expect(series?.bytes).toBe(250);
  });

  test("failPage flips the chapter to failed; requeueMissing returns only missing pages", async () => {
    const dl = makeDownloads();
    await dl.enqueueChapter(SNAP, CH, pages(3));
    await dl.recordPage(KEY, CH.chapterId, 0, "demo/s1/c1/0.jpg", 100);
    const failed = await dl.failPage(KEY, CH.chapterId, 1);
    expect(failed.state).toBe("failed");

    const missing = await dl.requeueMissing(KEY, CH.chapterId);
    expect(missing.map((p) => p.index)).toEqual([1, 2]); // page 0 already complete
    expect(missing[0]?.headers).toEqual({ referer: "x" });

    // After requeue the chapter is back to downloading (page 0 still complete).
    const chapter = await dl.getChapter(KEY, CH.chapterId);
    expect(chapter?.state).toBe("downloading");
  });

  test("re-enqueue preserves already-downloaded bytes", async () => {
    const dl = makeDownloads();
    await completeChapter(dl, 2, 100);
    const chapter = await dl.enqueueChapter(SNAP, CH, pages(2));
    // Nothing was lost — still complete with the same bytes.
    expect(chapter.state).toBe("complete");
    expect(chapter.bytes).toBe(200);
  });
});

describe("offline lookup", () => {
  test("localFileFor returns the on-disk path only for complete pages", async () => {
    const dl = makeDownloads();
    await dl.enqueueChapter(SNAP, CH, pages(2));
    expect(await dl.localFileFor("demo", "s1", "c1", 0)).toBeUndefined();
    await dl.recordPage(KEY, CH.chapterId, 0, "demo/s1/c1/0.jpg", 100);
    expect(await dl.localFileFor("demo", "s1", "c1", 0)).toBe("demo/s1/c1/0.jpg");
    expect(await dl.isChapterComplete(KEY, CH.chapterId)).toBe(false);
  });
});

describe("storage usage", () => {
  test("aggregates totals across series and chapters", async () => {
    const dl = makeDownloads();
    await completeChapter(dl, 3, 100); // demo/s1/c1: 300 bytes
    await dl.enqueueChapter({ bridgeId: "demo", seriesId: "s2", title: "Series Two" }, { chapterId: "cA" }, pages(2));
    await dl.recordPage(entryKey("demo", "s2"), "cA", 0, "demo/s2/cA/0.jpg", 50);
    await dl.recordPage(entryKey("demo", "s2"), "cA", 1, "demo/s2/cA/1.jpg", 50);

    const usage = await dl.getStorageUsage();
    expect(usage.seriesCount).toBe(2);
    expect(usage.chapterCount).toBe(2);
    expect(usage.pageCount).toBe(5);
    expect(usage.totalBytes).toBe(400);
    // Sorted by bytes desc — the 300-byte series first.
    expect(usage.bySeries[0]?.seriesId).toBe("s1");
    expect(usage.bySeries[0]?.chapters[0]?.bytes).toBe(300);
  });
});

describe("deletion cascade", () => {
  test("deleteChapter returns blob paths and prunes an emptied series", async () => {
    const dl = makeDownloads();
    await completeChapter(dl, 2, 100);
    const files = await dl.deleteChapter(KEY, CH.chapterId);
    expect(files.sort()).toEqual(["demo/s1/c1/0.jpg", "demo/s1/c1/1.jpg"]);
    // Last chapter gone → series pruned.
    expect(await dl.getSeries(KEY)).toBeUndefined();
    expect((await dl.getStorageUsage()).totalBytes).toBe(0);
  });

  test("deleteChapter keeps the series when other chapters remain, and re-rolls up", async () => {
    const dl = makeDownloads();
    await completeChapter(dl, 2, 100); // c1
    await dl.enqueueChapter(SNAP, { chapterId: "c2" }, pages(1));
    await dl.recordPage(KEY, "c2", 0, "demo/s1/c2/0.jpg", 40);

    await dl.deleteChapter(KEY, CH.chapterId); // remove c1 (200 bytes)
    const series = await dl.getSeries(KEY);
    expect(series?.chapterCount).toBe(1);
    expect(series?.bytes).toBe(40);
  });

  test("deleteSeries and deleteAll return every blob path", async () => {
    const dl = makeDownloads();
    await completeChapter(dl, 2, 100);
    await dl.enqueueChapter({ bridgeId: "demo", seriesId: "s2", title: "Series Two" }, { chapterId: "cA" }, pages(1));
    await dl.recordPage(entryKey("demo", "s2"), "cA", 0, "demo/s2/cA/0.jpg", 10);

    const seriesFiles = await dl.deleteSeries(KEY);
    expect(seriesFiles).toHaveLength(2);
    expect(await dl.getSeries(KEY)).toBeUndefined();

    const allFiles = await dl.deleteAll();
    expect(allFiles).toEqual(["demo/s2/cA/0.jpg"]);
    expect((await dl.getStorageUsage()).seriesCount).toBe(0);
  });
});

describe("pending queue", () => {
  test("pendingChapters lists non-complete chapters oldest-first", async () => {
    const dl = makeDownloads();
    await completeChapter(dl, 1, 100); // c1 complete
    await dl.enqueueChapter(SNAP, { chapterId: "c2" }, pages(2)); // queued
    const pending = await dl.pendingChapters();
    expect(pending.map((c) => c.chapterId)).toEqual(["c2"]);
  });
});

describe("prefs", () => {
  test("defaults to wifiOnly on, background off; setPrefs persists", async () => {
    const dl = makeDownloads();
    expect(await dl.getPrefs()).toEqual({ wifiOnly: true, background: false });
    await dl.setPrefs({ wifiOnly: false, background: true });
    expect(await dl.getPrefs()).toEqual({ wifiOnly: false, background: true });
  });
});

describe("guards", () => {
  test("recording a page for an unknown chapter throws not-downloaded", async () => {
    const dl = makeDownloads();
    await expect(dl.recordPage(KEY, "nope", 0, "x", 1)).rejects.toThrow("not downloaded");
  });
});
