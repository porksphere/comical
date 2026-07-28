/**
 * On-device half of the contract-compatibility guard. The rule is shared
 * (`@comical/registry/compat`) and unit-tested there; what's device-specific — and tested here — is
 * that `EmbeddedRegistryProvider` consults it on install, and that `checkUpdates` neither offers nor
 * *persists* an `availableVersion` this build can't load, on both bridges and trackers.
 *
 * The subtle one is the last test in each pair. `checkUpdates` also self-heals a same-version hash
 * drift by re-pinning the record to the registry's current bytes. Suppressing `availableVersion`
 * naively makes an incompatible *newer* version look like a same-version republish to that branch —
 * which would re-pin the record straight onto the bundle the loader refuses. That's why the code
 * keeps `hasNewer` separate from `availableVersion`.
 *
 * `CONTRACT_VERSION` is "1.0.0", so "2.0.0" below means "needs a newer app than this build".
 */
import { describe, expect, test } from "bun:test";
import { ContractIncompatibleError } from "@comical/registry/compat";
import type { RegistryBridgeEntry, RegistryIndex, RegistryTrackerEntry, SavedRegistry } from "@comical/registry/schema";
import { EmbeddedRegistryProvider } from "../src/registry-provider.ts";
import { entryToInfo, entryToTrackerInfo, type RegistryFetcher } from "../src/registry-bundle-source.ts";
import type {
  InstalledBridgeRecord,
  InstalledStore,
  InstalledTrackerRecord,
  InstalledTrackerStore,
  SavedRegistryStore,
} from "../src/types.ts";

const A = "https://a.example/index.json";
const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

class MemInstalled implements InstalledStore {
  readonly map = new Map<string, InstalledBridgeRecord>();
  async all() { return [...this.map.values()]; }
  async get(id: string) { return this.map.get(id) ?? null; }
  async add(r: InstalledBridgeRecord) { this.map.set(r.id, r); }
  async remove(id: string) { this.map.delete(id); }
}
class MemTrackers implements InstalledTrackerStore {
  readonly map = new Map<string, InstalledTrackerRecord>();
  async all() { return [...this.map.values()]; }
  async get(id: string) { return this.map.get(id) ?? null; }
  async add(r: InstalledTrackerRecord) { this.map.set(r.id, r); }
  async remove(id: string) { this.map.delete(id); }
}
class MemRegistries implements SavedRegistryStore {
  readonly map = new Map<string, SavedRegistry>();
  async all() { return [...this.map.values()]; }
  async get(url: string) { return this.map.get(url) ?? null; }
  async add(r: SavedRegistry) { this.map.set(r.url, r); }
  async remove(url: string) { this.map.delete(url); }
}

const bridge = (over: Partial<RegistryBridgeEntry> = {}): RegistryBridgeEntry => ({
  id: "demo", name: "Demo", version: "1.0.0", contractVersion: "1.0.0",
  languages: ["en"], nsfw: false, capabilities: ["search"],
  url: "https://a.example/bridges/demo.js", sha256: SHA, ...over,
});
const tracker = (over: Partial<RegistryTrackerEntry> = {}): RegistryTrackerEntry => ({
  id: "anilist", name: "AniList", version: "1.0.0", contractVersion: "1.0.0",
  capabilities: ["library-sync"], url: "https://a.example/trackers/anilist.js", sha256: SHA, ...over,
});
const index = (over: Partial<RegistryIndex> = {}): RegistryIndex =>
  ({ registryVersion: "1", updated: new Date().toISOString(), bridges: [bridge()], ...over });
const savedAt = (url: string, over: Partial<SavedRegistry> = {}): SavedRegistry =>
  ({ url, name: url, requireSignature: false, ...over });

function fetcher(indexes: Record<string, RegistryIndex>): RegistryFetcher {
  return {
    async fetchIndex(url) {
      const idx = indexes[url];
      if (!idx) throw new Error(`no index at ${url}`);
      return idx;
    },
    async downloadBundle() { return { text: "module.exports = {};" }; },
  };
}

function setup(indexes: Record<string, RegistryIndex>, saved: SavedRegistry[] = []) {
  const registries = new MemRegistries();
  const installed = new MemInstalled();
  const trackers = new MemTrackers();
  for (const r of saved) registries.map.set(r.url, r);
  const provider = new EmbeddedRegistryProvider({
    registries, installed, installedTrackers: trackers, fetcher: fetcher(indexes),
  });
  return { provider, registries, installed, trackers };
}

/** An installed record one version behind whatever the index offers. */
const installedBridge = (over: Partial<InstalledBridgeRecord> = {}): InstalledBridgeRecord => ({
  id: "demo", registryUrl: A, version: "0.9.0", contractVersion: "1.0.0",
  info: entryToInfo(bridge()), url: "https://a.example/bridges/demo.js", sha256: SHA, ...over,
});
const installedTracker = (over: Partial<InstalledTrackerRecord> = {}): InstalledTrackerRecord => ({
  id: "anilist", registryUrl: A, version: "0.9.0", contractVersion: "1.0.0",
  info: entryToTrackerInfo(tracker()), url: "https://a.example/trackers/anilist.js", sha256: SHA, ...over,
});

