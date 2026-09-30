import { describe, expect, test } from "bun:test";
import {
  adoptRegistry,
  composeSyncStores,
  MemoryBackend,
  REGISTRY_TABLES,
  registrySyncStore,
  SyncEngine,
  wrapRegistryProvider,
  type SyncBackend,
  type SyncedRegistry,
} from "../src/index.ts";

let wall = 1_700_000_000_000;
const now = () => (wall += 10);
const quiet = { error: () => {} };

const REG = "https://example.test/index.json";
const OTHER = "https://other.test/index.json";

/** A provider over plain maps; an install is a record of where it came from, no network. */
function fakeProvider() {
  const registries = new Map<string, { url: string; requireSignature: boolean }>();
  const installed = new Map<string, { id: string; registryUrl: string | null; version: string }>();
  const trackers = new Map<string, { id: string; registryUrl: string | null }>();
  const calls: string[] = [];
  const failing = new Set<string>();
  const provider: Omit<SyncedRegistry, "installed"> & {
    installed(): Promise<{ id: string; registryUrl: string | null; version: string }[]>;
    update(id: string): Promise<void>;
    confirmMove(url: string): Promise<string>;
    calls: string[];
    failing: Set<string>;
    seed(id: string, registryUrl: string | null): void;
  } = {
    calls,
    failing,
    seed: (id, registryUrl) => void installed.set(id, { id, registryUrl, version: "1.0.0" }),
    registries: async () => [...registries.values()],
    installed: async () => [...installed.values()],
    installedTrackers: async () => [...trackers.values()],
    add: async (url, opts) => {
      calls.push(`add ${url}`);
      if (failing.has(url)) throw new Error(`unreachable: ${url}`);
      registries.set(url, { url, requireSignature: opts?.requireSignature ?? false });
    },
    remove: async (url) => {
      calls.push(`remove ${url}`);
      registries.delete(url);
    },
    install: async (url, id) => {
      calls.push(`install ${id}`);
      if (failing.has(id)) throw new Error(`download failed: ${id}`);
      installed.set(id, { id, registryUrl: url, version: "1.0.0" });
    },
    uninstall: async (id) => {
      calls.push(`uninstall ${id}`);
      installed.delete(id);
    },
    installTracker: async (url, id) => {
      calls.push(`installTracker ${id}`);
      trackers.set(id, { id, registryUrl: url });
    },
    uninstallTracker: async (id) => {
      calls.push(`uninstallTracker ${id}`);
      trackers.delete(id);
    },
    update: async (id) => {
      calls.push(`update ${id}`);
      installed.get(id)!.version = "1.1.0";
    },
    // The move rebinds the registry and everything installed from it.
    confirmMove: async (url) => {
      calls.push(`confirmMove ${url}`);
      const r = registries.get(url)!;
      registries.delete(url);
      registries.set(OTHER, { ...r, url: OTHER });
      for (const b of installed.values()) if (b.registryUrl === url) b.registryUrl = OTHER;
      return OTHER;
    },
  };
  return provider;
}

function device(backend: SyncBackend, name: string) {
  const real = fakeProvider();
  const store = registrySyncStore(real, { log: quiet, maxAttempts: 3 });
  const engine = new SyncEngine({
    store: composeSyncStores([[REGISTRY_TABLES, store]]),
    backend,
    device: name,
    newDeviceId: () => `${name}-2`,
    now,
  });
  const provider = wrapRegistryProvider(real, real, engine);
  return { real, store, engine, provider };
}

