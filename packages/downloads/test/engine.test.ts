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

  test("a resume landing while the loop is exiting still drains (rekick)", async () => {
    // The race: pausing an IN-PROGRESS chapter means a drain loop is running; hitting Resume right
    // after makes its kick() join that dying loop. If the resume's `queued` write lands after the
    // loop's final (empty) pendingChapters read, the chapter must not be dropped — the rekick flag
    // runs one more pass. Reproduced deterministically by triggering the resume from INSIDE the
    // pendingChapters read itself, after the empty result is computed.
    class HookedDownloads extends Downloads {
      afterPending: (() => Promise<void>) | null = null;
      override async pendingChapters() {
        const out = await super.pendingChapters();
        const hook = this.afterPending;
        if (hook) {
          this.afterPending = null;
          await hook();
        }
        return out;
      }
    }
    const downloads = new HookedDownloads(new InMemoryDownloadsStore());
    const blobs = new FakeBlobStore();
    const { fetch } = scriptedFetcher({});
    const engine = new DownloadEngine({ downloads, blobs, fetchPage: fetch });

    await downloads.enqueueChapter(SNAP, CH, pages(2));
    await engine.pauseChapter(KEY, CH.chapterId);

    // The loop's very first pending read comes back empty (the chapter is paused); the resume lands
    // immediately after that read — exactly the lost-work window.
    downloads.afterPending = async () => {
      await engine.resumeChapter(KEY, CH.chapterId);
    };
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

describe("pause during bulk collection", () => {
  test("chapters enqueued after a series pause arrive paused instead of downloading", async () => {
    // A series download is many single-chapter enqueues, each delayed by page resolution. Pausing
    // the series mid-collection must catch the late arrivals too — they file as paused, and the
    // series-level cancel flag must survive them (each enqueue used to wipe it).
    let allowed = false; // hold the drain so the first chapter is still pausable
    const { fetch, calls } = scriptedFetcher({});
    const { engine, downloads, events } = makeEngine(fetch, { mayDownload: async () => allowed });

    await engine.enqueue(SNAP, CH, pages(2)); // c1 landed
    await engine.pauseSeries(KEY); // user pauses while the rest are still resolving
    const late = await engine.enqueue(SNAP, { chapterId: "c2" }, pages(2)); // c2 lands after the pause

    expect(late.state).toBe("paused");
    expect(events.some((e) => e.type === "chapter" && e.chapter.chapterId === "c2" && e.chapter.state === "paused")).toBe(true);
    allowed = true;
    await engine.drain();
    expect(calls).toHaveLength(0); // nothing downloaded — both chapters held
    expect((await downloads.getChapter(KEY, "c2"))?.state).toBe("paused");

    // Resume series releases everything, late arrivals included.
    await engine.resumeSeries(KEY);
    await engine.drain();
    expect((await downloads.getChapter(KEY, CH.chapterId))?.state).toBe("complete");
    expect((await downloads.getChapter(KEY, "c2"))?.state).toBe("complete");
    expect(calls).toHaveLength(4);
  });

  test("a delete racing a late enqueue's pause never rejects the enqueue", async () => {
    // Pausing a mid-collection series makes every late enqueue pause its fresh chapter; if a delete
    // (or a racy store) removed that chapter between the two writes, the pause throws "chapter not
    // downloaded" — which must not reject the enqueue itself.
    class VanishingDownloads extends Downloads {
      override async pauseChapter(key: string, chapterId: string): Promise<never> {
        throw new Error(`chapter not downloaded: ${key}/${chapterId}`);
      }
    }
    const downloads = new VanishingDownloads(new InMemoryDownloadsStore());
    const { fetch } = scriptedFetcher({});
    let allowed = false;
    const engine = new DownloadEngine({
      downloads,
      blobs: new FakeBlobStore(),
      fetchPage: fetch,
      mayDownload: async () => allowed,
    });
    await downloads.enqueueChapter(SNAP, CH, pages(1));
    await engine.pauseSeries(KEY); // marks the series held; c1 stays queued (pauseChapter throws)

    // With a paused-looking sibling, the late enqueue takes the pause branch — which throws.
    const late = await engine.enqueue(SNAP, { chapterId: "c2" }, pages(1)); // must not reject
    expect(late.chapterId).toBe("c2");
    allowed = true;
  });

  test("a stale series flag (everything since deleted) never holds a fresh download", async () => {
    const { fetch } = scriptedFetcher({});
    const { engine, downloads } = makeEngine(fetch);
    await engine.enqueue(SNAP, CH, pages(1));
    await engine.pauseSeries(KEY);
    await engine.deleteSeries(KEY);

    const fresh = await engine.enqueue(SNAP, { chapterId: "c9" }, pages(1));
    expect(fresh.state).toBe("queued");
    await engine.drain();
    expect((await downloads.getChapter(KEY, "c9"))?.state).toBe("complete");
  });

  test("explicitly resuming one chapter re-activates the series for later enqueues", async () => {
    let allowed = false;
    const { fetch } = scriptedFetcher({});
    const { engine } = makeEngine(fetch, { mayDownload: async () => allowed });
    await engine.enqueue(SNAP, CH, pages(1));
    await engine.pauseSeries(KEY);

    // The user deliberately resumed a chapter of this series — that intent clears the series flag,
    // so a later enqueue is a normal fresh download again.
    await engine.resumeChapter(KEY, CH.chapterId);
    const next = await engine.enqueue(SNAP, { chapterId: "c2" }, pages(1));
    expect(next.state).toBe("queued");
    allowed = true;
    await engine.drain();
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

describe("lazy page resolution (enqueue without pages)", () => {
  /** A scripted PageResolver: per-chapter page lists, per-chapter failure counts. */
  function scriptedResolver(opts: {
    pagesFor?: (chapterId: string) => DownloadPageInput[];
    /** How many times resolution for `chapterId` should fail before succeeding (Infinity = always). */
    failuresFor?: (chapterId: string) => number;
  }) {
    const failures = new Map<string, number>();
    const calls: string[] = [];
    const resolve = async (ctx: { bridgeId: string; seriesId: string; chapterId: string }) => {
      calls.push(ctx.chapterId);
      const remaining = failures.get(ctx.chapterId) ?? opts.failuresFor?.(ctx.chapterId) ?? 0;
      if (remaining > 0) {
        failures.set(ctx.chapterId, remaining - 1);
        throw new Error(`scripted resolution failure: ${ctx.chapterId}`);
      }
      return opts.pagesFor?.(ctx.chapterId) ?? pages(2);
    };
    return { resolve, calls };
  }

  test("a lazy enqueue is a pure manifest write; the drain resolves pages and completes", async () => {
    const { fetch, calls: fetchCalls } = scriptedFetcher({});
    const { resolve, calls: resolveCalls } = scriptedResolver({ pagesFor: () => pages(3) });
    const { engine, downloads } = makeEngine(fetch, { resolvePages: resolve });

    const enqueued = await engine.enqueue(SNAP, CH);
    // Recorded instantly with pages unresolved — nothing fetched or resolved yet at enqueue time.
    expect(enqueued.state).toBe("queued");
    expect(enqueued.pageCount).toBe(0);
    expect(enqueued.pagesResolved).toBe(false);

    await engine.drain();
    expect(resolveCalls).toEqual(["c1"]);
    expect(fetchCalls.length).toBe(3);
    const done = await downloads.getChapter(KEY, "c1");
    expect(done?.state).toBe("complete");
    expect(done?.pageCount).toBe(3);
    expect(done?.pagesResolved).toBeUndefined();
  });

  test("one chapter's resolution failing marks IT failed; its siblings still complete", async () => {
    const { fetch } = scriptedFetcher({});
    const { resolve } = scriptedResolver({
      pagesFor: () => pages(2),
      failuresFor: (chapterId) => (chapterId === "bad" ? Infinity : 0),
    });
    const { engine, downloads, events } = makeEngine(fetch, { resolvePages: resolve });

    await engine.enqueue(SNAP, { chapterId: "bad" });
    await engine.enqueue(SNAP, { chapterId: "good" });
    await engine.drain();

    // The bad chapter surfaces as failed (a visible, retryable row) — and only the bad one.
    expect((await downloads.getChapter(KEY, "bad"))?.state).toBe("failed");
    expect((await downloads.getChapter(KEY, "good"))?.state).toBe("complete");
    expect(
      events.some((e) => e.type === "chapter" && e.chapter.chapterId === "bad" && e.chapter.state === "failed"),
    ).toBe(true);
  });

  test("retrying a resolution-failed chapter re-attempts resolution", async () => {
    const { fetch } = scriptedFetcher({});
    // Fails exactly once — the retry's second attempt succeeds.
    const { resolve, calls } = scriptedResolver({ pagesFor: () => pages(2), failuresFor: () => 1 });
    const { engine, downloads } = makeEngine(fetch, { resolvePages: resolve });

    await engine.enqueue(SNAP, CH);
    await engine.drain();
    expect((await downloads.getChapter(KEY, "c1"))?.state).toBe("failed");

    await engine.retryChapter(KEY, "c1");
    await engine.drain();
    expect(calls).toEqual(["c1", "c1"]);
    const done = await downloads.getChapter(KEY, "c1");
    expect(done?.state).toBe("complete");
    expect(done?.pageCount).toBe(2);
  });

  test("a lazy enqueue with no resolver configured fails the chapter instead of spinning", async () => {
    const { fetch, calls } = scriptedFetcher({});
    const { engine, downloads } = makeEngine(fetch);

    await engine.enqueue(SNAP, CH);
    await engine.drain();
    expect((await downloads.getChapter(KEY, "c1"))?.state).toBe("failed");
    expect(calls.length).toBe(0);
  });

  test("a lazy re-enqueue of a partial chapter keeps its completed bytes", async () => {
    const { fetch, calls } = scriptedFetcher({});
    const { resolve } = scriptedResolver({ pagesFor: () => pages(3) });
    const { engine, downloads } = makeEngine(fetch, { resolvePages: resolve });

    // First round: eager enqueue with the full page list.
    await engine.enqueue(SNAP, CH, pages(3));
    await engine.drain();
    expect((await downloads.getChapter(KEY, "c1"))?.state).toBe("complete");
    const fetchesAfterFirst = calls.length;

    // Lazy re-enqueue: resolution runs again, but the already-complete pages are not re-fetched.
    await engine.enqueue(SNAP, CH);
    await engine.drain();
    expect((await downloads.getChapter(KEY, "c1"))?.state).toBe("complete");
    expect(calls.length).toBe(fetchesAfterFirst);
  });
});

describe("enqueueMany (bulk)", () => {
  test("lands the batch with ONE changed event (no per-chapter spam) and drains it all", async () => {
    const { fetch } = scriptedFetcher({});
    const resolve = async () => pages(2);
    const { engine, downloads, events } = makeEngine(fetch, { resolvePages: resolve });

    const metas = Array.from({ length: 5 }, (_, i) => ({ chapterId: `c${i}` }));
    const enqueued = await engine.enqueueMany(SNAP, metas);
    expect(enqueued).toHaveLength(5);
    for (const c of enqueued) {
      expect(c.state).toBe("queued");
      expect(c.pagesResolved).toBe(false);
    }
    // Exactly one event so far — the batch-level 'changed' (observers refetch once, see all 5).
    expect(events.filter((e) => e.type !== "idle")).toEqual([
      { type: "changed", bridgeId: SNAP.bridgeId, seriesId: SNAP.seriesId },
    ]);

    await engine.drain();
    for (const meta of metas) {
      expect((await downloads.getChapter(KEY, meta.chapterId))?.state).toBe("complete");
    }
  });

  test("a bulk download after a series pause is a re-activation, not a paused arrival", async () => {
    const { fetch } = scriptedFetcher({});
    const resolve = async () => pages(1);
    const { engine, downloads } = makeEngine(fetch, { resolvePages: resolve });

    // Pause an in-progress series (sets the series cancel flag)…
    await engine.enqueue(SNAP, { chapterId: "old" });
    await engine.pauseSeries(KEY);
    expect((await downloads.getChapter(KEY, "old"))?.state).toBe("paused");

    // …then explicitly bulk-download more: the new chapters must download (the flag is stale for
    // them — the atomic batch can't race a mid-collection pause), while 'old' stays paused.
    await engine.enqueueMany(SNAP, [{ chapterId: "new1" }, { chapterId: "new2" }]);
    await engine.drain();
    expect((await downloads.getChapter(KEY, "new1"))?.state).toBe("complete");
    expect((await downloads.getChapter(KEY, "new2"))?.state).toBe("complete");
    expect((await downloads.getChapter(KEY, "old"))?.state).toBe("paused");
  });
});

describe("pickup state (no queued flash)", () => {
  test("once a chapter is picked up, its events never dip back to 'queued' before completion", async () => {
    const { fetch } = scriptedFetcher({});
    const resolve = async () => pages(3);
    const { engine, events } = makeEngine(fetch, { resolvePages: resolve });

    await engine.enqueue(SNAP, CH);
    await engine.drain();

    const states = events
      .filter((e): e is Extract<DownloadEngineEvent, { type: "chapter" }> => e.type === "chapter")
      .map((e) => e.chapter.state);
    const pickedAt = states.indexOf("downloading");
    expect(pickedAt).toBeGreaterThanOrEqual(0);
    // After pickup: only downloading → complete. A 'queued' in between is the icon flash.
    expect(states.slice(pickedAt)).not.toContain("queued");
    expect(states.at(-1)).toBe("complete");

    // And the pickup event carries the resolved pageCount (the progress denominator).
    const picked = events.find(
      (e): e is Extract<DownloadEngineEvent, { type: "chapter" }> =>
        e.type === "chapter" && e.chapter.state === "downloading" && e.chapter.pageCount > 0,
    );
    expect(picked).toBeDefined();
  });

  test("markChapterDownloading records pickup in the manifest but never resurrects a pause", async () => {
    const { fetch } = scriptedFetcher({});
    const { engine, downloads } = makeEngine(fetch);
    await engine.enqueue(SNAP, CH, pages(2));

    expect((await downloads.markChapterDownloading(KEY, "c1")).state).toBe("downloading");
    await downloads.pauseChapter(KEY, "c1");
    expect((await downloads.markChapterDownloading(KEY, "c1")).state).toBe("paused");
  });
});

describe("gate wedge (the on-device 'stalls until app restart' bug)", () => {
  test("REPRO: a transient mayDownload=false leaves the queue wedged until an explicit kick", async () => {
    const { fetch, calls } = scriptedFetcher({});
    // The Wi-Fi-only gate. It reads FALSE for a beat (a transient network misread on-device — the
    // reading flaps even though the device never really left Wi-Fi), then reads true again.
    let gateOpen = false;
    const { engine, downloads } = makeEngine(fetch, { mayDownload: async () => gateOpen });

    // Enqueue three chapters while the gate is closed — each kicks a drain that immediately breaks
    // on the closed gate, so nothing downloads.
    await engine.enqueue(SNAP, { chapterId: "a" }, pages(1));
    await engine.enqueue(SNAP, { chapterId: "b" }, pages(1));
    await engine.enqueue(SNAP, { chapterId: "c" }, pages(1));
    await engine.drain(); // settle the gated loop
    expect(calls.length).toBe(0);
    expect((await downloads.getChapter(KEY, "a"))?.state).toBe("queued");

    // The gate reopens — but nothing tells the engine. NO kick, NO network-change event (there was
    // no real change to fire one). On device this is the wedge: downloads sit forever.
    gateOpen = true;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(0); // <-- STILL nothing: the queue is wedged
    expect((await downloads.getChapter(KEY, "a"))?.state).toBe("queued");

    // The only cure today is an explicit kick — which is exactly what an app restart does
    // (resumePendingDownloads -> kick). After it, the queue drains fine (it was never broken).
    engine.kick();
    await engine.drain();
    expect((await downloads.getChapter(KEY, "a"))?.state).toBe("complete");
    expect((await downloads.getChapter(KEY, "c"))?.state).toBe("complete");
  });
});

describe("gate wedge self-heal (idleRecheckMs)", () => {
  test("a re-check auto-drains the queue after a transient gate-false — no restart needed", async () => {
    const { fetch, calls } = scriptedFetcher({});
    let gateOpen = false;
    const { engine, downloads } = makeEngine(fetch, {
      mayDownload: async () => gateOpen,
      idleRecheckMs: 20, // tiny for the test
    });

    await engine.enqueue(SNAP, { chapterId: "a" }, pages(1));
    await engine.enqueue(SNAP, { chapterId: "b" }, pages(1));
    await engine.drain();
    expect(calls.length).toBe(0); // gated: nothing yet

    // The gate reopens with NO kick and NO network event — exactly the wedge. The self-heal timer
    // (armed when the gated loop settled with work pending) re-kicks on its own.
    gateOpen = true;
    await new Promise((r) => setTimeout(r, 80));
    expect((await downloads.getChapter(KEY, "a"))?.state).toBe("complete");
    expect((await downloads.getChapter(KEY, "b"))?.state).toBe("complete");
  });

  test("the self-heal poll stops once the queue is empty (no forever-timer)", async () => {
    const { fetch } = scriptedFetcher({});
    const { engine, downloads } = makeEngine(fetch, { idleRecheckMs: 15 });
    await engine.enqueue(SNAP, CH, pages(1));
    await engine.drain();
    expect((await downloads.getChapter(KEY, "c1"))?.state).toBe("complete");
    // Drained cleanly; a couple of recheck intervals pass with the queue empty. `stop()` must find
    // no armed timer to clear (the poll lapsed) — asserted indirectly: nothing throws / re-drains.
    await new Promise((r) => setTimeout(r, 50));
    engine.stop(); // clears any timer; a no-op if already lapsed
    expect((await downloads.getChapter(KEY, "c1"))?.state).toBe("complete");
  });

  test("stop() cancels a pending self-heal (backgrounding shouldn't silently resume)", async () => {
    const { fetch, calls } = scriptedFetcher({});
    let gateOpen = false;
    const { engine, downloads } = makeEngine(fetch, {
      mayDownload: async () => gateOpen,
      idleRecheckMs: 20,
    });
    await engine.enqueue(SNAP, CH, pages(1));
    await engine.drain(); // gated → armed
    engine.stop(); // background: cancel the self-heal
    gateOpen = true;
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.length).toBe(0); // stayed put — no ghost resume after stop
    expect((await downloads.getChapter(KEY, "c1"))?.state).toBe("queued");
  });
});
