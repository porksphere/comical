/**
 * The app hears that a bridge moved its records onto new ids through `configureEmbeddedRuntime`'s
 * `onIdsMigrated`, so the hook has to survive the trip to the runtime — dropped on the way, the
 * migration still runs but every screen keeps showing the old ids until something else refetches.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createRouter } from "@comical/host-server/router";
import { entryKey, InMemoryLibraryStore, Library } from "@comical/library";
import { applyEmbeddedMode, configureEmbeddedRuntime } from "../src/bootstrap.ts";
import { uninstallEmbeddedTransport } from "../src/install.ts";
import { setNativeBridgeRuntime } from "../src/native-runtime.ts";
import type { CreateRouter, InstalledBridgeRecord, NativeBridgeRuntime } from "../src/types.ts";

const info = {
  id: "demo",
  name: "Demo",
  version: "2.0.0",
  contractVersion: "2.1.0",
  languages: ["en"],
  nsfw: false,
  capabilities: [],
  migratesIds: true,
};

const record: InstalledBridgeRecord = {
  id: "demo",
  registryUrl: "https://reg.example/index.json",
  version: "2.0.0",
  contractVersion: "2.1.0",
  info,
  url: "https://reg.example/bridges/demo.js",
  sha256: "a".repeat(64),
};

const migratingNative: NativeBridgeRuntime = {
  initBridge: async () => JSON.stringify({ info }),
  callBridge: async (_id, method) =>
    method === "migrateIds" ? JSON.stringify({ series: [{ id: "old", newId: "new" }] }) : "null",
  disposeBridge: () => {},
};

const emptyStore = { all: async () => [], get: async () => null, add: async () => {}, remove: async () => {} };

afterEach(() => {
  uninstallEmbeddedTransport();
  setNativeBridgeRuntime(null);
});

async function start(onIdsMigrated?: (bridgeId: string) => void) {
  setNativeBridgeRuntime(migratingNative);
  const libraryStore = new InMemoryLibraryStore();
  await new Library(libraryStore).collectSeries({ bridgeId: "demo", seriesId: "old" }, { seriesTitle: "Old" });
  configureEmbeddedRuntime({
    createRouter: createRouter as unknown as CreateRouter,
    installed: { ...emptyStore, all: async () => [record], get: async (id) => (id === "demo" ? record : null) },
    installedTrackers: emptyStore,
    registries: emptyStore,
    settings: { get: async () => ({}), set: async () => {} },
    fetcher: {
      fetchIndex: async () => {
        throw new Error("offline");
      },
      downloadBundle: async () => ({ text: "module.exports = {};" }),
    },
    libraryStore,
    setTransport: () => {},
    ...(onIdsMigrated ? { onIdsMigrated } : {}),
  });
  expect(applyEmbeddedMode(true)).toBe(true);
  return libraryStore;
}

/** Waits for the startup migration to finish, which nothing awaits. */
async function migrated(store: InMemoryLibraryStore) {
  for (let i = 0; i < 100 && (await store.getIdMigrationMark("demo")) === undefined; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(await store.getIdMigrationMark("demo")).toBe("2.0.0");
}

describe("configureEmbeddedRuntime — onIdsMigrated", () => {
  test("fires once the startup migration has moved the records", async () => {
    const heard: string[] = [];
    const store = await start((id) => heard.push(id));
    await migrated(store);
    expect(heard).toEqual(["demo"]);
    expect(await new Library(store).getSeries(entryKey("demo", "new"))).toBeDefined();
  });

  test("without one, the migration still runs", async () => {
    const store = await start();
    await migrated(store);
    expect(await new Library(store).getSeries(entryKey("demo", "old"))).toBeUndefined();
  });
});
