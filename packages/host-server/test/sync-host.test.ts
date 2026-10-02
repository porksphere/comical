/**
 * A server as hub AND device: its own library syncs through the hub it serves, so a phone's push
 * lands in it and its own writes reach the phone.
 */
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, test } from "bun:test";
import { entryKey, InMemoryLibraryStore, Library, type LibraryStore } from "@comical/library";
import {
  composeSyncStores,
  LIBRARY_TABLES,
  librarySyncStore,
  REGISTRY_TABLES,
  registrySyncStore,
  SyncEngine,
  wrapLibraryStore,
  wrapRegistryProvider,
  type SyncedRegistry,
} from "@comical/sync";
import { createSyncHost, type SyncHostOptions } from "../src/sync-host.ts";

const DIR = join(import.meta.dir, ".tmp-sync-host");
const quiet = { error: () => {} };
const REG = "https://example.test/index.json";

afterEach(() => rm(DIR, { recursive: true, force: true }));

/** A registry over maps: an install records where it came from and nothing is fetched. */
function fakeRegistry() {
  const registries = new Map<string, { url: string; requireSignature: boolean }>();
  const installed = new Map<string, { id: string; registryUrl: string | null }>();
  const trackers = new Map<string, { id: string; registryUrl: string | null }>();
  const reg: SyncedRegistry = {
    registries: async () => [...registries.values()],
    installed: async () => [...installed.values()],
    installedTrackers: async () => [...trackers.values()],
    add: async (url, o) => void registries.set(url, { url, requireSignature: o?.requireSignature ?? false }),
    remove: async (url) => void registries.delete(url),
    install: async (url, id) => void installed.set(id, { id, registryUrl: url }),
    uninstall: async (id) => void installed.delete(id),
    installTracker: async (url, id) => void trackers.set(id, { id, registryUrl: url }),
    uninstallTracker: async (id) => void trackers.delete(id),
  };
  return reg;
}

function hostOptions(store: LibraryStore = new InMemoryLibraryStore()): SyncHostOptions<SyncedRegistry> {
  const registry = fakeRegistry();
  return { dir: DIR, store, registry, lists: registry, log: quiet };
}

function phone(backend: ReturnType<typeof createSyncHost>["backend"]) {
  const inner = new InMemoryLibraryStore();
  const registry = fakeRegistry();
  const engine = new SyncEngine({
    store: composeSyncStores([
      [LIBRARY_TABLES, librarySyncStore(inner)],
      [REGISTRY_TABLES, registrySyncStore(registry, { log: quiet })],
    ]),
    backend,
    device: "phone",
    newDeviceId: () => "phone-2",
  });
  return {
    inner,
    engine,
    library: new Library(wrapLibraryStore(inner, engine)),
    registry: wrapRegistryProvider(registry, registry, engine),
    held: registry,
  };
}

describe("createSyncHost", () => {
  test("a phone's push lands in the server's library, and the server's writes reach the phone", async () => {
    const host = createSyncHost(hostOptions());
    const serverLib = new Library(host.store);
    await host.ready;
    const p = phone(host.backend);

    const c = await p.library.createCollection("From phone");
    await p.engine.sync();
    await host.flush();
    expect((await serverLib.getCollections()).map((x) => x.name)).toEqual(["From phone"]);

    await serverLib.collectSeries({ bridgeId: "b", seriesId: "s" }, { seriesTitle: "S", collectionIds: [c.id] });
    await host.flush();
    await p.engine.sync();
    expect(await p.library.isCollected(entryKey("b", "s"))).toBe(true);
  });

  test("a fresh hub starts from the library the server already has", async () => {
    const existing = new InMemoryLibraryStore();
    await existing.putCollections([{ id: "c", name: "Already here", order: 0 }]);
    const host = createSyncHost(hostOptions(existing));
    await host.ready;
    const p = phone(host.backend);
    await p.engine.sync();
    expect((await p.library.getCollections()).map((x) => x.name)).toEqual(["Already here"]);
  });

  test("a restart carries on as the same device from its saved state", async () => {
    const opts = hostOptions();
    const first = createSyncHost(opts);
    await new Library(first.store).createCollection("One");
    await first.flush();

    const second = createSyncHost(opts);
    await second.ready;
    expect(second.engine.deviceId).toBe(first.engine.deviceId);
    await new Library(second.store).createCollection("Two");
    await second.flush();

    const p = phone(second.backend);
    await p.engine.sync();
    expect((await p.library.getCollections()).map((x) => x.name).sort()).toEqual(["One", "Two"]);
  });

  test("a bridge installed on the phone is installed on the server, and the server's installs reach the phone", async () => {
    const opts = hostOptions();
    const host = createSyncHost(opts);
    await host.ready;
    const p = phone(host.backend);

    await p.registry.add(REG, { requireSignature: true });
    await p.registry.install(REG, "bridge-one");
    await p.engine.sync();
    await host.flush();
    expect(await opts.lists.registries()).toEqual([{ url: REG, requireSignature: true }]);
    expect(await opts.lists.installed()).toEqual([{ id: "bridge-one", registryUrl: REG }]);

    await host.registry.installTracker(REG, "tracker-one");
    await host.registry.uninstall("bridge-one");
    await host.flush();
    await p.engine.sync();
    expect(await p.held.installedTrackers()).toEqual([{ id: "tracker-one", registryUrl: REG }]);
    expect(await p.held.installed()).toEqual([]);
  });

  test("a fresh hub starts from the registries the server already has, but not its locally built bridges", async () => {
    const opts = hostOptions();
    await opts.registry.add(REG);
    await opts.registry.install(REG, "bridge-one");
    await opts.registry.install("", "local-bridge");
    const host = createSyncHost(opts);
    await host.ready;
    const p = phone(host.backend);
    await p.engine.sync();
    expect((await p.held.registries()).map((r) => r.url)).toEqual([REG]);
    expect((await p.held.installed()).map((b) => b.id)).toEqual(["bridge-one"]);
  });

  test("an install the server can't perform yet is retried on a later round", async () => {
    const opts = hostOptions();
    let down = true;
    const install = opts.registry.install;
    opts.registry.install = async (url, id) => {
      if (down) throw new Error("registry unreachable");
      await install(url, id);
    };
    const host = createSyncHost(opts);
    await host.ready;
    const p = phone(host.backend);
    await p.registry.add(REG);
    await p.registry.install(REG, "bridge-one");
    await p.engine.sync();
    await host.flush();
    expect(await opts.lists.installed()).toEqual([]);

    down = false;
    await host.flush();
    expect(await opts.lists.installed()).toEqual([{ id: "bridge-one", registryUrl: REG }]);
  });

  test("onApplied fires when another device's records change this server, not for its own writes", async () => {
    let applied = 0;
    const host = createSyncHost({ ...hostOptions(), onApplied: () => applied++ });
    const serverLib = new Library(host.store);
    await host.ready;

    await serverLib.createCollection("Mine");
    await host.flush();
    expect(applied).toBe(0);

    const p = phone(host.backend);
    await p.engine.sync();
    await host.flush();
    expect(applied).toBe(0);

    await p.library.createCollection("From phone");
    await p.engine.sync();
    await host.flush();
    expect(applied).toBe(1);
  });
});