describe("registry sync", () => {
  test("a registry and a bridge installed on one device are installed on the other", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.provider.add(REG, { requireSignature: true });
    await a.provider.install(REG, "bridge-one");
    await a.provider.installTracker(REG, "tracker-one");
    await a.engine.sync();
    await b.engine.sync();

    expect(await b.real.registries()).toEqual([{ url: REG, requireSignature: true }]);
    expect(await b.real.installed()).toEqual([{ id: "bridge-one", registryUrl: REG, version: "1.0.0" }]);
    expect(await b.real.installedTrackers()).toEqual([{ id: "tracker-one", registryUrl: REG }]);
    // b performed its own install; nothing about a's copy travelled.
    expect(b.real.calls).toEqual([`add ${REG}`, "install bridge-one", "installTracker tracker-one"]);
  });

  test("an uninstall reaches the other device, and an update sends nothing", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.provider.add(REG);
    await a.provider.install(REG, "bridge-one");
    await a.engine.sync();
    await b.engine.sync();

    await a.provider.update("bridge-one");
    expect(a.engine.hasUnsent()).toBe(false);
    await a.provider.uninstall("bridge-one");
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.real.installed()).toEqual([]);
  });

  test("a locally built bridge has no registry, so it never travels", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    a.real.seed("local-bridge", null);
    await adoptRegistry(a.real, a.engine);
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.real.installed()).toEqual([]);
    expect(b.real.calls).toEqual([]);
  });

  test("what a device already holds is not reinstalled when the same intent arrives", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.provider.add(REG);
    await a.provider.install(REG, "bridge-one");
    await a.engine.sync();
    // b installed the same bridge before pairing.
    await b.provider.add(REG);
    await b.provider.install(REG, "bridge-one");
    b.real.calls.length = 0;
    await b.engine.sync();
    expect(b.real.calls).toEqual([]);
  });

  test("a failed install is retried later, and dropped after enough attempts", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.provider.add(REG);
    await a.provider.install(REG, "bridge-one");
    await a.provider.install(REG, "bridge-two");
    await a.engine.sync();

    b.real.failing.add("bridge-one");
    const stats = await b.engine.sync();
    // The round itself succeeded and the other bridge is in.
    expect(stats.applied).toBe(3);
    expect((await b.real.installed()).map((x) => x.id)).toEqual(["bridge-two"]);
    expect(b.store.pending()).toBe(1);

    b.real.failing.delete("bridge-one");
    await b.store.retry();
    expect(b.store.pending()).toBe(0);
    expect((await b.real.installed()).map((x) => x.id).sort()).toEqual(["bridge-one", "bridge-two"]);

    // Give up on one that keeps failing.
    await a.provider.install(REG, "bridge-three");
    await a.engine.sync();
    b.real.failing.add("bridge-three");
    await b.engine.sync();
    await b.store.retry();
    expect(b.store.pending()).toBe(1);
    await b.store.retry();
    expect(b.store.pending()).toBe(0);
  });

  test("a registry whose add failed is retried before the installs from it", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.provider.add(REG);
    await a.provider.install(REG, "bridge-one");
    await a.engine.sync();

    b.real.failing.add(REG);
    b.real.failing.add("bridge-one");
    await b.engine.sync();
    expect(b.store.pending()).toBe(2);
    b.real.failing.clear();
    b.real.calls.length = 0;
    await b.store.retry();
    expect(b.real.calls).toEqual([`add ${REG}`, "install bridge-one"]);
    expect(b.store.pending()).toBe(0);
  });

  test("a confirmed move rebinds the registry and its installs on every device", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.provider.add(REG);
    await a.provider.install(REG, "bridge-one");
    await a.engine.sync();
    await b.engine.sync();

    await a.provider.confirmMove(REG);
    await a.engine.sync();
    await b.engine.sync();
    expect((await b.real.registries()).map((r) => r.url)).toEqual([OTHER]);
    expect(await b.real.installed()).toEqual([{ id: "bridge-one", registryUrl: OTHER, version: "1.0.0" }]);
  });

  test("a fresh pairing adopts what the device holds after the first pull, so the hub's copy wins", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    await a.provider.add(REG, { requireSignature: true });
    await a.engine.sync();

    const b = device(hub, "b");
    await b.real.add(REG, { requireSignature: false });
    await b.real.install(REG, "bridge-one");
    await b.engine.sync();
    await adoptRegistry(b.real, b.engine);
    await b.engine.sync();
    await a.engine.sync();
    expect(await b.real.registries()).toEqual([{ url: REG, requireSignature: true }]);
    expect((await a.real.installed()).map((x) => x.id)).toEqual(["bridge-one"]);
  });

  test("a malformed record is dropped, not applied and not fatal", async () => {
    const hub = new MemoryBackend();
    const b = device(hub, "b");
    await hub.push({
      device: "x",
      seq: 1,
      records: [{ table: "installed", id: "bad", env: { kind: "set", hlc: "0000000000001-0000-x", present: true, meta: { nope: 1 } } }],
    });
    await b.engine.sync();
    expect(await b.real.installed()).toEqual([]);
    expect(b.store.pending()).toBe(0);
  });
});
