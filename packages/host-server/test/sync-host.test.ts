/**
 * A server as hub AND device: its own library syncs through the hub it serves, so a phone's push
 * lands in it and its own writes reach the phone.
 */
import { join } from "node:path";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, test } from "bun:test";
import type { SettingDescriptor, SettingValue } from "@comical/contract";
import { entryKey, InMemoryLibraryStore, Library, type LibraryStore } from "@comical/library";
import {
  bridgeSettingsSyncStore,
  composeSyncStores,
  LIBRARY_TABLES,
  librarySyncStore,
  REGISTRY_TABLES,
  registrySyncStore,
  SETTINGS_TABLES,
  SyncEngine,
  wrapBridgeSettings,
  wrapLibraryStore,
  wrapRegistryProvider,
  type BridgeSettingsProvider,
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

const BRIDGE_SETTINGS: SettingDescriptor[] = [
  { type: "boolean", key: "dataSaver", label: "Data saver" },
  { type: "string", key: "password", label: "Password", secret: true },
];

/** Bridges over maps: `declares` is what can be loaded, `stored` what each has saved. */
function fakeBridges(ids: string[] = ["bridge-a"]) {
  const declares = new Map(ids.map((id) => [id, BRIDGE_SETTINGS]));
  const stored = new Map<string, Record<string, SettingValue>>();
  const provider: BridgeSettingsProvider = {
    get: async (id) => {
      const descriptors = declares.get(id);
      if (!descriptors) throw new Error(`bridge not found: ${id}`);
      return { getSettings: () => descriptors };
    },
    storedSettings: async (id) => ({ ...stored.get(id) }),
    updateSettings: async (id, values) => {
      const next = { ...stored.get(id), ...values };
      stored.set(id, next);
      return { ...next };
    },
  };
  return { ...provider, declares, stored };
}

function hostOptions(store: LibraryStore = new InMemoryLibraryStore()): SyncHostOptions<SyncedRegistry, ReturnType<typeof fakeBridges>> {
  const registry = fakeRegistry();
  return { dir: DIR, store, registry, bridges: fakeBridges(), lists: registry, log: quiet };
}

function phone(backend: ReturnType<typeof createSyncHost>["backend"]) {
  const inner = new InMemoryLibraryStore();
  const registry = fakeRegistry();
  const bridges = fakeBridges();
  const engine = new SyncEngine({
    store: composeSyncStores([
      [LIBRARY_TABLES, librarySyncStore(inner)],
      [REGISTRY_TABLES, registrySyncStore(registry, { log: quiet })],
      [SETTINGS_TABLES, bridgeSettingsSyncStore(bridges, { log: quiet })],
    ]),
    backend,
    device: "phone",
    name: () => "A phone",
    newDeviceId: () => "phone-2",
  });
  return {
    inner,
    engine,
    library: new Library(wrapLibraryStore(inner, engine)),
    registry: wrapRegistryProvider(registry, registry, engine),
    held: registry,
    bridges: wrapBridgeSettings(bridges, engine),
    settings: bridges.stored,
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

  test("a hub from before a table synced adopts what that table already holds, once", async () => {
    const inner = new InMemoryLibraryStore();
    const opts = hostOptions(inner);
    const first = createSyncHost(opts);
    await new Library(first.store).collectSeries({ bridgeId: "b", seriesId: "s" }, { seriesTitle: "S" });
    await first.flush();
    first.stop();

    // As an older build left things: a feed sync never recorded, and a state that lists no tables.
    await inner.putActivity({ bridgeId: "b", seriesId: "s", chapterId: "c1", title: "S", detectedAt: 5 });
    await inner.putCollections([{ id: "unrecorded", name: "Not sync's to send", order: 0 }]);
    const statePath = join(DIR, "state.json");
    const { adopted: _, ...old } = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    await writeFile(statePath, JSON.stringify(old));

    const second = createSyncHost(opts);
    await second.ready;
    expect(second.engine.unadopted()).toEqual([]);
    const p = phone(second.backend);
    await p.engine.sync();
    expect((await p.inner.listActivity()).map((a) => a.chapterId)).toEqual(["c1"]);
    // Only the new table: a record of an old one that sync never saw is not swept up with it.
    expect(await p.library.getCollections()).toEqual([]);
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

  test("a bridge preference set on the phone is stored on the server and back, and a login stays where it was typed", async () => {
    const opts = hostOptions();
    const host = createSyncHost(opts);
    await host.ready;
    const p = phone(host.backend);

    await p.bridges.updateSettings("bridge-a", { dataSaver: true, password: "phone's" });
    await p.engine.sync();
    await host.flush();
    expect(opts.bridges.stored.get("bridge-a")).toEqual({ dataSaver: true });

    await host.bridges.updateSettings("bridge-a", { dataSaver: false, password: "server's", excludedTags: ["gore"] });
    await host.flush();
    await p.engine.sync();
    expect(p.settings.get("bridge-a")).toEqual({ dataSaver: false, password: "phone's", excludedTags: ["gore"] });
    // Neither password is anywhere in what the hub keeps.
    const segments = join(DIR, "segments");
    const kept = (await Promise.all((await readdir(segments)).map((f) => readFile(join(segments, f), "utf8")))).join();
    expect(kept).toContain("dataSaver");
    expect(kept).not.toContain("password");
    expect(kept).not.toContain("server's");
    expect(kept).not.toContain("phone's");
  });

  test("a fresh hub starts from the preferences of the bridges the server has installed", async () => {
    const opts = hostOptions();
    await opts.registry.install(REG, "bridge-a");
    opts.bridges.stored.set("bridge-a", { dataSaver: true, password: "server's" });
    opts.bridges.stored.set("bridge-gone", { dataSaver: true });
    const host = createSyncHost(opts);
    await host.ready;
    const p = phone(host.backend);
    await p.engine.sync();
    expect(p.settings.get("bridge-a")).toEqual({ dataSaver: true });
    expect(p.settings.has("bridge-gone")).toBe(false);
  });

  test("a preference for a bridge the server can't load yet is stored once it can, and counts as applied", async () => {
    const opts = hostOptions();
    opts.bridges.declares.clear();
    let applied = 0;
    const host = createSyncHost({ ...opts, onApplied: () => applied++ });
    await host.ready;
    const p = phone(host.backend);
    await p.bridges.updateSettings("bridge-a", { dataSaver: true });
    await p.engine.sync();
    await host.flush();
    expect(opts.bridges.stored.has("bridge-a")).toBe(false);
    const before = applied;

    opts.bridges.declares.set("bridge-a", BRIDGE_SETTINGS);
    await host.flush();
    expect(opts.bridges.stored.get("bridge-a")).toEqual({ dataSaver: true });
    expect(applied).toBe(before + 1);
    // Stored from the phone's record, so there is nothing of the server's to send back.
    expect(host.engine.hasUnsent()).toBe(false);
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

  test("stop drops the pending round and a later push schedules none, but the change survives for the next run", async () => {
    let applied = 0;
    const host = createSyncHost({ ...hostOptions(), onApplied: () => applied++, debounceMs: 10 });
    await host.ready;
    const p = phone(host.backend);

    await p.library.createCollection("From phone");
    await p.engine.sync(); // the push schedules the host's round
    host.stop();
    await p.library.createCollection("After stop");
    await p.engine.sync();
    await new Promise((r) => setTimeout(r, 50));
    expect(applied).toBe(0);

    const again = createSyncHost({ ...hostOptions(), onApplied: () => applied++ });
    await again.ready;
    expect((await new Library(again.store).getCollections()).map((c) => c.name).sort()).toEqual([
      "After stop",
      "From phone",
    ]);
    expect(applied).toBe(1);
  });
});