describe("contract compatibility (bridges, on device)", () => {
  test("install refuses an entry targeting a contract this build can't load", async () => {
    const { provider, installed } = setup({ [A]: index({ bridges: [bridge({ contractVersion: "2.0.0" })] }) }, [savedAt(A)]);
    await expect(provider.install(A, "demo")).rejects.toThrow(ContractIncompatibleError);
    // Nothing recorded: the loader's rejection would otherwise be the user's first sign of trouble,
    // with a phantom "installed" row already sitting in the list.
    expect(installed.map.size).toBe(0);
  });

  test("checkUpdates doesn't offer — or persist — an unloadable newer version", async () => {
    const { provider, installed } = setup({ [A]: index({ bridges: [bridge({ version: "2.0.0", contractVersion: "2.0.0" })] }) }, [savedAt(A)]);
    installed.map.set("demo", installedBridge());

    expect(await provider.checkUpdates()).toEqual([]);
    const rec = installed.map.get("demo")!;
    // No badge on the record either — the annotation is what the Bridges list renders the dot from.
    expect(rec.availableVersion).toBeUndefined();
    // Present in the index, so not discontinued — just not upgradable from this build.
    expect(rec.discontinued).toBeUndefined();
    expect(rec.version).toBe("0.9.0");
  });

  test("an unloadable newer version does not trigger the same-version self-heal re-pin", async () => {
    // The regression this file exists for. A newer-but-incompatible entry has a different sha256
    // than the pinned record (different bytes, different version). If it isn't counted as "newer",
    // the drift branch reads it as a republish-at-the-same-version and re-pins url/sha256/info onto
    // the bundle the loader refuses — turning a working install into a broken one, silently.
    const { provider, installed } = setup(
      { [A]: index({ bridges: [bridge({ version: "2.0.0", contractVersion: "2.0.0", sha256: OTHER_SHA, url: "https://a.example/bridges/demo-2.js" })] }) },
      [savedAt(A)],
    );
    installed.map.set("demo", installedBridge());

    await provider.checkUpdates();

    const rec = installed.map.get("demo")!;
    expect(rec.sha256).toBe(SHA);
    expect(rec.url).toBe("https://a.example/bridges/demo.js");
    expect(rec.contractVersion).toBe("1.0.0");
  });

  test("a compatible newer version is still offered and annotated", async () => {
    // The control: suppression must be about the contract, not about updates in general.
    const { provider, installed } = setup({ [A]: index({ bridges: [bridge({ version: "2.0.0" })] }) }, [savedAt(A)]);
    installed.map.set("demo", installedBridge());

    expect(await provider.checkUpdates()).toEqual([{ id: "demo", installedVersion: "0.9.0", availableVersion: "2.0.0" }]);
    expect(installed.map.get("demo")!.availableVersion).toBe("2.0.0");
  });

  test("browse flags the entry instead of hiding it, and withholds the update", async () => {
    const { provider, installed } = setup({ [A]: index({ bridges: [bridge({ version: "2.0.0", contractVersion: "2.0.0" })] }) }, [savedAt(A)]);
    installed.map.set("demo", installedBridge());

    const [listed] = await provider.browse(A);
    expect(listed).toMatchObject({ compatible: false, updateAvailable: false, installedVersion: "0.9.0" });
  });
});

describe("contract compatibility (trackers, on device)", () => {
  const withTrackers = (t: RegistryTrackerEntry[]) => index({ bridges: [], trackers: t });

  test("installTracker refuses an entry targeting an unloadable contract", async () => {
    const { provider, trackers } = setup({ [A]: withTrackers([tracker({ contractVersion: "2.0.0" })]) }, [savedAt(A)]);
    await expect(provider.installTracker(A, "anilist")).rejects.toThrow(ContractIncompatibleError);
    expect(trackers.map.size).toBe(0);
  });

  test("checkTrackerUpdates doesn't offer — or persist — an unloadable newer version", async () => {
    const { provider, trackers } = setup(
      { [A]: withTrackers([tracker({ version: "2.0.0", contractVersion: "2.0.0" })]) },
      [savedAt(A)],
    );
    trackers.map.set("anilist", installedTracker());

    expect(await provider.checkTrackerUpdates()).toEqual([]);
    expect(trackers.map.get("anilist")!.availableVersion).toBeUndefined();
    expect(trackers.map.get("anilist")!.discontinued).toBeUndefined();
  });

  test("an unloadable newer tracker version does not trigger the self-heal re-pin", async () => {
    const { provider, trackers } = setup(
      { [A]: withTrackers([tracker({ version: "2.0.0", contractVersion: "2.0.0", sha256: OTHER_SHA, url: "https://a.example/trackers/anilist-2.js" })]) },
      [savedAt(A)],
    );
    trackers.map.set("anilist", installedTracker());

    await provider.checkTrackerUpdates();

    const rec = trackers.map.get("anilist")!;
    expect(rec.sha256).toBe(SHA);
    expect(rec.url).toBe("https://a.example/trackers/anilist.js");
  });

  test("a compatible newer tracker version is still offered", async () => {
    const { provider, trackers } = setup({ [A]: withTrackers([tracker({ version: "2.0.0" })]) }, [savedAt(A)]);
    trackers.map.set("anilist", installedTracker());

    expect(await provider.checkTrackerUpdates()).toEqual([
      { id: "anilist", installedVersion: "0.9.0", availableVersion: "2.0.0" },
    ]);
  });

  test("browseTrackers flags and withholds the same way", async () => {
    const { provider, trackers } = setup(
      { [A]: withTrackers([tracker({ version: "2.0.0", contractVersion: "2.0.0" })]) },
      [savedAt(A)],
    );
    trackers.map.set("anilist", installedTracker());

    const [listed] = await provider.browseTrackers(A);
    expect(listed).toMatchObject({ compatible: false, updateAvailable: false, installedVersion: "0.9.0" });
  });
});
