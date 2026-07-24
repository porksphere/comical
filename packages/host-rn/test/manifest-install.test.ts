/**
 * The on-device install model: `ManifestBundleSource`/`ManifestTrackerBundleSource` (installed()
 * reads the pinned manifest, no index fetch; resolveBundle re-downloads + verifies the pinned
 * bundle) and `EmbeddedRegistryProvider` (browse/install/update/uninstall/checkUpdates over injected
 * stores + fetcher, incl. discontinuation — bridges and trackers mirror each other 1:1).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { downloadBundle, fetchIndex } from "@comical/registry/fetcher";
import { sha256Hex } from "@comical/registry/verify";
import type { RegistryBridgeEntry, RegistryIndex, RegistryTrackerEntry, SavedRegistry } from "@comical/registry/schema";
import { EmbeddedRegistryProvider } from "../src/registry-provider.ts";
import {
  entryToInfo,
  entryToTrackerInfo,
  ManifestBundleSource,
  ManifestTrackerBundleSource,
  type RegistryFetcher,
} from "../src/registry-bundle-source.ts";
import type {
  InstalledBridgeRecord,
  InstalledStore,
  InstalledTrackerRecord,
  InstalledTrackerStore,
  SavedRegistryStore,
} from "../src/types.ts";

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

class MemInstalledTrackerStore implements InstalledTrackerStore {
  readonly map = new Map<string, InstalledTrackerRecord>();
  async all() {
    return [...this.map.values()];
  }
  async get(id: string) {
    return this.map.get(id) ?? null;
  }
  async add(record: InstalledTrackerRecord) {
    this.map.set(record.id, record); // upsert
  }
  async remove(id: string) {
    this.map.delete(id);
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

// ── Tracker fixtures (mirror the bridge ones above 1:1) ──────────────────────────

const TRACKER_BUNDLE_URL = "https://reg-a.example/trackers/anilist.js";

function trackerEntry(over: Partial<RegistryTrackerEntry> = {}): RegistryTrackerEntry {
  return {
    id: "anilist",
    name: "AniList",
    version: "1.0.0",
    contractVersion: "1.0.0",
    capabilities: ["library-sync"],
    url: TRACKER_BUNDLE_URL,
    sha256: "a".repeat(64),
    ...over,
  };
}

function trackerIndex(trackers: RegistryTrackerEntry[], bridges: RegistryBridgeEntry[] = []): RegistryIndex {
  return { registryVersion: "1", updated: new Date().toISOString(), bridges, trackers };
}

function trackerRecordFor(over: Partial<InstalledTrackerRecord> = {}): InstalledTrackerRecord {
  const e = trackerEntry();
  return {
    id: e.id,
    registryUrl: REG_A,
    version: e.version,
    contractVersion: e.contractVersion,
    info: entryToTrackerInfo(e),
    url: e.url,
    sha256: e.sha256,
    ...over,
  };
}

/** Like `fakeFetcher`, but downloads resolve to a tracker bundle body. */
function fakeTrackerFetcher(indexes: Record<string, RegistryIndex>): RegistryFetcher {
  return {
    async fetchIndex(url) {
      const idx = indexes[url];
      if (!idx) throw new Error(`no index at ${url}`);
      return idx;
    },
    async downloadBundle() {
      return { text: TRACKER_BUNDLE };
    },
  };
}

const TRACKER_BUNDLE = 'module.exports = { default: () => ({ info: { id: "anilist" } }) };';

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

// ── ManifestTrackerBundleSource ───────────────────────────────────────────────────

describe("ManifestTrackerBundleSource", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("installed() reads the manifest (info + annotations) with no index fetch", async () => {
    const store = new MemInstalledTrackerStore();
    await store.add(trackerRecordFor({ availableVersion: "1.1.0", discontinued: true }));
    let fetched = false;
    const src = new ManifestTrackerBundleSource({
      installed: store,
      fetcher: { downloadBundle: async () => ((fetched = true), { text: TRACKER_BUNDLE }) },
    });
    const listed = await src.installed();
    expect(listed.map((t) => t.info.id)).toEqual(["anilist"]);
    expect(listed[0]?.availableVersion).toBe("1.1.0");
    expect(listed[0]?.discontinued).toBe(true);
    expect(fetched).toBe(false); // no network to list — the pinned info snapshot is enough
  });

  test("resolveBundle downloads + verifies the pinned bundle, then serves from cache", async () => {
    const digest = await sha256Hex(new TextEncoder().encode(TRACKER_BUNDLE));
    const store = new MemInstalledTrackerStore();
    await store.add(trackerRecordFor({ sha256: digest }));

    let bundleFetches = 0;
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === TRACKER_BUNDLE_URL) {
        bundleFetches += 1;
        return new Response(new TextEncoder().encode(TRACKER_BUNDLE), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const src = new ManifestTrackerBundleSource({ installed: store, fetcher: { downloadBundle } });
    expect(await src.resolveBundle("anilist")).toBe(TRACKER_BUNDLE);
    expect(await src.resolveBundle("anilist")).toBe(TRACKER_BUNDLE); // cached
    expect(bundleFetches).toBe(1);
  });

  test('unknown id → "not found"', async () => {
    const src = new ManifestTrackerBundleSource({
      installed: new MemInstalledTrackerStore(),
      fetcher: { downloadBundle: async () => ({ text: TRACKER_BUNDLE }) },
    });
    await expect(src.resolveBundle("nope")).rejects.toThrow(/not found/);
  });
});

