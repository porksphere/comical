/** withIdMigration / migrateInstalledBridges — the device-side driver of `Bridge.migrateIds`. */
import { describe, expect, test } from "bun:test";
import type { BridgeInfo, IdMigrationRequest, IdMigrationResult } from "@comical/contract";
import type { LoadedBridge } from "@comical/core/loader";
import { entryKey, InMemoryLibraryStore, Library, type IdRemap } from "@comical/library";
import { migrateInstalledBridges, withIdMigration, type IdMigrationDownloads } from "@comical/runtime";

const KEY = entryKey("demo", "old");

function info(version: string, migratesIds = true): BridgeInfo {
  return {
    id: "demo",
    name: "Demo",
    version,
    contractVersion: "2.1.0",
    languages: ["en"],
    nsfw: false,
    capabilities: [],
    ...(migratesIds ? { migratesIds } : {}),
  };
}

/** A bridge whose `migrateIds` prefixes every id with `n-` (unless `answer` says otherwise), recording each request. */
function bridge(version: string, answer?: (req: IdMigrationRequest) => Promise<IdMigrationResult>) {
  const calls: IdMigrationRequest[] = [];
  const migrateIds = async (req: IdMigrationRequest): Promise<IdMigrationResult> => {
    calls.push(req);
    if (answer) return answer(req);
    return {
      series: req.series.map((s) => ({ id: s.id, newId: `n-${s.id}`, chapters: s.chapterIds.map((c) => ({ id: c, newId: `n-${c}` })) })),
    };
  };
  const b = { info: info(version, true), migrateIds } as unknown as LoadedBridge;
  return { bridge: b, calls };
}

function provider(b: LoadedBridge) {
  const invalidated: string[] = [];
  return {
    invalidated,
    async get(_id: string) {
      return b;
    },
    async list() {
      return [{ info: b.info }];
    },
    invalidate(id: string) {
      invalidated.push(id);
    },
  };
}

async function libraryWith(...seriesIds: string[]) {
  const lib = new Library(new InMemoryLibraryStore());
  for (const id of seriesIds) {
    await lib.collectSeries({ bridgeId: "demo", seriesId: id }, { seriesTitle: id });
    await lib.markRead(entryKey("demo", id), "c1", true);
  }
  return lib;
}

const recordingLog = (warnings: string[]) => ({ debug() {}, info() {}, warn: (m: string) => void warnings.push(m), error() {} });

