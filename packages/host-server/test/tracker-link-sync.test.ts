/**
 * Tests the scoped per-entry TWO-WAY sync route:
 * POST /library/entries/:bridgeId/:seriesId/tracker-links/:trackerId/sync
 *
 * Whichever side has read further wins: the tracker's state is applied locally when it's ahead,
 * and the local count is pushed to the tracker when *it* is ahead.
 *
 * Uses a real ComicalRuntime + Library over a FileLibraryStore, with a hand-rolled TrackerProvider
 * standing in for loaded trackers — the runtime only depends on the TrackerProvider shape
 * (get/list), same pattern as `@comical/runtime`'s own tests.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Tracker, TrackerLibraryEntry } from "@comical/contract";
import { Library } from "@comical/library";
import { ComicalRuntime, type TrackerProvider } from "@comical/runtime";
import { BridgeManager } from "../src/bridge-manager.ts";
import { FileLibraryStore } from "../src/library-store.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-tracker-link-sync");

// Mutable list the mock "anilist" tracker's getLibrary reads from — tests reassign it per-case.
let anilistEntries: TrackerLibraryEntry[] = [];

const anilistTracker: Tracker = {
  info: { id: "anilist", name: "AniList", version: "0.0.0", contractVersion: "1.0.0", capabilities: ["library-sync"] },
  async getLibrary(page) {
    void page;
    return { items: anilistEntries, page: 1, hasNextPage: false };
  },
};

// A push-only tracker (status-sync, no library-sync): exercises the push half of the two-way sync.
const malUpdates: Array<{ externalId: string | number; chaptersRead?: number }> = [];
const malTracker: Tracker = {
  info: { id: "mal", name: "MAL", version: "0.0.0", contractVersion: "1.0.0", capabilities: ["status-sync"] },
  async updateEntry(externalId, update) {
    malUpdates.push({ externalId, ...(update.chaptersRead !== undefined && { chaptersRead: update.chaptersRead }) });
  },
};

// A tracker that can neither pull nor push, to exercise the capability-error path.
const inertTracker: Tracker = {
  info: { id: "inert", name: "Inert", version: "0.0.0", contractVersion: "1.0.0", capabilities: ["search"] },
};

const trackerProvider: TrackerProvider = {
  get: async (id) => {
    if (id === "anilist") return anilistTracker;
    if (id === "mal") return malTracker;
    if (id === "inert") return inertTracker;
    throw new Error(`tracker not found: ${id}`);
  },
  list: async () => [
    { info: { id: "anilist", capabilities: anilistTracker.info.capabilities } },
    { info: { id: "mal", capabilities: malTracker.info.capabilities } },
    { info: { id: "inert", capabilities: inertTracker.info.capabilities } },
  ],
};

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
  const runtime = new ComicalRuntime({ bridges: manager, library, trackers: trackerProvider });
  const srv = Bun.serve({ port: 0, fetch: createRouter(manager, { library, runtime }).fetch });
  baseUrl = `http://localhost:${srv.port}`;
  stop = () => srv.stop(true);
});

afterAll(() => {
  stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("POST /library/entries/:bridgeId/:seriesId/tracker-links/:trackerId/sync", () => {
  test("404s when the entry has no link for that tracker", async () => {
    await send("POST", "/library/entries", { bridgeId: "demo", seriesId: "sync-1", title: "Series" });

    const res = await send("POST", "/library/entries/demo/sync-1/tracker-links/anilist/sync");
    expect(res.status).toBe(404);
  });

  test("pulls and applies the linked entry's tracker state", async () => {
    await send("POST", "/library/entries/demo/sync-1/tracker-links", { trackerId: "anilist", externalId: 111 });
    anilistEntries = [{ externalId: 111, title: "Series", status: "reading", chaptersRead: 3 }];

    const res = await send("POST", "/library/entries/demo/sync-1/tracker-links/anilist/sync");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: boolean; readSynced: number };
    expect(body.updated).toBe(true);

    const links = (await (await get("/library/entries/demo/sync-1/tracker-links")).json()) as Array<{
      trackerId: string;
      status: string;
      chaptersRead?: number;
    }>;
    expect(links[0]).toMatchObject({ trackerId: "anilist", status: "reading", chaptersRead: 3 });
  });

  test("returns updated:false (not an error) when neither side has anything to move", async () => {
    anilistEntries = []; // tracker's list no longer contains externalId 111
    const res = await send("POST", "/library/entries/demo/sync-1/tracker-links/anilist/sync");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: false, readSynced: 0, pushed: false, chaptersRead: 0 });
  });

  test("pushes the local read count to a push-only tracker when local is ahead", async () => {
    await send("POST", "/library/entries", { bridgeId: "demo", seriesId: "sync-2", title: "Pushed" });
    await send("POST", "/library/entries/demo/sync-2/tracker-links", { trackerId: "mal", externalId: 222 });
    await send("PUT", "/library/entries/demo/sync-2/progress/c4", { read: true, chapterName: "Ch 4", number: 4 });
    malUpdates.length = 0; // ignore the implicit push the read above already made

    const res = await send("POST", "/library/entries/demo/sync-2/tracker-links/mal/sync");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: true, readSynced: 0, pushed: true, chaptersRead: 4 });
    expect(malUpdates).toEqual([{ externalId: 222, chaptersRead: 4 }]);
  });

  test("400s when the linked tracker can neither pull nor push", async () => {
    await send("POST", "/library/entries/demo/sync-1/tracker-links", { trackerId: "inert", externalId: 333 });

    const res = await send("POST", "/library/entries/demo/sync-1/tracker-links/inert/sync");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/neither library-sync nor status-sync/);
  });
});
