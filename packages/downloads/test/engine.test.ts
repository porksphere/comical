import { describe, expect, test } from "bun:test";
import {
  DownloadEngine,
  Downloads,
  InMemoryDownloadsStore,
  contentTypeFor,
  entryKey,
  extFor,
  relPathFor,
  sanitizeSegment,
  type BlobStore,
  type DownloadEngineEvent,
  type DownloadPageInput,
  type DownloadSeriesSnapshot,
  type PageFetcher,
  type PendingPage,
} from "../src/index.ts";

const SNAP: DownloadSeriesSnapshot = { bridgeId: "demo", seriesId: "s1", title: "Series One" };
const KEY = entryKey(SNAP.bridgeId, SNAP.seriesId);
const CH = { chapterId: "c1", chapterName: "Chapter 1", number: 1 };

function pages(n: number): DownloadPageInput[] {
  return Array.from({ length: n }, (_, i) => ({ index: i, sourceUrl: `/img/${i}`, headers: { referer: "x" } }));
}

/** A Map-backed BlobStore recording every operation. */
class FakeBlobStore implements BlobStore {
  blobs = new Map<string, Uint8Array>();
  removed: string[] = [];
  sweeps = 0;
  async write(relPath: string, data: Uint8Array): Promise<{ bytes: number }> {
    this.blobs.set(relPath, data);
    return { bytes: data.byteLength };
  }
  async remove(relPaths: string[]): Promise<void> {
    for (const p of relPaths) {
      this.blobs.delete(p);
      this.removed.push(p);
    }
  }
  async removeAll(): Promise<void> {
    this.sweeps++;
    this.blobs.clear();
  }
  async read(relPath: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(relPath);
  }
}

/** A scripted PageFetcher: per-page byte sizes, optional per-index failure scripts. */
function scriptedFetcher(opts: {
  bytesFor?: (index: number) => number;
  /** Return how many times the page at `index` should fail before succeeding (Infinity = always). */
  failuresFor?: (index: number) => number;
  contentType?: string;
  onFetch?: (page: PendingPage) => void | Promise<void>;
}): { fetch: PageFetcher; calls: PendingPage[] } {
  const failures = new Map<number, number>();
  const calls: PendingPage[] = [];
  const fetch: PageFetcher = async (_ctx, page) => {
    calls.push(page);
    await opts.onFetch?.(page);
    const remaining = failures.get(page.index) ?? opts.failuresFor?.(page.index) ?? 0;
    if (remaining > 0) {
      failures.set(page.index, remaining - 1);
      throw new Error(`scripted failure #${page.index}`);
    }
    const size = opts.bytesFor?.(page.index) ?? 10;
    const out: { data: Uint8Array; contentType?: string } = { data: new Uint8Array(size) };
    if (opts.contentType !== undefined) out.contentType = opts.contentType;
    return out;
  };
  return { fetch, calls };
}

function makeEngine(fetch: PageFetcher, extra: Partial<ConstructorParameters<typeof DownloadEngine>[0]> = {}) {
  const downloads = new Downloads(new InMemoryDownloadsStore());
  const blobs = new FakeBlobStore();
  const engine = new DownloadEngine({ downloads, blobs, fetchPage: fetch, ...extra });
  const events: DownloadEngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, downloads, blobs, events };
}

describe("paths", () => {
  test("relPathFor sanitizes arbitrary id characters", () => {
    expect(relPathFor("de:mo", "s/1?x", "c 1", 3, "jpg")).toBe("de_mo/s_1_x/c_1/3.jpg");
    expect(sanitizeSegment("a.b/c:d")).toBe("a_b_c_d");
  });

  test("extFor handles data URIs, bare mime types, and URLs", () => {
    expect(extFor("data:image/jpeg;base64,xxx")).toBe("jpg");
    expect(extFor("image/webp")).toBe("webp");
    expect(extFor("image/png; charset=binary")).toBe("png");
    expect(extFor("https://cdn.example/x/page.avif?tok=1")).toBe("avif");
    expect(extFor("https://cdn.example/opaque")).toBe("img");
  });

  test("contentTypeFor maps stored extensions back to mime", () => {
    expect(contentTypeFor("demo/s1/c1/0.jpg")).toBe("image/jpeg");
    expect(contentTypeFor("demo/s1/c1/0.webp")).toBe("image/webp");
    expect(contentTypeFor("demo/s1/c1/0.img")).toBe("application/octet-stream");
  });
});

