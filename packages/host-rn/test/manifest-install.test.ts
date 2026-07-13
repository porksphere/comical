/**
 * The on-device install model: `ManifestBundleSource` (installed() reads the pinned manifest, no
 * index fetch; resolveBundle re-downloads + verifies the pinned bundle) and `EmbeddedRegistryProvider`
 * (browse/install/update/uninstall/checkUpdates over injected stores + fetcher, incl. discontinuation).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { downloadBundle, fetchIndex } from "@comical/registry/fetcher";
import { sha256Hex } from "@comical/registry/verify";
import type { RegistryBridgeEntry, RegistryIndex, SavedRegistry } from "@comical/registry/schema";
import { EmbeddedRegistryProvider } from "../src/registry-provider.ts";
import { entryToInfo, ManifestBundleSource, type RegistryFetcher } from "../src/registry-bundle-source.ts";
import type { InstalledBridgeRecord, InstalledStore, SavedRegistryStore } from "../src/types.ts";

// ── In-memory stores (what the app implements over AsyncStorage) ────────────────

class MemInstalledStore implements InstalledStore {
  readonly map = new Map<string, InstalledBridgeRecord>();
  async all() {
    return [...this.map.values()];
  }
  async get(id: string) {
    return this.map.get(id) ?? null;
  }
  async add(record: InstalledBridgeRecord) {
    this.map.set(record.id, record); // upsert
  }
  async remove(id: string) {
    this.map.delete(id);
  }
}

class MemRegistryStore implements SavedRegistryStore {
  readonly map = new Map<string, SavedRegistry>();
  async all() {
    return [...this.map.values()];
  }
  async get(url: string) {
    return this.map.get(url) ?? null;
  }
  async add(registry: SavedRegistry) {
    this.map.set(registry.url, registry);
  }
  async remove(url: string) {
    this.map.delete(url);
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────────

const REG_A = "https://reg-a.example/index.json";
const BUNDLE_URL = "https://reg-a.example/bridges/demo.js";
const BUNDLE = 'module.exports = { default: () => ({ info: { id: "demo" } }) };';

function entry(over: Partial<RegistryBridgeEntry> = {}): RegistryBridgeEntry {
  return {
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    contractVersion: "1.0.0",
    languages: ["en"],
    nsfw: false,
    capabilities: ["search"],
    url: BUNDLE_URL,
    sha256: "a".repeat(64),
    ...over,
  };
}

function index(bridges: RegistryBridgeEntry[]): RegistryIndex {
  return { registryVersion: "1", updated: new Date().toISOString(), bridges };
}

function recordFor(over: Partial<InstalledBridgeRecord> = {}): InstalledBridgeRecord {
  const e = entry();
  return {
    id: e.id,
    registryUrl: REG_A,
    version: e.version,
    contractVersion: e.contractVersion,
    info: entryToInfo(e),
    url: e.url,
    sha256: e.sha256,
    ...over,
  };
}

/** A deterministic fetcher over a mutable index map (no real network) for provider logic tests. */
function fakeFetcher(indexes: Record<string, RegistryIndex>): RegistryFetcher {
  return {
    async fetchIndex(url) {
      const idx = indexes[url];
      if (!idx) throw new Error(`no index at ${url}`);
      return idx;
    },
    async downloadBundle() {
      return { text: BUNDLE };
    },
  };
}

// ── ManifestBundleSource ─────────────────────────────────────────────────────────

