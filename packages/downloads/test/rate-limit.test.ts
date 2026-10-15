/**
 * Engine politeness: a bridge's page budget (`pageRateLimit`) paces every page fetch of that bridge,
 * and a source's "slow down" holds the bridge's queue (pages untouched, attempts unspent) until the
 * wait passes, while other bridges keep downloading.
 */
import { describe, expect, test } from "bun:test";
import {
  DownloadEngine,
  Downloads,
  InMemoryDownloadsStore,
  PageRateLimitedError,
  createRouterPageResolver,
  entryKey,
  rateLimitWaitOf,
  rateLimitedFromResponse,
  type BlobStore,
  type DownloadEngineEvent,
  type DownloadPageInput,
  type PageFetcher,
} from "../src/index.ts";

class Blobs implements BlobStore {
  blobs = new Map<string, Uint8Array>();
  async write(relPath: string, data: Uint8Array) {
    this.blobs.set(relPath, data);
    return { bytes: data.byteLength };
  }
  async remove(relPaths: string[]) {
    for (const p of relPaths) this.blobs.delete(p);
  }
  async removeAll() {
    this.blobs.clear();
  }
  async read(relPath: string) {
    return this.blobs.get(relPath);
  }
}

const pages = (n: number): DownloadPageInput[] => Array.from({ length: n }, (_, i) => ({ index: i, sourceUrl: `/img/${i}` }));
const snap = (bridgeId: string) => ({ bridgeId, seriesId: "s", title: "S" });
const ch = (chapterId = "c1") => ({ chapterId, chapterName: chapterId, number: 1 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = () => ({ data: new Uint8Array(4) });

function setup(fetchPage: PageFetcher, extra: Partial<ConstructorParameters<typeof DownloadEngine>[0]> = {}) {
  const downloads = new Downloads(new InMemoryDownloadsStore());
  const engine = new DownloadEngine({ downloads, blobs: new Blobs(), fetchPage, ...extra });
  const events: DownloadEngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, downloads, events };
}

describe("pageRateLimit", () => {
  test("paces a bridge's pages across chapters, leaving undeclared bridges unpaced", async () => {
    const starts: Record<string, number[]> = { slow: [], fast: [] };
    const { engine } = setup(
      async (ctx) => {
        starts[ctx.bridgeId]!.push(Date.now());
        return ok();
      },
      { pageRateLimit: (id) => (id === "slow" ? { minIntervalMs: 60 } : undefined) },
    );
    await engine.enqueue(snap("slow"), ch("a"), pages(2));
    await engine.enqueue(snap("slow"), ch("b"), pages(2));
    await engine.enqueue(snap("fast"), ch("c"), pages(4));
    await engine.drain();

    const slow = starts.slow!;
    expect(slow).toHaveLength(4);
    for (let i = 1; i < slow.length; i++) expect(slow[i]! - slow[i - 1]!).toBeGreaterThanOrEqual(55);
    const fast = starts.fast!;
    expect(fast).toHaveLength(4);
    expect(fast.at(-1)! - fast[0]!).toBeLessThan(50);
  });

  test("a failing budget lookup doesn't stall the download", async () => {
    const { engine, downloads } = setup(async () => ok(), {
      pageRateLimit: () => {
        throw new Error("listing failed");
      },
    });
    await engine.enqueue(snap("b"), ch(), pages(2));
    await engine.drain();
    expect((await downloads.getChapter(entryKey("b", "s"), "c1"))?.state).toBe("complete");
  });
});

describe("rate-limited pages", () => {
  test("hold the bridge without failing the page, then resume on their own", async () => {
    let refuse = true;
    const calls: number[] = [];
    const { engine, downloads, events } = setup(
      async (_ctx, page) => {
        calls.push(page.index);
        if (refuse && page.index === 1) {
          refuse = false;
          throw new PageRateLimitedError(80);
        }
        return ok();
      },
      { pageConcurrency: 1 },
    );
    await engine.enqueue(snap("b"), ch(), pages(3));
    await engine.drain();

    const key = entryKey("b", "s");
    const held = await downloads.getChapter(key, "c1");
    expect(held?.state).not.toBe("failed");
    const heldPages = await downloads.getManifestPages(key, "c1");
    expect(heldPages.filter((p) => p.state === "failed")).toHaveLength(0);
    expect(heldPages.filter((p) => p.state === "complete")).toHaveLength(1);
    expect(engine.blockedUntilFor("b")).toBeGreaterThan(Date.now());
    expect(events.some((e) => e.type === "blocked" && e.bridgeId === "b")).toBe(true);
    expect(calls).toEqual([0, 1]);

    await sleep(200);
    await engine.drain();
    expect((await downloads.getChapter(key, "c1"))?.state).toBe("complete");
    expect(engine.blockedUntilFor("b")).toBeUndefined();
  });

  test("other bridges keep downloading while one is held", async () => {
    const { engine, downloads } = setup(async (ctx) => {
      if (ctx.bridgeId === "held") throw new Error("[rate-limited:60000] banned for an hour");
      return ok();
    });
    await engine.enqueue(snap("held"), ch(), pages(2));
    await engine.enqueue(snap("free"), ch(), pages(2));
    await engine.drain();
    engine.stop();
    expect((await downloads.getChapter(entryKey("free", "s"), "c1"))?.state).toBe("complete");
    const held = await downloads.getChapter(entryKey("held", "s"), "c1");
    expect(held?.state).not.toBe("failed");
    const heldPages = await downloads.getManifestPages(entryKey("held", "s"), "c1");
    expect(heldPages.filter((p) => p.state === "complete" || p.state === "failed")).toHaveLength(0);
    expect(engine.blockedUntilFor("held")).toBeGreaterThan(Date.now() + 50_000);
  });

  test("a rate-limited page resolution leaves the chapter pending instead of failed", async () => {
    let refuse = true;
    const { engine, downloads } = setup(async () => ok(), {
      resolvePages: async () => {
        if (refuse) {
          refuse = false;
          throw new PageRateLimitedError(60);
        }
        return pages(2);
      },
    });
    await engine.enqueue(snap("b"), ch());
    await engine.drain();
    const key = entryKey("b", "s");
    expect((await downloads.getChapter(key, "c1"))?.state).not.toBe("failed");

    await sleep(150);
    await engine.drain();
    expect((await downloads.getChapter(key, "c1"))?.state).toBe("complete");
  });

  test("stop() cancels the resume timer", async () => {
    let refuse = true;
    const { engine, downloads } = setup(async () => {
      if (refuse) {
        refuse = false;
        throw new PageRateLimitedError(40);
      }
      return ok();
    });
    await engine.enqueue(snap("b"), ch(), pages(1));
    await engine.drain();
    engine.stop();
    await sleep(120);
    expect((await downloads.getChapter(entryKey("b", "s"), "c1"))?.state).not.toBe("complete");
  });
});

describe("rateLimitedFromResponse / rateLimitWaitOf", () => {
  const res = (status: number, headers: Record<string, string> = {}) => ({ status, headers: new Headers(headers) });

  test("a 429 carries its Retry-After, or the default wait", () => {
    expect(rateLimitedFromResponse(res(429, { "Retry-After": "30" }))?.retryAfterMs).toBe(30_000);
    expect(rateLimitedFromResponse(res(429))?.retryAfterMs).toBe(60_000);
  });

  test("a 503 counts only with a named wait; other statuses never", () => {
    expect(rateLimitedFromResponse(res(503))).toBeNull();
    expect(rateLimitedFromResponse(res(503, { "Retry-After": "5" }))?.retryAfterMs).toBe(5_000);
    expect(rateLimitedFromResponse(res(500, { "Retry-After": "5" }))).toBeNull();
    expect(rateLimitedFromResponse(res(404))).toBeNull();
  });

  test("a relayed marker in the body wins over the header", () => {
    const body = '{"error":"[rate-limited:7200000] banned"}';
    expect(rateLimitedFromResponse(res(429, { "Retry-After": "5" }), body)?.retryAfterMs).toBe(7_200_000);
  });

  test("rateLimitWaitOf reads the error class, a duck-typed copy, or a marked message", () => {
    expect(rateLimitWaitOf(new PageRateLimitedError(5))).toBe(5);
    expect(rateLimitWaitOf({ name: "PageRateLimitedError", retryAfterMs: 9 })).toBe(9);
    expect(rateLimitWaitOf(new Error("x [rate-limited:42] y"))).toBe(42);
    expect(rateLimitWaitOf(new Error("HTTP 500"))).toBeUndefined();
    expect(rateLimitWaitOf(undefined)).toBeUndefined();
  });

  test("the router page resolver turns a 429 into a rate-limited error", async () => {
    const resolve = createRouterPageResolver(async () => ({
      ok: false,
      status: 429,
      headers: new Headers({ "Retry-After": "120" }),
      json: async () => ({}),
    }));
    const err = await resolve({ bridgeId: "b", seriesId: "s", chapterId: "c" }).catch((e: unknown) => e);
    expect(rateLimitWaitOf(err)).toBe(120_000);
  });
});
