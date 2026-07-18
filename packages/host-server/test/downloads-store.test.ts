/**
 * FileDownloadsStore over a temp dir: round-trips the manifest through JSON and survives a fresh
 * instance reading the same directory (persistence, not just the in-memory cache).
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Downloads, type DownloadPageInput } from "@comical/downloads";
import { FileDownloadsStore } from "../src/downloads-store.ts";

const DIR = join(import.meta.dir, ".tmp-downloads-store");

beforeAll(() => rmSync(DIR, { recursive: true, force: true }));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const snap = { bridgeId: "demo", seriesId: "s1", title: "Series One" };
const page = (index: number): DownloadPageInput => ({ index, sourceUrl: `/img/${index}` });

describe("FileDownloadsStore persistence", () => {
  test("a fresh store instance reads back what a prior one wrote", async () => {
    const dl = new Downloads(new FileDownloadsStore(DIR));
    await dl.enqueueChapter(snap, { chapterId: "c1", chapterName: "Chapter 1" }, [page(0), page(1)]);
    await dl.recordPage("demo:s1", "c1", 0, "demo/s1/c1/0.jpg", 100);
    await dl.recordPage("demo:s1", "c1", 1, "demo/s1/c1/1.jpg", 100);

    // New instance, same dir — must load from disk.
    const dl2 = new Downloads(new FileDownloadsStore(DIR));
    const usage = await dl2.getStorageUsage();
    expect(usage.totalBytes).toBe(200);
    expect(usage.bySeries[0]?.chapters[0]?.chapterName).toBe("Chapter 1");
    expect(await dl2.localFileFor("demo", "s1", "c1", 1)).toBe("demo/s1/c1/1.jpg");
  });

  test("deletion removes the manifest so a fresh instance sees nothing", async () => {
    const dl = new Downloads(new FileDownloadsStore(DIR));
    await dl.deleteAll();
    const dl2 = new Downloads(new FileDownloadsStore(DIR));
    expect((await dl2.getStorageUsage()).seriesCount).toBe(0);
  });
});
