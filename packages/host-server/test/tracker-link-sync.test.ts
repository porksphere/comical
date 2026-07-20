/**
 * Tests the scoped per-entry pull-sync route:
 * POST /library/entries/:bridgeId/:seriesId/tracker-links/:trackerId/sync
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

// A second tracker that does NOT support library-sync, to exercise the capability-error path.
const malTracker: Tracker = {
  info: { id: "mal", name: "MAL", version: "0.0.0", contractVersion: "1.0.0", capabilities: ["status-sync"] },
};

const trackerProvider: TrackerProvider = {
  get: async (id) => {
    if (id === "anilist") return anilistTracker;
    if (id === "mal") return malTracker;
    throw new Error(`tracker not found: ${id}`);
  },
  list: async () => [
    { info: { id: "anilist", capabilities: anilistTracker.info.capabilities } },
    { info: { id: "mal", capabilities: malTracker.info.capabilities } },
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

  test("returns updated:false (not an error) when the tracker's list no longer contains this entry", async () => {
    anilistEntries = []; // tracker's list no longer contains externalId 111
    const res = await send("POST", "/library/entries/demo/sync-1/tracker-links/anilist/sync");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: false, readSynced: 0 });
  });

  test("400s when the linked tracker doesn't support library-sync", async () => {
    await send("POST", "/library/entries/demo/sync-1/tracker-links", { trackerId: "mal", externalId: 222 });

    const res = await send("POST", "/library/entries/demo/sync-1/tracker-links/mal/sync");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/does not support library-sync/);
  });
});
