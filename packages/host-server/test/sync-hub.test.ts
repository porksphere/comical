/**
 * The sync hub as a first-class sync node: it keeps the server-side `/library` store and the `/sync`
 * CRDT records converged in BOTH directions, so a web client (which browses /library) and a native
 * device (which syncs via /sync) end up with one library.
 *
 *   - native → web: records pushed to the hub are projected onto the library store.
 *   - web → native: writes to the (write-through) library store surface as pullable records.
 *
 * Unit tests drive the `SyncHub` directly against an in-memory store; one HTTP test proves the
 * native → web direction end to end (`POST /sync/push` → `GET /library`).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { InMemoryLibraryStore, Library, entryKey, type LibraryEntry } from "@comical/library";
import type { SyncRecord } from "@comical/sync";
import { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";
import { SyncHub } from "../src/sync-hub.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-sync-hub");
const TOKEN = "master-token";

const nthDir = (() => {
  let n = 0;
  return () => join(DATA_DIR, `hub-${n++}`);
})();

/** A minimal valid LibraryEntry. */
const entry = (bridgeId: string, seriesId: string, title: string): LibraryEntry => ({
  bridgeId,
  seriesId,
  title,
  listIds: [],
  addedAt: 1,
  updatedAt: 1,
});

/** An `entries` register record, as a native device would push it. */
const entryRecord = (e: LibraryEntry, node = "device-a"): SyncRecord => ({
  table: "entries",
  id: entryKey(e.bridgeId, e.seriesId),
  env: { kind: "register", hlc: `${"1".padStart(15, "0")}:${"0".repeat(6)}:${node}`, value: e, deleted: false },
});

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});
afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("SyncHub — native → web (push projects onto the library)", () => {
  test("a pushed entry record appears in the library store", async () => {
    const store = new InMemoryLibraryStore();
    const hub = new SyncHub(nthDir(), store);
    const e = entry("bridge", "s1", "Pushed Series");

    await hub.push("acct", [entryRecord(e)]);

    const got = await store.getEntry(entryKey("bridge", "s1"));
    expect(got?.title).toBe("Pushed Series");
  });

  test("a tombstone push removes the entry from the library store", async () => {
    const store = new InMemoryLibraryStore();
    const hub = new SyncHub(nthDir(), store);
    const e = entry("bridge", "s1", "Doomed");
    await hub.push("acct", [entryRecord(e)]);
    expect(await store.getEntry(entryKey("bridge", "s1"))).toBeTruthy();

    // A later tombstone (higher HLC) deletes it — cascade included.
    const tomb: SyncRecord = {
      table: "entries",
      id: entryKey("bridge", "s1"),
      env: { kind: "register", hlc: `${"9".padStart(15, "9")}:${"0".repeat(6)}:device-a`, value: null, deleted: true },
    };
    await hub.push("acct", [tomb]);
    expect(await store.getEntry(entryKey("bridge", "s1"))).toBeUndefined();
  });
});

describe("SyncHub — web → native (library writes become pullable records)", () => {
  test("an entry written through wrapLibrary() is returned by pull", async () => {
    const store = new InMemoryLibraryStore();
    const hub = new SyncHub(nthDir(), store);
    const wrapped = hub.wrapLibrary();

    await wrapped.putEntry(entry("bridge", "web1", "Added on the web"));

    const { records } = await hub.pull("acct", null);
    const ids = records.filter((r) => r.table === "entries").map((r) => r.id);
    expect(ids).toContain(entryKey("bridge", "web1"));
  });

  test("both directions converge: native's push and the web's write are both pullable and both in the store", async () => {
    const store = new InMemoryLibraryStore();
    const hub = new SyncHub(nthDir(), store);
    const wrapped = hub.wrapLibrary();

    await hub.push("acct", [entryRecord(entry("bridge", "native1", "From native"))]);
    await wrapped.putEntry(entry("bridge", "web1", "From web"));

    // The library store holds both (native via projection, web via the direct write).
    expect(await store.getEntry(entryKey("bridge", "native1"))).toBeTruthy();
    expect(await store.getEntry(entryKey("bridge", "web1"))).toBeTruthy();

    // And a device pulling from scratch sees both.
    const { records } = await hub.pull("acct", null);
    const ids = new Set(records.filter((r) => r.table === "entries").map((r) => r.id));
    expect(ids.has(entryKey("bridge", "native1"))).toBe(true);
    expect(ids.has(entryKey("bridge", "web1"))).toBe(true);
  });
});

describe("SyncHub — persistence", () => {
  test("records survive a reopen from the same directory", async () => {
    const dir = nthDir();
    const hub = new SyncHub(dir, new InMemoryLibraryStore());
    await hub.push("acct", [entryRecord(entry("bridge", "s1", "Persisted"))]);

    const reopened = new SyncHub(dir, new InMemoryLibraryStore());
    const { records } = await reopened.pull("acct", null);
    expect(records.map((r) => r.id)).toContain(entryKey("bridge", "s1"));
  });

  test("bootstraps from a legacy FileSyncStore file (per-account record array) and projects it", async () => {
    const dir = nthDir();
    mkdirSync(dir, { recursive: true });
    // The old layout: one JSON array of records per account.
    writeFileSync(join(dir, "some-account.json"), JSON.stringify([entryRecord(entry("bridge", "legacy1", "Legacy Library"))]));

    const store = new InMemoryLibraryStore();
    const hub = new SyncHub(dir, store);
    // A pull triggers the one-time bootstrap.
    const { records } = await hub.pull("acct", null);
    expect(records.map((r) => r.id)).toContain(entryKey("bridge", "legacy1"));
    // …and the legacy records are projected onto the library, so the web sees them.
    expect(await store.getEntry(entryKey("bridge", "legacy1"))).toBeTruthy();
  });
});

describe("native → web over HTTP (POST /sync/push → GET /library)", () => {
  test("an entry a device syncs is visible to a web client browsing the library", async () => {
    const store = new InMemoryLibraryStore();
    const hub = new SyncHub(nthDir(), store);
    const manager = new BridgeManager({ bridgesDir: BRIDGES_DIR, dataDir: DATA_DIR, settings: new SettingsStore(DATA_DIR) });
    const lib = new Library(hub.wrapLibrary());
    const srv = Bun.serve({ port: 0, fetch: createRouter(manager, { sync: hub, library: lib, token: TOKEN }).fetch });
    const base = `http://localhost:${srv.port}`;
    const auth = { Authorization: `Bearer ${TOKEN}`, "X-Comical-Account": "acct", "Content-Type": "application/json" };
    try {
      const push = await fetch(`${base}/sync/push`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify([entryRecord(entry("bridge", "http1", "Synced Series"))]),
      });
      expect(push.status).toBe(200);

      const libResp = (await (await fetch(`${base}/library`, { headers: auth })).json()) as { entries?: { seriesId: string; title: string }[] } | { seriesId: string; title: string }[];
      const entries = Array.isArray(libResp) ? libResp : (libResp.entries ?? []);
      expect(entries.some((e) => e.title === "Synced Series")).toBe(true);
    } finally {
      srv.stop(true);
    }
  });
});