// ── EmbeddedRegistryProvider ──────────────────────────────────────────────────────

describe("EmbeddedRegistryProvider", () => {
  function setup(indexes: Record<string, RegistryIndex>) {
    const registries = new MemRegistryStore();
    const installed = new MemInstalledStore();
    const installedTrackers = new MemInstalledTrackerStore();
    const provider = new EmbeddedRegistryProvider({
      registries,
      installed,
      installedTrackers,
      fetcher: fakeFetcher(indexes),
    });
    return { registries, installed, installedTrackers, provider };
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

  test("reconciles a changed displayName onto the saved registry on fetch", async () => {
    const registries = new MemRegistryStore();
    await registries.add({ url: REG_A, name: "reg-a", requireSignature: false, displayName: "Stale" });
    const provider = new EmbeddedRegistryProvider({
      registries,
      installed: new MemInstalledStore(),
      installedTrackers: new MemInstalledTrackerStore(),
      fetcher: fakeFetcher({ [REG_A]: { ...index([entry()]), displayName: "Fresh" } }),
    });
    await provider.browse(REG_A); // fetch → reconcile side-effect
    expect((await registries.get(REG_A))?.displayName).toBe("Fresh");
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
      installedTrackers: new MemInstalledTrackerStore(),
      fetcher: fakeFetcher(indexes),
    });
    const updates = await p2.checkUpdates();
    expect(updates).toEqual([{ id: "demo", installedVersion: "1.0.0", availableVersion: "2.0.0" }]);
    expect((await installed.get("demo"))?.availableVersion).toBe("2.0.0");
  });

  test("checkUpdates() silently re-pins a same-version hash drift instead of leaving it wedged", async () => {
    // Mirrors the real incident: a registry republishes different bytes at the SAME version (an
    // operator mistake — see assertVersionImmutable in @comical/registry). A device that already
    // pinned the earlier sha256 would otherwise fail SHA-256 verification forever, since there's no
    // version bump for the normal update flow to ever detect.
    const indexes = { [REG_A]: index([entry({ version: "1.0.0", sha256: "a".repeat(64) })]) };
    const { provider, installed } = setup(indexes);
    await provider.install(REG_A, "demo");
    expect((await installed.get("demo"))?.sha256).toBe("a".repeat(64));

    // The registry silently republishes different bytes at the identical version.
    indexes[REG_A] = index([
      entry({ version: "1.0.0", sha256: "b".repeat(64), url: "https://reg-a.example/bridges/demo-v2.js" }),
    ]);
    const p2 = new EmbeddedRegistryProvider({
      registries: new MemRegistryStore(),
      installed,
      installedTrackers: new MemInstalledTrackerStore(),
      fetcher: fakeFetcher(indexes),
    });
    let changed = 0;
    p2.onChange = () => (changed += 1);
    const updates = await p2.checkUpdates();

    expect(updates).toEqual([]); // not a version bump, so not reported as a user-facing "update"
    expect(changed).toBe(1); // but the drop-cache/refetch side effect still fires, so it self-heals
    const rec = await installed.get("demo");
    expect(rec?.sha256).toBe("b".repeat(64));
    expect(rec?.url).toBe("https://reg-a.example/bridges/demo-v2.js");
    expect(rec?.version).toBe("1.0.0");
    expect(rec?.availableVersion).toBeUndefined();
    expect(rec?.discontinued).toBeUndefined();
  });

  test("checkUpdates() marks a bridge dropped from the index as discontinued (kept installed)", async () => {
    const indexes: Record<string, RegistryIndex> = { [REG_A]: index([entry()]) };
    const { provider, installed } = setup(indexes);
    await provider.install(REG_A, "demo");

    indexes[REG_A] = index([]); // bridge removed from the registry
    const p2 = new EmbeddedRegistryProvider({
      registries: new MemRegistryStore(),
      installed,
      installedTrackers: new MemInstalledTrackerStore(),
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
      installedTrackers: new MemInstalledTrackerStore(),
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
      installedTrackers: new MemInstalledTrackerStore(),
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

  // ── Trackers (mirror the bridge tests above 1:1) ─────────────────────────────────

  test("browseTrackers() annotates installed + updateAvailable", async () => {
    const { provider, installedTrackers } = setup({
      [REG_A]: trackerIndex([trackerEntry({ version: "2.0.0" })]),
    });
    let rows = await provider.browseTrackers(REG_A);
    expect(rows[0]?.installedVersion).toBeNull();
    expect(rows[0]?.updateAvailable).toBe(false);

    await installedTrackers.add(trackerRecordFor({ version: "1.0.0" }));
    rows = await provider.browseTrackers(REG_A);
    expect(rows[0]?.installedVersion).toBe("1.0.0");
    expect(rows[0]?.updateAvailable).toBe(true);
  });

  test("browseAllTrackers() merges across saved registries, tolerating a failing one", async () => {
    const REG_B = "https://reg-b.example/index.json";
    const registries = new MemRegistryStore();
    await registries.add({ url: REG_A, name: "reg-a", requireSignature: false });
    await registries.add({ url: REG_B, name: "reg-b", requireSignature: false });
    const provider = new EmbeddedRegistryProvider({
      registries,
      installed: new MemInstalledStore(),
      installedTrackers: new MemInstalledTrackerStore(),
      fetcher: fakeTrackerFetcher({ [REG_A]: trackerIndex([trackerEntry()]) }), // REG_B has no index → throws
    });
    const rows = await provider.browseAllTrackers();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entry.id).toBe("anilist");
  });

  test("installTracker() pins a record and fires onChange", async () => {
    const { provider, installedTrackers } = setup({
      [REG_A]: trackerIndex([trackerEntry({ signature: "sig", version: "1.2.0" })]),
    });
    let changed = 0;
    provider.onChange = () => (changed += 1);

    const result = await provider.installTracker(REG_A, "anilist");
    expect(result.version).toBe("1.2.0");
    expect(changed).toBe(1);
    const rec = await installedTrackers.get("anilist");
    expect(rec?.version).toBe("1.2.0");
    expect(rec?.url).toBe(TRACKER_BUNDLE_URL);
    expect(rec?.signature).toBe("sig");
    // The pinned info snapshot is captured so list() can surface the tracker without a bundle load.
    expect(rec?.info.id).toBe("anilist");
    expect(rec?.info.version).toBe("1.2.0");
  });

  test("installTracker() of an unknown id throws", async () => {
    const { provider } = setup({ [REG_A]: trackerIndex([trackerEntry()]) });
    await expect(provider.installTracker(REG_A, "ghost")).rejects.toThrow(/not found/);
  });

  test("updateTracker() re-pins to the newer published version", async () => {
    const indexes = { [REG_A]: trackerIndex([trackerEntry({ version: "1.0.0" })]) };
    const { provider, installedTrackers } = setup(indexes);
    await provider.installTracker(REG_A, "anilist");
    expect((await installedTrackers.get("anilist"))?.version).toBe("1.0.0");

    indexes[REG_A] = trackerIndex([trackerEntry({ version: "1.3.0" })]); // registry publishes a new version
    const result = await provider.updateTracker("anilist");
    expect(result.version).toBe("1.3.0");
    expect((await installedTrackers.get("anilist"))?.version).toBe("1.3.0");
  });

  test("uninstallTracker() removes the record and fires onChange", async () => {
    const { provider, installedTrackers } = setup({ [REG_A]: trackerIndex([trackerEntry()]) });
    await provider.installTracker(REG_A, "anilist");
    let changed = 0;
    provider.onChange = () => (changed += 1);
    await provider.uninstallTracker("anilist");
    expect(await installedTrackers.get("anilist")).toBeNull();
    expect(changed).toBe(1);
  });

  test("checkTrackerUpdates() reports newer versions and persists the annotation", async () => {
    const indexes = { [REG_A]: trackerIndex([trackerEntry({ version: "1.0.0" })]) };
    const { provider, installedTrackers } = setup(indexes);
    await provider.installTracker(REG_A, "anilist");

    indexes[REG_A] = trackerIndex([trackerEntry({ version: "2.0.0" })]);
    // A fresh provider so the memoized index doesn't shadow the new version.
    const p2 = new EmbeddedRegistryProvider({
      registries: new MemRegistryStore(),
      installed: new MemInstalledStore(),
      installedTrackers,
      fetcher: fakeFetcher(indexes),
    });
    const updates = await p2.checkTrackerUpdates();
    expect(updates).toEqual([{ id: "anilist", installedVersion: "1.0.0", availableVersion: "2.0.0" }]);
    expect((await installedTrackers.get("anilist"))?.availableVersion).toBe("2.0.0");
  });

  test("checkTrackerUpdates() silently re-pins a same-version hash drift instead of leaving it wedged", async () => {
    // Mirrors checkUpdates()'s real incident (see its test above) — a registry republishes different
    // bytes at the SAME version, and a device already pinned to the earlier sha256 self-heals instead
    // of failing SHA-256 verification forever.
    const indexes = { [REG_A]: trackerIndex([trackerEntry({ version: "1.0.0", sha256: "a".repeat(64) })]) };
    const { provider, installedTrackers } = setup(indexes);
    await provider.installTracker(REG_A, "anilist");
    expect((await installedTrackers.get("anilist"))?.sha256).toBe("a".repeat(64));

    indexes[REG_A] = trackerIndex([
      trackerEntry({ version: "1.0.0", sha256: "b".repeat(64), url: "https://reg-a.example/trackers/anilist-v2.js" }),
    ]);
    const p2 = new EmbeddedRegistryProvider({
      registries: new MemRegistryStore(),
      installed: new MemInstalledStore(),
      installedTrackers,
      fetcher: fakeFetcher(indexes),
    });
    let changed = 0;
    p2.onChange = () => (changed += 1);
    const updates = await p2.checkTrackerUpdates();

    expect(updates).toEqual([]); // not a version bump, so not reported as a user-facing "update"
    expect(changed).toBe(1); // but the drop-cache/refetch side effect still fires, so it self-heals
    const rec = await installedTrackers.get("anilist");
    expect(rec?.sha256).toBe("b".repeat(64));
    expect(rec?.url).toBe("https://reg-a.example/trackers/anilist-v2.js");
    expect(rec?.version).toBe("1.0.0");
    expect(rec?.availableVersion).toBeUndefined();
    expect(rec?.discontinued).toBeUndefined();
  });

  test("checkTrackerUpdates() marks a tracker dropped from the index as discontinued (kept installed)", async () => {
    const indexes: Record<string, RegistryIndex> = { [REG_A]: trackerIndex([trackerEntry()]) };
    const { provider, installedTrackers } = setup(indexes);
    await provider.installTracker(REG_A, "anilist");

    indexes[REG_A] = trackerIndex([]); // tracker removed from the registry
    const p2 = new EmbeddedRegistryProvider({
      registries: new MemRegistryStore(),
      installed: new MemInstalledStore(),
      installedTrackers,
      fetcher: fakeFetcher(indexes),
    });
    const updates = await p2.checkTrackerUpdates();
    expect(updates).toEqual([]); // discontinued is not an "update"
    const rec = await installedTrackers.get("anilist");
    expect(rec).not.toBeNull(); // still installed → keeps working from its pinned bundle
    expect(rec?.discontinued).toBe(true);
  });

  test("checkTrackerUpdates() fires onChange only when it persists an annotation change", async () => {
    const installedTrackers = new MemInstalledTrackerStore();
    await installedTrackers.add(trackerRecordFor({ version: "1.0.0" }));

    const p1 = new EmbeddedRegistryProvider({
      registries: new MemRegistryStore(),
      installed: new MemInstalledStore(),
      installedTrackers,
      fetcher: fakeFetcher({ [REG_A]: trackerIndex([trackerEntry({ version: "2.0.0" })]) }),
    });
    let changed1 = 0;
    p1.onChange = () => (changed1 += 1);
    await p1.checkTrackerUpdates();
    expect(changed1).toBe(1);
    expect((await installedTrackers.get("anilist"))?.availableVersion).toBe("2.0.0");

    // A second check over the already-recorded state changes nothing → onChange must NOT fire.
    const p2 = new EmbeddedRegistryProvider({
      registries: new MemRegistryStore(),
      installed: new MemInstalledStore(),
      installedTrackers,
      fetcher: fakeFetcher({ [REG_A]: trackerIndex([trackerEntry({ version: "2.0.0" })]) }),
    });
    let changed2 = 0;
    p2.onChange = () => (changed2 += 1);
    await p2.checkTrackerUpdates();
    expect(changed2).toBe(0);
  });

  test("remove() keeps installed trackers (they stay pinned)", async () => {
    const { provider, installedTrackers } = setup({ [REG_A]: trackerIndex([trackerEntry()]) });
    await provider.add(REG_A);
    await provider.installTracker(REG_A, "anilist");
    await provider.remove(REG_A);
    expect(await provider.list()).toHaveLength(0);
    expect(await installedTrackers.get("anilist")).not.toBeNull();
  });
});
