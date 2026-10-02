/**
 * The library backup routes: the export a client saves to a file, and the restore that reads one
 * back. The library's own merge rules are covered in `packages/library/test/backup.test.ts`; what
 * is pinned here is the HTTP surface and the part only a host knows — the note of registries and
 * installs written out with it, and that a restore acts on none of it. Also asserts both routes are
 * ABSENT when the router has no library wired in.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { entryKey, InMemoryLibraryStore, Library, LIBRARY_BACKUP_FORMAT, type LibraryBackup, type LibraryRestoreCounts } from "@comical/library";
import { BridgeManager } from "../src/bridge-manager.ts";
import type { RegistryProvider } from "../src/registry-provider.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-library-backup");
const REGISTRY = "https://registry.example/index.json";

type RestoreResult = { restored: LibraryRestoreCounts; skipped: number };

/** A registry that records what it was asked to do. */
function mockRegistry() {
  const state = {
    registries: [] as Array<{ url: string; requireSignature?: boolean }>,
    bridges: [] as Array<{ id: string; registryUrl: string | null }>,
    trackers: [] as Array<{ id: string; registryUrl: string | null }>,
  };
  const install = (list: Array<{ id: string; registryUrl: string | null }>) => async (registryUrl: string, id: string) => {
    list.push({ id, registryUrl });
    return { id };
  };
  const manager = {
    list: async () => state.registries,
    add: async (url: string, opts: { requireSignature?: boolean } = {}) => {
      const saved = { url, ...opts };
      state.registries.push(saved);
      return saved;
    },
    allInstalled: async () => state.bridges,
    allInstalledTrackers: async () => state.trackers,
    install: install(state.bridges),
    installTracker: install(state.trackers),
  } as unknown as RegistryProvider;
  return { state, manager };
}

let library: Library;
let registry: ReturnType<typeof mockRegistry>;
let baseUrl: string;
let noRegistryUrl: string;
let noLibraryUrl: string;
let stop: () => void;

const post = (url: string, body: unknown) =>
  fetch(`${url}/library/backup/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const exported = async (url = baseUrl) => (await (await fetch(`${url}/library/backup`)).json()) as LibraryBackup;

/** One collected series with progress, and one that was only read. */
async function seed(lib: Library) {
  await lib.collectSeries({ bridgeId: "demo", seriesId: "kept" }, { seriesTitle: "Kept" });
  await lib.setProgress(entryKey("demo", "kept"), "c1", 9, 10);
  await lib.recordRead({ bridgeId: "demo", seriesId: "passing", title: "Passing", lastReadAt: 5 });
  await lib.setProgress(entryKey("demo", "passing"), "p1", 2, 10);
}

beforeAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  const manager = new BridgeManager({ bridgesDir: BRIDGES_DIR, dataDir: DATA_DIR, settings: new SettingsStore(DATA_DIR) });
  library = new Library(new InMemoryLibraryStore());
  // The router holds one registry object for its lifetime; each test swaps what it delegates to.
  const delegating = new Proxy({}, { get: (_t, prop) => Reflect.get(registry.manager, prop) }) as RegistryProvider;

  const srv = Bun.serve({ port: 0, fetch: createRouter(manager, { library, registry: delegating }).fetch });
  const plain = Bun.serve({ port: 0, fetch: createRouter(manager, { library }).fetch });
  const bare = Bun.serve({ port: 0, fetch: createRouter(manager).fetch });
  baseUrl = `http://localhost:${srv.port}`;
  noRegistryUrl = `http://localhost:${plain.port}`;
  noLibraryUrl = `http://localhost:${bare.port}`;
  stop = () => { srv.stop(true); plain.stop(true); bare.stop(true); };
});

afterAll(() => {
  stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  Reflect.set(library, "store", new InMemoryLibraryStore());
  registry = mockRegistry();
});