describe("drain", () => {
  test("happy path: enqueue drains every page to complete, blobs land, events in order", async () => {
    const { fetch } = scriptedFetcher({ bytesFor: (i) => 100 + i, contentType: "image/jpeg" });
    const { engine, downloads, blobs, events } = makeEngine(fetch);

    await engine.enqueue(SNAP, CH, pages(3));
    await engine.drain();

    const chapter = await downloads.getChapter(KEY, CH.chapterId);
    expect(chapter?.state).toBe("complete");
    expect(chapter?.completedPages).toBe(3);
    expect(chapter?.bytes).toBe(100 + 101 + 102);
    expect([...blobs.blobs.keys()].sort()).toEqual(["demo/s1/c1/0.jpg", "demo/s1/c1/1.jpg", "demo/s1/c1/2.jpg"]);
    // Manifest file fields point at the written blobs.
    const manifest = await downloads.getManifestPages(KEY, CH.chapterId);
    expect(manifest.map((p) => p.file)).toEqual(["demo/s1/c1/0.jpg", "demo/s1/c1/1.jpg", "demo/s1/c1/2.jpg"]);

    // Event ordering: enqueued (queued) → picked up (downloading) → 3 pages → complete → idle.
    const kinds = events.map((e) => (e.type === "chapter" ? `chapter:${e.chapter.state}` : e.type));
    expect(kinds[0]).toBe("chapter:queued");
    expect(kinds).toContain("chapter:downloading");
    expect(kinds.filter((k) => k === "page")).toHaveLength(3);
    expect(kinds).toContain("chapter:complete");
    expect(kinds[kinds.length - 1]).toBe("idle");
    const pageEvents = events.filter((e) => e.type === "page");
    expect(pageEvents.map((e) => e.completedPages)).toEqual([1, 2, 3]);
    expect(pageEvents[2]?.state).toBe("complete");
  });

  test("resume: a partial chapter only fetches its missing pages", async () => {
    const { fetch, calls } = scriptedFetcher({});
    const { engine, downloads } = makeEngine(fetch);
    await downloads.enqueueChapter(SNAP, CH, pages(3));
    // Page 1 already landed in a previous run.
    await downloads.recordPage(KEY, CH.chapterId, 1, "demo/s1/c1/1.jpg", 10);

    await engine.drain();

    expect(calls.map((p) => p.index).sort()).toEqual([0, 2]);
    expect((await downloads.getChapter(KEY, CH.chapterId))?.state).toBe("complete");
  });

  test("a persistently failing page marks the chapter failed and the drain exits (no spin)", async () => {
    const { fetch, calls } = scriptedFetcher({ failuresFor: (i) => (i === 1 ? Infinity : 0) });
    const { engine, downloads, events } = makeEngine(fetch);

    await engine.enqueue(SNAP, CH, pages(3));
    await engine.drain();

    const chapter = await downloads.getChapter(KEY, CH.chapterId);
    expect(chapter?.state).toBe("failed");
    expect(chapter?.completedPages).toBe(2);
    // 2 attempts on the failing page, 1 each on the others; failed chapters leave the pending queue,
    // so a second drain fetches nothing.
    expect(calls).toHaveLength(4);
    await engine.drain();
    expect(calls).toHaveLength(4);
    expect(events.filter((e) => e.type === "chapter" && e.chapter.state === "failed").length).toBeGreaterThan(0);
  });

  test("onPageRetry fires between attempts", async () => {
    const retried: number[] = [];
    const { fetch } = scriptedFetcher({ failuresFor: (i) => (i === 0 ? 1 : 0) });
    const { engine, downloads } = makeEngine(fetch, { onPageRetry: (p) => retried.push(p.index) });
    await engine.enqueue(SNAP, CH, pages(2));
    await engine.drain();
    expect(retried).toEqual([0]);
    expect((await downloads.getChapter(KEY, CH.chapterId))?.state).toBe("complete");
  });

  test("retryChapter re-queues missing pages and completes", async () => {
    const { fetch } = scriptedFetcher({ failuresFor: (i) => (i === 1 ? 2 : 0) });
    const { engine, downloads } = makeEngine(fetch);
    await engine.enqueue(SNAP, CH, pages(2));
    await engine.drain();
    expect((await downloads.getChapter(KEY, CH.chapterId))?.state).toBe("failed");

    // The two scripted failures are exhausted; a retry drains the missing page to completion.
    await engine.retryChapter(KEY, CH.chapterId);
    await engine.drain();
    expect((await downloads.getChapter(KEY, CH.chapterId))?.state).toBe("complete");
  });

  test("pause mid-drain aborts promptly and keeps completed pages", async () => {
    const { engine, downloads } = makeEngine(async (_ctx, page) => {
      if (page.index === 1) await engine.pauseChapter(KEY, CH.chapterId); // pause while "fetching"
      return { data: new Uint8Array(10) };
    });
    await engine.enqueue(SNAP, CH, pages(4));
    await engine.drain();

    const chapter = await downloads.getChapter(KEY, CH.chapterId);
    expect(chapter?.state).toBe("paused");
    // Page 0 landed before the pause; page 1's fetch was already in flight, so its bytes are kept
    // rather than wasted. Pages 2–3 are never fetched — the cancel flag aborts before them.
    expect(chapter?.completedPages).toBe(2);

    // Resume drains the rest.
    await engine.resumeChapter(KEY, CH.chapterId);
    await engine.drain();
    expect((await downloads.getChapter(KEY, CH.chapterId))?.state).toBe("complete");
  });

  test("stop() halts the loop after the current page", async () => {
    const { engine, downloads } = makeEngine(async (_ctx, page) => {
      if (page.index === 0) engine.stop();
      return { data: new Uint8Array(10) };
    });
    await engine.enqueue(SNAP, CH, pages(3));
    await engine.drain();
    const chapter = await downloads.getChapter(KEY, CH.chapterId);
    expect(chapter?.completedPages).toBe(1);
    expect(chapter?.state).toBe("downloading");

    await engine.drain(); // a later drain resumes from the manifest
    expect((await downloads.getChapter(KEY, CH.chapterId))?.state).toBe("complete");
  });

  test("mayDownload=false holds the queue without touching pages", async () => {
    let allowed = false;
    const { fetch, calls } = scriptedFetcher({});
    const { engine, downloads } = makeEngine(fetch, { mayDownload: async () => allowed });
    await engine.enqueue(SNAP, CH, pages(2));
    await engine.drain();
    expect(calls).toHaveLength(0);
    expect((await downloads.getChapter(KEY, CH.chapterId))?.state).toBe("queued");

    allowed = true;
    await engine.drain();
    expect((await downloads.getChapter(KEY, CH.chapterId))?.state).toBe("complete");
  });

  test("drain is single-flight: re-entrant calls no-op while a loop runs", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { engine } = makeEngine(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { data: new Uint8Array(1) };
    });
    await engine.enqueue(SNAP, CH, pages(3));
    await Promise.all([engine.drain(), engine.drain(), engine.drain()]);
    expect(maxInFlight).toBe(1); // pageConcurrency 1 and only one loop
  });

  test("a running loop picks up chapters enqueued mid-drain", async () => {
    const { fetch } = scriptedFetcher({});
    const { engine, downloads } = makeEngine(fetch);
    await downloads.enqueueChapter(SNAP, CH, pages(1));
    let added = false;
    engine.subscribe((e) => {
      if (!added && e.type === "page") {
        added = true;
        void downloads.enqueueChapter(SNAP, { chapterId: "c2" }, pages(1));
      }
    });
    await engine.drain();
    expect((await downloads.getChapter(KEY, "c2"))?.state).toBe("complete");
  });
});

