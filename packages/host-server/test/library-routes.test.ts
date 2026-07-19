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

  test("lists: create → reorder → assign → filter → delete strips membership", async () => {
    const list = (await (await send("POST", "/library/lists", { name: "Reading" })).json()) as { id: string };
    expect(list.id).toBeTruthy();

    // reorder is a no-op with a single list but exercises the endpoint.
    expect((await send("POST", "/library/lists/reorder", { orderedIds: [list.id] })).status).toBe(200);

    await send("PUT", "/library/entries/demo/s1/lists", { listIds: [list.id] });
    const inList = (await (await get(`/library?list=${list.id}`)).json()) as Array<{ seriesId: string }>;
    expect(inList.map((e) => e.seriesId)).toEqual(["s1"]);

    await send("DELETE", `/library/lists/${list.id}`);
    const entry = (await (await get("/library/entries/demo/s1")).json()) as { entry: { listIds: string[] } };
    expect(entry.entry.listIds).toEqual([]);
  });

  test("query params: search (title/author), unreadOnly, sort, unlisted", async () => {
    // s1 ("Series One", 2 unread, now unlisted after the prior test deleted its list).
    // Add s2: a fully-read-free, unlisted, authored series.
    await send("POST", "/library/entries", { bridgeId: "demo", seriesId: "s2", title: "Other Tale", author: "Zed" });

    const titles = async (p: string) => ((await (await get(p)).json()) as Array<{ title: string }>).map((e) => e.title);
    const idsOf = async (p: string) => ((await (await get(p)).json()) as Array<{ seriesId: string }>).map((e) => e.seriesId);

    // q matches title (s1) vs author (s2), case-insensitively.
    expect(await idsOf("/library?q=SERIES")).toEqual(["s1"]);
    expect(await idsOf("/library?q=zed")).toEqual(["s2"]);

    // unreadOnly drops s2 (no synced chapters → 0 unread).
    expect(await idsOf("/library?unreadOnly=true")).toEqual(["s1"]);

    // sort=title is ascending.
    expect(await titles("/library?sort=title")).toEqual(["Other Tale", "Series One"]);

    // both are unlisted.
    expect(await idsOf("/library?unlisted=true&sort=title")).toEqual(["s2", "s1"]);

    // clean up so the later "activity purged" assertion stays unaffected.
    await send("DELETE", "/library/entries/demo/s2");
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

describe("sync + activity-count params", () => {
  test("activity/count?since= counts only items detected after the watermark", async () => {
    // Self-contained entry (prior tests removed theirs and purged the feed).
    await send("POST", "/library/entries", { bridgeId: "demo", seriesId: "act-1", title: "Active" });
    await send("POST", "/library/entries/demo/act-1/sync", { chapters: [chapters[0]!] }); // baseline
    await send("POST", "/library/entries/demo/act-1/sync", { chapters }); // c2, c3 detected

    const feed = (await (await get("/library/activity")).json()) as Array<{ detectedAt: number }>;
    expect(feed).toHaveLength(2);
    const newest = Math.max(...feed.map((a) => a.detectedAt));
    const oldest = Math.min(...feed.map((a) => a.detectedAt));

    const count = async (q = "") => ((await (await get(`/library/activity/count${q}`)).json()) as { unread: number }).unread;
    expect(await count()).toBe(2);
    expect(await count(`?since=${newest}`)).toBe(0); // boundary is excluded ("seen at" time)
    expect(await count(`?since=${oldest - 1}`)).toBe(2);
  });

  test("DELETE /library/activity/:bridgeId/:seriesId clears one series' feed only", async () => {
    // Two library entries, each with a fresh new chapter in the feed.
    await send("POST", "/library/entries", { bridgeId: "demo", seriesId: "clr-1", title: "Clear One" });
    await send("POST", "/library/entries", { bridgeId: "demo", seriesId: "clr-2", title: "Clear Two" });
    await send("POST", "/library/entries/demo/clr-1/sync", { chapters: [chapters[0]!] });
    await send("POST", "/library/entries/demo/clr-1/sync", { chapters }); // clr-1: c2, c3 detected
    await send("POST", "/library/entries/demo/clr-2/sync", { chapters: [chapters[0]!] });
    await send("POST", "/library/entries/demo/clr-2/sync", { chapters: [chapters[0]!, chapters[1]!] }); // clr-2: c2

    const seriesOf = async () =>
      ((await (await get("/library/activity")).json()) as Array<{ seriesId: string }>).map((a) => a.seriesId);
    expect((await seriesOf()).filter((s) => s === "clr-1")).toHaveLength(2);

    expect((await send("DELETE", "/library/activity/demo/clr-1")).status).toBe(200);
    const after = await seriesOf();
    expect(after).not.toContain("clr-1");
    expect(after).toContain("clr-2");
  });

  test("POST /library/activity/:bridgeId/:seriesId/read marks one series' feed read, resume untouched", async () => {
    // Two entries, each with new chapters in the feed (mrk-2 is the untouched control).
    await send("POST", "/library/entries", { bridgeId: "demo", seriesId: "mrk-1", title: "Mark One" });
    await send("POST", "/library/entries", { bridgeId: "demo", seriesId: "mrk-2", title: "Mark Two" });
    await send("POST", "/library/entries/demo/mrk-1/sync", { chapters: [chapters[0]!] });
    await send("POST", "/library/entries/demo/mrk-1/sync", { chapters }); // mrk-1: c2, c3 detected
    await send("POST", "/library/entries/demo/mrk-2/sync", { chapters: [chapters[0]!] });
    await send("POST", "/library/entries/demo/mrk-2/sync", { chapters: [chapters[0]!, chapters[1]!] }); // mrk-2: c2

    const res = await send("POST", "/library/activity/demo/mrk-1/read");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { marked: number }).marked).toBe(2);

    // mrk-1's items remain in the feed but read; mrk-2's stays unread.
    const feed = (await (await get("/library/activity")).json()) as Array<{ seriesId: string; read: boolean }>;
    expect(feed.filter((a) => a.seriesId === "mrk-1").map((a) => a.read)).toEqual([true, true]);
    expect(feed.find((a) => a.seriesId === "mrk-2")?.read).toBe(false);

    // Dismissing is not reading: no resume point on the entry.
    const entry = (await (await get("/library/entries/demo/mrk-1")).json()) as { resume?: unknown };
    expect(entry.resume ?? null).toBeNull();

    // Unknown series → 404 (withLibraryEntry mapping).
    expect((await send("POST", "/library/activity/demo/nope/read")).status).toBe(404);
  });

  test("POST /library/sync accepts options and reports the new result fields", async () => {
    const res = await send("POST", "/library/sync", { force: true, trackers: false, budgetMs: 10_000 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scanned: number; skipped: number; partial: boolean; suggestions: unknown[] };
    expect(body.scanned).toBeGreaterThanOrEqual(1); // the act-1 entry
    expect(body.skipped).toBe(0); // force syncs everything
    expect(body.partial).toBe(false);
    expect(body.suggestions).toEqual([]);

    // Bodyless call stays valid (back-compat) — and the staleness window now skips the fresh entry.
    const plain = await send("POST", "/library/sync");
    expect(plain.status).toBe(200);
    const plainBody = (await plain.json()) as { skipped: number };
    expect(plainBody.skipped).toBeGreaterThanOrEqual(1);
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
