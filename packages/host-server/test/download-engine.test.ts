/**
 * Server-managed downloads: the DownloadEngine composed behind the router (the host fetches page
 * bytes via its own bridges, stores blobs on disk, serves them back, streams SSE progress). Mirrors
 * the composition in `server.ts` — Downloads + FileBlobStore + createServerPageFetcher with a
 * late-bound router fetch — against the testkit fixture backend.
 *
 * Drain tests use LOCAL sourceUrls only (the fixture's `/img/*` for the absolute-URL fetch path and
 * the router's own `/test-sprite.svg` for the in-process resolution path) — the fixture bridge's
 * real page URLs point at picsum.photos, and tests must not depend on external network.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DownloadEngine, Downloads } from "@comical/downloads";
import { FixtureBackend } from "@comical/testkit";
import { BridgeManager } from "../src/bridge-manager.ts";
import { FileBlobStore } from "../src/blob-store.ts";
import { FileDownloadsStore } from "../src/downloads-store.ts";
import { createServerPageFetcher } from "../src/page-fetcher.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-download-engine");
const BLOBS_DIR = join(DATA_DIR, "downloads", "blobs");

let baseUrl: string;
let fixtureUrl: string;
let stop: () => void;
let fixtureStop: () => void;

const get = (p: string) => fetch(`${baseUrl}${p}`);
const send = (method: string, p: string, body?: unknown) =>
  fetch(`${baseUrl}${p}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });

/** Poll the storage tree until `pred` matches (the engine drains asynchronously). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function waitForUsage<T>(pred: (usage: any) => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const usage = await (await get("/downloads")).json();
    const hit = pred(usage);
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting; last usage: ${JSON.stringify(usage)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chapterIn = (usage: any, seriesId: string, chapterId: string) =>
  usage.bySeries
    ?.find((s: { seriesId: string }) => s.seriesId === seriesId)
    ?.chapters.find((c: { chapterId: string }) => c.chapterId === chapterId);

beforeAll(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  const fixture = new FixtureBackend().serve();
  fixtureUrl = fixture.url;
  fixtureStop = fixture.stop;

  const settings = new SettingsStore(DATA_DIR);
  await settings.set("example", { baseUrl: fixture.url });
  const manager = new BridgeManager({ bridgesDir: BRIDGES_DIR, dataDir: DATA_DIR, settings });

  const downloads = new Downloads(new FileDownloadsStore(join(DATA_DIR, "downloads")));
  let routerFetch: (req: Request) => Response | Promise<Response> = () => new Response(null, { status: 503 });
  const engine = new DownloadEngine({
    downloads,
    blobs: new FileBlobStore(BLOBS_DIR),
    fetchPage: createServerPageFetcher(() => routerFetch),
  });
  const router = createRouter(manager, { downloads, downloadEngine: engine });
  routerFetch = (req) => router.fetch(req);

  const srv = Bun.serve({ port: 0, fetch: router.fetch });
  baseUrl = `http://localhost:${srv.port}`;
  stop = () => srv.stop(true);
});

afterAll(() => {
  stop();
  fixtureStop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("server-managed download lifecycle", () => {
  test("full drain: blobs land on disk, /file serves bytes, delete unlinks server-side", async () => {
    // One page via the absolute-URL fetch path (the fixture's HTTP server), one via the in-process
    // router path (a server-relative sourceUrl resolved by driving the router directly).
    const enq = await send("POST", "/downloads/entries/example/local/chapters/c1", {
      title: "Local",
      pages: [
        { index: 0, sourceUrl: `${fixtureUrl}/img/p0.png` },
        { index: 1, sourceUrl: "/test-sprite.svg" },
      ],
    });
    expect(enq.status).toBe(201);

    const done = await waitForUsage((u) => {
      const c = chapterIn(u, "local", "c1");
      return c?.state === "complete" ? c : undefined;
    });
    expect(done.completedPages).toBe(2);
    expect(done.bytes).toBeGreaterThan(0);

    // Blobs landed under the server's blob root.
    expect(existsSync(join(BLOBS_DIR, "example", "local", "c1"))).toBe(true);

    // The storage tree carries the blob root's actual size when the host owns the bytes.
    const withDisk = (await (await get("/downloads")).json()) as { totalBytes: number; diskBytes?: number };
    expect(withDisk.diskBytes).toBe(withDisk.totalBytes);

    // The /file route serves the downloaded bytes with the stored content type.
    const file = await get("/downloads/entries/example/local/chapters/c1/pages/0/file");
    expect(file.status).toBe(200);
    expect(file.headers.get("Content-Type")).toBe("image/png"); // fixture's /img/* serves PNG
    expect(file.headers.get("Cache-Control")).toContain("immutable");
    expect((await file.arrayBuffer()).byteLength).toBeGreaterThan(0);

    // A page that isn't downloaded 404s.
    expect((await get("/downloads/entries/example/local/chapters/c1/pages/999/file")).status).toBe(404);

    // Delete: the SERVER unlinks its blobs and returns an empty files list.
    const del = (await (await send("DELETE", "/downloads/entries/example/local/chapters/c1")).json()) as { files: string[] };
    expect(del.files).toEqual([]);
    expect(existsSync(join(BLOBS_DIR, "example", "local"))).toBe(false);
    expect(((await (await get("/downloads")).json()) as { totalBytes: number }).totalBytes).toBe(0);
  });

  test("pages-less enqueue resolves the page list via the bridge", async () => {
    const chapters = (await (await get("/bridges/example/series/alice/chapters")).json()) as Array<{ id: string }>;
    const chapterId = chapters[0]!.id;

    // Enqueue WITHOUT pages — the router asks the bridge for them. Pause immediately: the fixture
    // bridge's page URLs point at an external host, and this test only asserts resolution.
    const enq = await send("POST", `/downloads/entries/example/alice/chapters/${encodeURIComponent(chapterId)}`, {
      title: "Alice",
    });
    expect(enq.status).toBe(201);
    const enqueued = (await enq.json()) as { pageCount: number; state: string };
    expect(enqueued.pageCount).toBeGreaterThan(0);
    expect(enqueued.state).toBe("queued");

    await send("POST", `/downloads/entries/example/alice/chapters/${encodeURIComponent(chapterId)}/pause`);
    await send("DELETE", "/downloads/entries/example/alice");
  });

  test("pages-less enqueue for an unknown bridge is 404", async () => {
    const res = await send("POST", "/downloads/entries/nonexistent/s/chapters/c", { title: "X" });
    expect(res.status).toBe(404);
  });

  test(
    "SSE /downloads/events streams page and chapter progress",
    async () => {
      const res = await get("/downloads/events");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type") ?? "").toContain("text/event-stream");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      await send("POST", "/downloads/entries/example/ssetest/chapters/cS", {
        title: "SSE",
        pages: [
          { index: 0, sourceUrl: `${fixtureUrl}/img/s0.png` },
          { index: 1, sourceUrl: `${fixtureUrl}/img/s1.png` },
        ],
      });

      let buf = "";
      const deadline = Date.now() + 10_000;
      let sawPage = false;
      let sawComplete = false;
      while (!sawComplete && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (const frame of buf.split("\n\n")) {
          if (frame.includes("event: page")) sawPage = true;
          if (frame.includes("event: chapter") && frame.includes('"complete"')) sawComplete = true;
        }
      }
      await reader.cancel();
      expect(sawPage).toBe(true);
      expect(sawComplete).toBe(true);

      await send("DELETE", "/downloads/entries/example/ssetest");
    },
    20_000,
  );

  test("pause and resume delegate to the engine", async () => {
    // Unreachable page keeps the chapter pending, which is enough to exercise the engine-delegated
    // pause/resume routes.
    await send("POST", "/downloads/entries/example/pausable/chapters/cP", {
      title: "Pausable",
      pages: [{ index: 0, sourceUrl: "http://127.0.0.1:9/never" }],
    });
    const paused = (await (await send("POST", "/downloads/entries/example/pausable/chapters/cP/pause")).json()) as { state: string };
    expect(paused.state).toBe("paused");
    const resumed = (await (await send("POST", "/downloads/entries/example/pausable/chapters/cP/resume")).json()) as { state: string };
    expect(resumed.state).toBe("queued");
    await send("POST", "/downloads/entries/example/pausable/chapters/cP/pause");
    await send("DELETE", "/downloads/entries/example/pausable");
  });
});

describe("blob path safety", () => {
  test("FileBlobStore rejects traversal paths", async () => {
    const store = new FileBlobStore(join(DATA_DIR, "safety-root"));
    expect(store.write("../evil.bin", new Uint8Array(1))).rejects.toThrow("invalid blob path");
    expect(await store.read("../../etc/passwd")).toBeUndefined();
    await store.remove(["../evil.bin"]); // must not throw
  });
});

describe("absence: engine not provided", () => {
  test("manifest-only mode keeps the old contract (pages required, no /file, no /events)", async () => {
    const manager = new BridgeManager({
      bridgesDir: BRIDGES_DIR,
      dataDir: DATA_DIR,
      settings: new SettingsStore(DATA_DIR),
    });
    const downloads = new Downloads(new FileDownloadsStore(join(DATA_DIR, "manifest-only")));
    const srv = Bun.serve({ port: 0, fetch: createRouter(manager, { downloads }).fetch });
    const base = `http://localhost:${srv.port}`;
    try {
      // Pages-less enqueue is still a 400 without an engine.
      const enq = await fetch(`${base}/downloads/entries/example/alice/chapters/c1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Alice" }),
      });
      expect(enq.status).toBe(400);
      // Engine-only routes don't exist.
      expect((await fetch(`${base}/downloads/entries/example/alice/chapters/c1/pages/0/file`)).status).toBe(404);
      expect((await fetch(`${base}/downloads/events`)).status).toBe(404);
    } finally {
      srv.stop(true);
    }
  });
});