describe("ManifestBundleSource", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("installed() reads the manifest with no index fetch, passing annotations through", async () => {
    const store = new MemInstalledStore();
    await store.add(recordFor({ availableVersion: "1.1.0", discontinued: true }));
    let fetched = false;
    const src = new ManifestBundleSource({
      installed: store,
      fetcher: { downloadBundle: async () => ((fetched = true), { text: BUNDLE }) },
    });
    const installed = await src.installed();
    expect(fetched).toBe(false); // no network to list
    expect(installed).toHaveLength(1);
    expect(installed[0]?.info.id).toBe("demo");
    expect(installed[0]?.source).toBe("registry");
    expect(installed[0]?.availableVersion).toBe("1.1.0");
    expect(installed[0]?.discontinued).toBe(true);
  });

  test("resolveBundle downloads + verifies the pinned bundle, then serves from cache", async () => {
    const digest = await sha256Hex(new TextEncoder().encode(BUNDLE));
    const store = new MemInstalledStore();
    await store.add(recordFor({ sha256: digest }));

    let bundleFetches = 0;
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === BUNDLE_URL) {
        bundleFetches += 1;
        return new Response(new TextEncoder().encode(BUNDLE), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    // Real downloadBundle → exercises real SHA-256 verification under Bun's WebCrypto.
    const src = new ManifestBundleSource({ installed: store, fetcher: { downloadBundle } });
    expect(await src.resolveBundle("demo")).toBe(BUNDLE);
    expect(await src.resolveBundle("demo")).toBe(BUNDLE); // cached
    expect(bundleFetches).toBe(1);
  });

  test('unknown id → "not found"', async () => {
    const src = new ManifestBundleSource({
      installed: new MemInstalledStore(),
      fetcher: { downloadBundle: async () => ({ text: BUNDLE }) },
    });
    await expect(src.resolveBundle("nope")).rejects.toThrow(/not found/);
  });
});

// ── EmbeddedRegistryProvider ──────────────────────────────────────────────────────