describe("GET /library/backup", () => {
  test("returns the library, read-only series included", async () => {
    await seed(library);
    const res = await fetch(`${baseUrl}/library/backup`);
    expect(res.status).toBe(200);
    const backup = (await res.json()) as LibraryBackup;

    expect(backup.format).toBe(LIBRARY_BACKUP_FORMAT);
    expect(backup.items.map((i) => i.id)).toEqual(["series:demo:kept"]);
    expect(backup.readingLog.map((h) => h.seriesId)).toEqual(["passing"]);
    expect(Object.keys(backup.progress).sort()).toEqual([entryKey("demo", "kept"), entryKey("demo", "passing")]);
  });

  test("names the saved registries and what was installed from them", async () => {
    registry.state.registries.push({ url: REGISTRY, requireSignature: true });
    registry.state.bridges.push({ id: "demo", registryUrl: REGISTRY }, { id: "sideloaded", registryUrl: null });
    registry.state.trackers.push({ id: "anilist", registryUrl: REGISTRY });

    expect((await exported()).sources).toEqual({
      // The url alone: whether its signature is required is not a file's to say.
      registries: [{ url: REGISTRY }],
      // A bridge that didn't come from a registry has no registry to name.
      bridges: [{ id: "demo", registryUrl: REGISTRY }],
      trackers: [{ id: "anilist", registryUrl: REGISTRY }],
    });
  });

  test("has no sources on a host without a registry", async () => {
    expect((await exported(noRegistryUrl)).sources).toBeUndefined();
  });
});

describe("POST /library/backup/restore", () => {
  test("puts an exported library back into an empty one", async () => {
    await seed(library);
    const backup = await exported();
    Reflect.set(library, "store", new InMemoryLibraryStore());

    const res = await post(baseUrl, backup);
    expect(res.status).toBe(200);
    const result = (await res.json()) as RestoreResult;

    expect(result).toEqual({
      restored: { collections: 0, items: 1, progress: 2, groups: 0, trackerLinks: 0, readingLog: 1, bridgePrefs: 0 },
      skipped: 0,
    });
    expect(await library.isCollected(entryKey("demo", "kept"))).toBe(true);
    expect((await library.getProgress(entryKey("demo", "passing")))[0]).toMatchObject({ chapterId: "p1", lastPage: 2 });
  });

  test("keeps what the library gained since the backup", async () => {
    await seed(library);
    const backup = await exported();
    await library.collectSeries({ bridgeId: "demo", seriesId: "newer" }, { seriesTitle: "Newer" });

    const result = (await (await post(baseUrl, backup)).json()) as RestoreResult;

    expect(result.restored.items).toBe(0);
    expect((await library.getLibrary()).map((s) => s.seriesId).sort()).toEqual(["kept", "newer"]);
  });

  test("adds no registry and installs nothing a backup names", async () => {
    await seed(library);
    registry.state.registries.push({ url: REGISTRY, requireSignature: true });
    const other = "https://other.example/index.json";
    const backup = {
      ...(await exported()),
      sources: {
        registries: [{ url: REGISTRY }, { url: other, requireSignature: false }],
        bridges: [{ id: "extra", registryUrl: other }],
        trackers: [{ id: "anilist", registryUrl: other }],
      },
    };
    Reflect.set(library, "store", new InMemoryLibraryStore());

    const res = await post(baseUrl, backup);

    expect(res.status).toBe(200);
    expect(((await res.json()) as RestoreResult).restored.items).toBe(1);
    expect(registry.state).toEqual({ registries: [{ url: REGISTRY, requireSignature: true }], bridges: [], trackers: [] });
  });

  test("counts the records it had to leave out", async () => {
    const backup = await exported();
    const damaged = { ...backup, items: [{ id: "series:demo:x", type: "series", bridgeId: "demo", seriesId: "y" }], collections: [{ id: "c1" }] };

    const result = (await (await post(baseUrl, damaged)).json()) as RestoreResult;

    expect(result.skipped).toBe(2);
    expect(await library.getLibrary()).toEqual([]);
  });

  test("400s on a body that isn't a backup, and changes nothing", async () => {
    for (const body of [{ items: [] }, { format: "other", version: 1, exportedAt: 0 }, "nope"]) {
      const res = await post(baseUrl, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/isn't a Comical library backup/);
    }
    const unparseable = await fetch(`${baseUrl}/library/backup/restore`, { method: "POST", body: "{" });
    expect(unparseable.status).toBe(400);
    expect(registry.state.registries).toEqual([]);
  });

  test("400s on a backup from a newer build", async () => {
    const res = await post(baseUrl, { ...(await exported()), version: 99 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/newer version/);
  });
});

describe("without a library", () => {
  test("neither route exists", async () => {
    expect((await fetch(`${noLibraryUrl}/library/backup`)).status).toBe(404);
    expect((await post(noLibraryUrl, {})).status).toBe(404);
  });
});