describe("withIdMigration", () => {
  test("moves the records on first get, then marks the version and asks no more", async () => {
    const lib = await libraryWith("old");
    const { bridge: b, calls } = bridge("2.0.0");
    const migrated: string[] = [];
    const p = withIdMigration(provider(b), { library: () => lib, onMigrated: (id) => migrated.push(id) });

    expect(await p.get("demo")).toBe(b);
    expect(calls).toEqual([{ fromVersion: null, series: [{ id: "old", chapterIds: ["c1"] }] }]);
    expect(await lib.getSeries(KEY)).toBeUndefined();
    expect((await lib.getProgress(entryKey("demo", "n-old"))).map((x) => x.chapterId)).toEqual(["n-c1"]);
    expect(await lib.idMigrationMark("demo")).toBe("2.0.0");
    expect(migrated).toEqual(["demo"]);

    await p.get("demo");
    expect(calls).toHaveLength(1);
  });

  test("a new version asks again, from the marked one", async () => {
    const lib = await libraryWith("old");
    await lib.setIdMigrationMark("demo", "1.0.0");
    const { bridge: b, calls } = bridge("2.0.0", async () => ({ series: [] }));
    await withIdMigration(provider(b), { library: () => lib }).get("demo");
    expect(calls[0]?.fromVersion).toBe("1.0.0");
    expect(await lib.idMigrationMark("demo")).toBe("2.0.0");
  });

  test("a bridge without migrateIds is just marked", async () => {
    const lib = await libraryWith("old");
    const b = { info: info("1.0.0", false) } as unknown as LoadedBridge;
    await withIdMigration(provider(b), { library: () => lib }).get("demo");
    expect(await lib.idMigrationMark("demo")).toBe("1.0.0");
    expect(await lib.getSeries(KEY)).toBeDefined();
  });

  test("with nothing to translate it marks without asking", async () => {
    const lib = new Library(new InMemoryLibraryStore());
    const { bridge: b, calls } = bridge("2.0.0");
    await withIdMigration(provider(b), { library: () => lib }).get("demo");
    expect(calls).toHaveLength(0);
    expect(await lib.idMigrationMark("demo")).toBe("2.0.0");
  });

  test("asks in batches", async () => {
    const lib = await libraryWith("a", "b", "c");
    const { bridge: b, calls } = bridge("2.0.0");
    await withIdMigration(provider(b), { library: () => lib, batchSize: 2 }).get("demo");
    expect(calls.map((c) => c.series.map((s) => s.id))).toEqual([["a", "b"], ["c"]]);
  });

  test("ignores answers about series it never asked about", async () => {
    const lib = await libraryWith("old");
    const { bridge: b } = bridge("2.0.0", async () => ({ series: [{ id: "nope", newId: "x" }, { id: "old", newId: "old" }] }));
    await withIdMigration(provider(b), { library: () => lib }).get("demo");
    expect(await lib.getSeries(entryKey("demo", "x"))).toBeUndefined();
    expect(await lib.getSeries(KEY)).toBeDefined();
  });

  test("a partial answer applies what it can, leaves the mark, and retries after an invalidate", async () => {
    const lib = await libraryWith("a", "b");
    let fail = true;
    const { bridge: b, calls } = bridge("2.0.0", async (req) => ({
      series: req.series.filter((s) => s.id !== "b" || !fail).map((s) => ({ id: s.id, newId: s.id.startsWith("n-") ? s.id : `n-${s.id}` })),
      ...(fail ? { failed: ["b"] } : {}),
    }));
    const prov = provider(b);
    const p = withIdMigration(prov, { library: () => lib });

    await p.get("demo");
    expect(await lib.getSeries(entryKey("demo", "n-a"))).toBeDefined();
    expect(await lib.getSeries(entryKey("demo", "b"))).toBeDefined();
    expect(await lib.idMigrationMark("demo")).toBeUndefined();

    // Settled for the process: no hammering a source that just failed.
    await p.get("demo");
    expect(calls).toHaveLength(1);

    fail = false;
    p.invalidate("demo");
    expect(prov.invalidated).toEqual(["demo"]);
    await p.get("demo");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.series.map((s) => s.id).sort()).toEqual(["b", "n-a"]);
    expect(await lib.getSeries(entryKey("demo", "n-b"))).toBeDefined();
    expect(await lib.idMigrationMark("demo")).toBe("2.0.0");
  });

  test("a bridge that throws still loads, unmarked", async () => {
    const lib = await libraryWith("old");
    const warnings: string[] = [];
    const { bridge: b } = bridge("2.0.0", async () => {
      throw new Error("offline");
    });
    expect(await withIdMigration(provider(b), { library: () => lib, log: recordingLog(warnings) }).get("demo")).toBe(b);
    expect(await lib.idMigrationMark("demo")).toBeUndefined();
    expect(warnings[0]).toContain("offline");
  });

  test("concurrent gets share one run", async () => {
    const lib = await libraryWith("old");
    const { bridge: b, calls } = bridge("2.0.0");
    const p = withIdMigration(provider(b), { library: () => lib });
    await Promise.all([p.get("demo"), p.get("demo"), p.get("demo")]);
    expect(calls).toHaveLength(1);
  });

  test("a restore makes it check again", async () => {
    const lib = await libraryWith("old");
    const { bridge: b, calls } = bridge("2.0.0", async () => ({ series: [] }));
    const p = withIdMigration(provider(b), { library: () => lib });
    await p.get("demo");
    await lib.restoreBackup(await lib.exportBackup());
    await p.get("demo");
    expect(calls).toHaveLength(2);
  });

  test("before the library exists, passes straight through", async () => {
    const { bridge: b, calls } = bridge("2.0.0");
    expect(await withIdMigration(provider(b), { library: () => undefined }).get("demo")).toBe(b);
    expect(calls).toHaveLength(0);
  });

  test("includes downloads in the question and moves them too", async () => {
    const lib = new Library(new InMemoryLibraryStore());
    const remaps: IdRemap[] = [];
    const downloads: IdMigrationDownloads = {
      idReferences: async () => new Map([["dl", new Set(["d1"])]]),
      remapIds: async (_id, remap) => {
        remaps.push(remap);
        return { deferred: true };
      },
    };
    const { bridge: b, calls } = bridge("2.0.0");
    await withIdMigration(provider(b), { library: () => lib, downloads: () => downloads }).get("demo");
    expect(calls[0]?.series).toEqual([{ id: "dl", chapterIds: ["d1"] }]);
    expect(remaps[0]?.series.get("dl")).toBe("n-dl");
    expect(remaps[0]?.chapters.get("dl")?.get("d1")).toBe("n-d1");
    // A chapter left mid-download means the job isn't done.
    expect(await lib.idMigrationMark("demo")).toBeUndefined();
  });
});

describe("migrateInstalledBridges", () => {
  test("loads only bridges that migrate, are referenced, and aren't marked for their version", async () => {
    const lib = await libraryWith("old");
    await lib.collectSeries({ bridgeId: "plain", seriesId: "x" }, { seriesTitle: "x" });
    const got: string[] = [];
    const list = [
      { info: info("2.0.0") },
      { info: { ...info("1.0.0"), id: "unreferenced" } },
      { info: { ...info("1.0.0", false), id: "plain" } },
    ];
    const prov = { list: async () => list, get: async (id: string) => void got.push(id) };

    await migrateInstalledBridges(prov, lib);
    expect(got).toEqual(["demo"]);

    await lib.setIdMigrationMark("demo", "2.0.0");
    got.length = 0;
    await migrateInstalledBridges(prov, lib);
    expect(got).toEqual([]);
  });

  test("with no migrating bridge installed, the library isn't scanned at all", async () => {
    const lib = await libraryWith("old");
    lib.referencedBridgeIds = async () => {
      throw new Error("scanned");
    };
    const prov = { list: async () => [{ info: info("1.0.0", false) }], get: async () => undefined };
    await migrateInstalledBridges(prov, lib);
  });

  test("a bridge that fails to load is logged and skipped", async () => {
    const lib = await libraryWith("old");
    const warnings: string[] = [];
    const prov = {
      list: async () => [{ info: info("2.0.0") }],
      get: async () => {
        throw new Error("bad bundle");
      },
    };
    await migrateInstalledBridges(prov, lib, recordingLog(warnings));
    expect(warnings[0]).toContain("bad bundle");
  });
});