describe("EmbeddedRegistryProvider", () => {
  function setup(indexes: Record<string, RegistryIndex>) {
    const registries = new MemRegistryStore();
    const installed = new MemInstalledStore();
    const provider = new EmbeddedRegistryProvider({ registries, installed, fetcher: fakeFetcher(indexes) });
    return { registries, installed, provider };
  }

  test("add() validates + saves a registry; list() returns it", async () => {
    const { provider, registries } = setup({ [REG_A]: index([entry()]) });
    const saved = await provider.add(REG_A);
    expect(saved.url).toBe(REG_A);
    expect(await registries.get(REG_A)).not.toBeNull();
    expect(await provider.list()).toHaveLength(1);
  });

  test("add() captures the index's operator displayName", async () => {
    const { provider } = setup({ [REG_A]: { ...index([entry()]), displayName: "Curated" } });
    const saved = await provider.add(REG_A);
    expect(saved.displayName).toBe("Curated");
  });

  test("browse() annotates installed + updateAvailable", async () => {
    const { provider, installed } = setup({ [REG_A]: index([entry({ version: "2.0.0" })]) });
    // Not installed yet.
    let rows = await provider.browse(REG_A);
    expect(rows[0]?.installedVersion).toBeNull();
    expect(rows[0]?.updateAvailable).toBe(false);
    // Installed at an older version → updateAvailable.
    await installed.add(recordFor({ version: "1.0.0" }));
    rows = await provider.browse(REG_A);
    expect(rows[0]?.installedVersion).toBe("1.0.0");
    expect(rows[0]?.updateAvailable).toBe(true);
  });

  test("install() pins a record and fires onChange", async () => {
    const { provider, installed } = setup({ [REG_A]: index([entry({ signature: "sig", version: "1.2.0" })]) });
    let changed = 0;
    provider.onChange = () => (changed += 1);

    const result = await provider.install(REG_A, "demo");
    expect(result.version).toBe("1.2.0");
    expect(changed).toBe(1);
    const rec = await installed.get("demo");
    expect(rec?.version).toBe("1.2.0");
    expect(rec?.url).toBe(BUNDLE_URL);
    expect(rec?.signature).toBe("sig");
  });

  test("install() of an unknown id throws", async () => {
    const { provider } = setup({ [REG_A]: index([entry()]) });
    await expect(provider.install(REG_A, "ghost")).rejects.toThrow(/not found/);
  });

  test("update() re-pins to the newer published version", async () => {
    const indexes = { [REG_A]: index([entry({ version: "1.0.0" })]) };
    const { provider, installed } = setup(indexes);
    await provider.install(REG_A, "demo");
    expect((await installed.get("demo"))?.version).toBe("1.0.0");

    indexes[REG_A] = index([entry({ version: "1.3.0" })]); // registry publishes a new version
    const result = await provider.update("demo");
    expect(result.version).toBe("1.3.0");
    expect((await installed.get("demo"))?.version).toBe("1.3.0");
  });

  test("uninstall() removes the record and fires onChange", async () => {
    const { provider, installed } = setup({ [REG_A]: index([entry()]) });
    await provider.install(REG_A, "demo");
    let changed = 0;
    provider.onChange = () => (changed += 1);
    await provider.uninstall("demo");
    expect(await installed.get("demo")).toBeNull();
    expect(changed).toBe(1);
  });

  test("checkUpdates() reports newer versions and persists the annotation", async () => {
    const indexes = { [REG_A]: index([entry({ version: "1.0.0" })]) };
    const { provider, installed } = setup(indexes);
    await provider.install(REG_A, "demo");

    indexes[REG_A] = index([entry({ version: "2.0.0" })]);
    // A fresh provider so the memoized index doesn't shadow the new version.
    const p2 = new EmbeddedRegistryProvider({
      registries: new MemRegistryStore(),
      installed,
      fetcher: fakeFetcher(indexes),
    });
    const updates = await p2.checkUpdates();
    expect(updates).toEqual([{ id: "demo", installedVersion: "1.0.0", availableVersion: "2.0.0" }]);
    expect((await installed.get("demo"))?.availableVersion).toBe("2.0.0");
  });

  test("checkUpdates() marks a bridge dropped from the index as discontinued (kept installed)", async () => {
    const indexes: Record<string, RegistryIndex> = { [REG_A]: index([entry()]) };
    const { provider, installed } = setup(indexes);
    await provider.install(REG_A, "demo");

    indexes[REG_A] = index([]); // bridge removed from the registry
    const p2 = new EmbeddedRegistryProvider({
      registries: new MemRegistryStore(),
      installed,
      fetcher: fakeFetcher(indexes),
    });
    const updates = await p2.checkUpdates();
    expect(updates).toEqual([]); // discontinued is not an "update"
    const rec = await installed.get("demo");
    expect(rec).not.toBeNull(); // still installed → keeps working from its pinned bundle
    expect(rec?.discontinued).toBe(true);
  });

  test("checkUpdates() fires onChange only when it persists an annotation change", async () => {
    const installed = new MemInstalledStore();
    await installed.add(recordFor({ version: "1.0.0" }));

    // A newer version is available → annotation persisted → onChange fires once (the background
    // list check relies on this to surface a fresh update badge without a re-navigation).
    const p1 = new EmbeddedRegistryProvider({
      registries: new MemRegistryStore(),
      installed,
      fetcher: fakeFetcher({ [REG_A]: index([entry({ version: "2.0.0" })]) }),
    });
    let changed1 = 0;
    p1.onChange = () => (changed1 += 1);
    await p1.checkUpdates();
    expect(changed1).toBe(1);
    expect((await installed.get("demo"))?.availableVersion).toBe("2.0.0");

    // A second check over the already-recorded state changes nothing → onChange must NOT fire (else
    // the background check would loop, refetching screens on every list()).
    const p2 = new EmbeddedRegistryProvider({
      registries: new MemRegistryStore(),
      installed,
      fetcher: fakeFetcher({ [REG_A]: index([entry({ version: "2.0.0" })]) }),
    });
    let changed2 = 0;
    p2.onChange = () => (changed2 += 1);
    await p2.checkUpdates();
    expect(changed2).toBe(0);
  });

  test("remove() keeps installed bridges (they stay pinned)", async () => {
    const { provider, installed } = setup({ [REG_A]: index([entry()]) });
    await provider.add(REG_A);
    await provider.install(REG_A, "demo");
    await provider.remove(REG_A);
    expect(await provider.list()).toHaveLength(0);
    expect(await installed.get("demo")).not.toBeNull();
  });

  test("tracker methods are inert on-device", async () => {
    const { provider } = setup({ [REG_A]: index([entry()]) });
    expect(await provider.browseTrackers(REG_A)).toEqual([]);
    expect(await provider.browseAllTrackers()).toEqual([]);
    expect(await provider.checkTrackerUpdates()).toEqual([]);
    await expect(provider.installTracker(REG_A, "t")).rejects.toThrow(/not supported/);
  });
});
