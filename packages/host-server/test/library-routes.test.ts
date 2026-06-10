/**
 * The optional /library routes over a FileLibraryStore on a temp dir. Exercises the full client
 * flow, and asserts the routes are entirely ABSENT when the library module isn't enabled.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Library } from "@comical/library";
import { ComicalRuntime } from "@comical/runtime";
import { BridgeManager } from "../src/bridge-manager.ts";
import { FileLibraryStore } from "../src/library-store.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-library");

const chapters = [
  { id: "c1", name: "Ch 1", number: 1 },
  { id: "c2", name: "Ch 2", number: 2 },
  { id: "c3", name: "Ch 3", number: 3 },
];

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
  const library = new Library(new FileLibraryStore(join(DATA_DIR, "library")));
  const runtime = new ComicalRuntime({ bridges: manager, library });
  const srv = Bun.serve({ port: 0, fetch: createRouter(manager, { library, runtime }).fetch });
  baseUrl = `http://localhost:${srv.port}`;
  stop = () => srv.stop(true);
});

afterAll(() => {
  stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("/library lifecycle", () => {
  test("add → sync(baseline) → progress → unreadCount → read-up-to → new-chapter → history", async () => {
    // add
    const add = await send("POST", "/library/entries", { bridgeId: "demo", seriesId: "s1", title: "Series One" });
    expect(add.status).toBe(201);

    // first sync is a baseline (nothing "added")
    const sync1 = (await (await send("POST", "/library/entries/demo/s1/sync", { chapters })).json()) as { added: unknown[] };
    expect(sync1.added).toHaveLength(0);

    // mark c1 read
    expect((await send("PUT", "/library/entries/demo/s1/progress/c1", { read: true })).status).toBe(200);

    // library list shows unreadCount = 2 (c2, c3)
    const lib = (await (await get("/library")).json()) as Array<{ seriesId: string; unreadCount: number }>;
    expect(lib.find((e) => e.seriesId === "s1")?.unreadCount).toBe(2);

    // read up to c2 → unread 1
    expect((await send("POST", "/library/entries/demo/s1/read-up-to", { chapters, chapterId: "c2" })).status).toBe(200);
    const lib2 = (await (await get("/library")).json()) as Array<{ seriesId: string; unreadCount: number }>;
    expect(lib2.find((e) => e.seriesId === "s1")?.unreadCount).toBe(1);

    // a later sync surfaces a genuinely new chapter
    const sync2 = (await (await send("POST", "/library/entries/demo/s1/sync", { chapters: [...chapters, { id: "c4", name: "Ch 4", number: 4 }] })).json()) as { added: { id: string }[] };
    expect(sync2.added.map((c) => c.id)).toEqual(["c4"]);

    // the new chapter shows up in the activity feed (unread), and the badge count reflects it
    const activity = (await (await get("/library/activity")).json()) as Array<{ chapterId: string; read: boolean }>;
    expect(activity.map((a) => a.chapterId)).toEqual(["c4"]);
    expect(activity[0]!.read).toBe(false);
    expect(((await (await get("/library/activity/count")).json()) as { unread: number }).unread).toBe(1);

    // history has the series
    const history = (await (await get("/library/history?limit=10")).json()) as Array<{ seriesId: string }>;
    expect(history.some((h) => h.seriesId === "s1")).toBe(true);
  });

  test("categories: create → assign → filter → delete strips membership", async () => {
    const cat = (await (await send("POST", "/library/categories", { name: "Reading" })).json()) as { id: string };
    expect(cat.id).toBeTruthy();

    await send("PUT", "/library/entries/demo/s1/categories", { categoryIds: [cat.id] });
    const inCat = (await (await get(`/library?category=${cat.id}`)).json()) as Array<{ seriesId: string }>;
    expect(inCat.map((e) => e.seriesId)).toEqual(["s1"]);

    await send("DELETE", `/library/categories/${cat.id}`);
    const entry = (await (await get("/library/entries/demo/s1")).json()) as { entry: { categoryIds: string[] } };
    expect(entry.entry.categoryIds).toEqual([]);
  });

  test("remove → entry is gone (404) and its activity is purged", async () => {
    expect((await send("DELETE", "/library/entries/demo/s1")).status).toBe(200);
    expect((await get("/library/entries/demo/s1")).status).toBe(404);
    expect(await (await get("/library/activity")).json()).toEqual([]);
  });

  test("reading-history records a non-library read's page and updates it on revisit", async () => {
    expect((await send("POST", "/reading-history", {
      bridgeId: "demo", seriesId: "ext-1", title: "External", chapterId: "c2", chapterName: "Ch 2", lastPage: 8,
    })).status).toBe(200);

    const history = (await (await get("/library/history?limit=10")).json()) as Array<{ seriesId: string; lastReadChapterId?: string; lastPage?: number }>;
    const item = history.find((h) => h.seriesId === "ext-1");
    expect(item?.lastReadChapterId).toBe("c2");
    expect(item?.lastPage).toBe(8);

    // A later read at a further page moves the resume point.
    await send("POST", "/reading-history", {
      bridgeId: "demo", seriesId: "ext-1", title: "External", chapterId: "c2", chapterName: "Ch 2", lastPage: 14,
    });
    const history2 = (await (await get("/library/history?limit=10")).json()) as Array<{ seriesId: string; lastPage?: number }>;
    expect(history2.find((h) => h.seriesId === "ext-1")?.lastPage).toBe(14);
  });

  test("validation: add without bridgeId is 400", async () => {
    expect((await send("POST", "/library/entries", { seriesId: "x", title: "T" })).status).toBe(400);
  });
});

describe("disabled by default", () => {
  test("no /library routes when opts.library is omitted", async () => {
    const manager = new BridgeManager({
      bridgesDir: BRIDGES_DIR,
      dataDir: DATA_DIR,
      settings: new SettingsStore(DATA_DIR),
    });
    const srv = Bun.serve({ port: 0, fetch: createRouter(manager).fetch });
    try {
      const res = await fetch(`http://localhost:${srv.port}/library`);
      expect(res.status).toBe(404);
    } finally {
      srv.stop(true);
    }
  });
});
