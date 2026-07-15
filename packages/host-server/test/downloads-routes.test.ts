/**
 * The optional /downloads routes over a FileDownloadsStore on a temp dir. Exercises the full client
 * flow (enqueue → record pages → storage tree → offline manifest → delete), and asserts the routes
 * are entirely ABSENT when the downloads module isn't enabled.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Downloads } from "@comical/downloads";
import { BridgeManager } from "../src/bridge-manager.ts";
import { FileDownloadsStore } from "../src/downloads-store.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-downloads");

const pages = (n: number) => Array.from({ length: n }, (_, i) => ({ index: i, sourceUrl: `/img/${i}`, headers: { referer: "x" } }));

let baseUrl: string;
let stop: () => void;

const get = (p: string) => fetch(`${baseUrl}${p}`);
const send = (method: string, p: string, body?: unknown) =>
  fetch(`${baseUrl}${p}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });

beforeAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  const manager = new BridgeManager({
    bridgesDir: BRIDGES_DIR,
    dataDir: DATA_DIR,
    settings: new SettingsStore(DATA_DIR),
  });
  const downloads = new Downloads(new FileDownloadsStore(join(DATA_DIR, "downloads")));
  const srv = Bun.serve({ port: 0, fetch: createRouter(manager, { downloads }).fetch });
  baseUrl = `http://localhost:${srv.port}`;
  stop = () => srv.stop(true);
});

afterAll(() => {
  stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("/downloads lifecycle", () => {
  test("enqueue → record pages → storage tree → manifest → delete", async () => {
    // enqueue a 2-page chapter
    const enq = await send("POST", "/downloads/entries/demo/s1/chapters/c1", {
      title: "Series One",
      thumbnailUrl: "https://example.com/t.jpg",
      chapterName: "Chapter 1",
      number: 1,
      pages: pages(2),
    });
    expect(enq.status).toBe(201);
    expect(((await enq.json()) as { state: string }).state).toBe("queued");

    // pending queue lists it
    const pending = (await (await get("/downloads/pending")).json()) as Array<{ chapterId: string }>;
    expect(pending.map((c) => c.chapterId)).toEqual(["c1"]);

    // record both pages
    expect((await send("POST", "/downloads/entries/demo/s1/chapters/c1/pages/0", { file: "demo/s1/c1/0.jpg", bytes: 100 })).status).toBe(200);
    const rec = (await (await send("POST", "/downloads/entries/demo/s1/chapters/c1/pages/1", { file: "demo/s1/c1/1.jpg", bytes: 150 })).json()) as { state: string; bytes: number };
    expect(rec.state).toBe("complete");
    expect(rec.bytes).toBe(250);

    // storage tree
    const usage = (await (await get("/downloads")).json()) as { totalBytes: number; seriesCount: number; pageCount: number; bySeries: Array<{ seriesId: string; chapters: Array<{ bytes: number }> }> };
    expect(usage.totalBytes).toBe(250);
    expect(usage.seriesCount).toBe(1);
    expect(usage.pageCount).toBe(2);
    expect(usage.bySeries[0]?.chapters[0]?.bytes).toBe(250);

    // manifest page list (offline fallback), ordered with local files
    const manifest = (await (await get("/downloads/entries/demo/s1/chapters/c1/pages")).json()) as Array<{ index: number; file: string }>;
    expect(manifest.map((p) => p.file)).toEqual(["demo/s1/c1/0.jpg", "demo/s1/c1/1.jpg"]);

    // delete the chapter → returns blob paths, prunes the emptied series
    const del = (await (await send("DELETE", "/downloads/entries/demo/s1/chapters/c1")).json()) as { files: string[] };
    expect(del.files.sort()).toEqual(["demo/s1/c1/0.jpg", "demo/s1/c1/1.jpg"]);
    expect((await get("/downloads/entries/demo/s1")).status).toBe(404);
    expect(((await (await get("/downloads")).json()) as { totalBytes: number }).totalBytes).toBe(0);
  });

  test("recording a page for an unknown chapter is 404", async () => {
    const res = await send("POST", "/downloads/entries/demo/nope/chapters/cX/pages/0", { file: "x", bytes: 1 });
    expect(res.status).toBe(404);
  });

  test("prefs default and update", async () => {
    expect(await (await get("/downloads/prefs")).json()).toEqual({ wifiOnly: true, background: false });
    const updated = await (await send("PUT", "/downloads/prefs", { wifiOnly: false })).json();
    expect(updated).toEqual({ wifiOnly: false, background: false });
  });
});

describe("/downloads absence", () => {
  test("routes 404 when the downloads module isn't enabled", async () => {
    const manager = new BridgeManager({
      bridgesDir: BRIDGES_DIR,
      dataDir: DATA_DIR,
      settings: new SettingsStore(DATA_DIR),
    });
    const srv = Bun.serve({ port: 0, fetch: createRouter(manager).fetch });
    try {
      expect((await fetch(`http://localhost:${srv.port}/downloads`)).status).toBe(404);
    } finally {
      srv.stop(true);
    }
  });
});