describe("deletion", () => {
  test("deleteChapter removes its blobs and emits deleted", async () => {
    const { fetch } = scriptedFetcher({});
    const { engine, downloads, blobs, events } = makeEngine(fetch);
    await engine.enqueue(SNAP, CH, pages(2));
    await engine.drain();
    expect(blobs.blobs.size).toBe(2);

    await engine.deleteChapter(KEY, CH.chapterId);
    expect(blobs.blobs.size).toBe(0);
    expect(await downloads.getSeries(KEY)).toBeUndefined(); // last chapter prunes the series
    const deleted = events.find((e) => e.type === "deleted");
    expect(deleted).toEqual({ type: "deleted", bridgeId: "demo", seriesId: "s1", chapterId: "c1" });
  });

  test("deleteAll removes every blob and sweeps the root", async () => {
    const { fetch } = scriptedFetcher({});
    const { engine, blobs } = makeEngine(fetch);
    await engine.enqueue(SNAP, CH, pages(2));
    await engine.enqueue({ bridgeId: "demo", seriesId: "s2", title: "Two" }, { chapterId: "c9" }, pages(1));
    await engine.drain();
    expect(blobs.blobs.size).toBe(3);

    await engine.deleteAll();
    expect(blobs.blobs.size).toBe(0);
    expect(blobs.sweeps).toBe(1);
  });
});

describe("series pause/resume", () => {
  test("pauseSeries stops the whole series; resumeSeries drains it", async () => {
    const { fetch } = scriptedFetcher({});
    const { engine, downloads, events } = makeEngine(fetch);
    await downloads.enqueueChapter(SNAP, CH, pages(2));
    await downloads.enqueueChapter(SNAP, { chapterId: "c2" }, pages(2));

    await engine.pauseSeries(KEY);
    await engine.drain();
    expect((await downloads.getChapter(KEY, "c1"))?.state).toBe("paused");
    expect((await downloads.getChapter(KEY, "c2"))?.state).toBe("paused");
    expect(events.some((e) => e.type === "changed" && e.seriesId === "s1")).toBe(true);

    await engine.resumeSeries(KEY);
    await engine.drain();
    expect((await downloads.getChapter(KEY, "c1"))?.state).toBe("complete");
    expect((await downloads.getChapter(KEY, "c2"))?.state).toBe("complete");
  });
});
