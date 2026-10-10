/**
 * On-device retired bridges — `EmbeddedRegistryProvider` keeps what the library needs of a bridge
 * when it is uninstalled (its series stay), drops that on reinstall, names missing bridges from it,
 * and carries it along when the registry moves. The lookup order itself is `describeMissingBridges`,
 * covered in `@comical/registry`.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPair, publicKeyFingerprint } from "@comical/registry/verify";
import type { RegistryBridgeEntry, RegistryIndex, RetiredBridge, SavedRegistry } from "@comical/registry/schema";
import { EmbeddedRegistryProvider } from "../src/registry-provider.ts";
import type { RegistryFetcher } from "../src/registry-bundle-source.ts";
import type {
  InstalledBridgeRecord,
  InstalledStore,
  InstalledTrackerRecord,
  InstalledTrackerStore,
  RetiredStore,
  SavedRegistryStore,
} from "../src/types.ts";

const OLD = "https://old.example/index.json";
const NEW = "https://new.example/index.json";

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

class MemRetired implements RetiredStore {
  readonly map = new Map<string, RetiredBridge>();
  async all() { return [...this.map.values()]; }
  async add(r: RetiredBridge) { this.map.set(r.id, r); }
  async remove(id: string) { this.map.delete(id); }
}

function bridge(over: Partial<RegistryBridgeEntry> = {}): RegistryBridgeEntry {
  return {
    id: "adult", name: "Adult", version: "1.0.0", contractVersion: "2.0.0",
    languages: ["en"], nsfw: true, capabilities: ["direct"],
    url: "https://old.example/bridges/adult.js", sha256: "a".repeat(64), ...over,
  };
}

function index(over: Partial<RegistryIndex> = {}): RegistryIndex {
  return { registryVersion: "1", updated: new Date().toISOString(), bridges: [bridge()], ...over };
}

function setup(indexes: Record<string, RegistryIndex>, opts: { retired?: boolean } = {}) {
  let fetches = 0;
  const fetcher: RegistryFetcher = {
    async fetchIndex(url) {
      fetches++;
      const idx = indexes[url];
      if (!idx) throw new Error(`no index at ${url}`);
      return idx;
    },
    async downloadBundle() { return { text: "module.exports = {};" }; },
  };
  const registries = new MemRegistries();
  const installed = new MemInstalled();
  const retired = new MemRetired();
  const provider = new EmbeddedRegistryProvider({
    registries, installed, installedTrackers: new MemTrackers(), fetcher,
    ...(opts.retired === false ? {} : { retired }),
  });
  return { provider, registries, installed, retired, fetches: () => fetches };
}

describe("retired bridges on device", () => {
  test("uninstall keeps the bridge's name, rating, capabilities and registry", async () => {
    const { provider, installed, retired } = setup({ [OLD]: index() });
    await provider.add(OLD);
    await provider.install(OLD, "adult");
    await provider.uninstall("adult");

    expect(await installed.get("adult")).toBeNull();
    expect(retired.map.get("adult")).toMatchObject({
      id: "adult", registryUrl: OLD, info: { name: "Adult", nsfw: true, capabilities: ["direct"] },
    });
    expect(await provider.describeBridges(["adult"], { network: false })).toEqual([
      { id: "adult", name: "Adult", nsfw: true, capabilities: ["direct"], registryUrl: OLD },
    ]);
  });

  test("reinstalling clears the retired record", async () => {
    const { provider, retired } = setup({ [OLD]: index() });
    await provider.add(OLD);
    await provider.install(OLD, "adult");
    await provider.uninstall("adult");
    await provider.install(OLD, "adult");
    expect(retired.map.size).toBe(0);
  });

  test("uninstalling something not installed records nothing", async () => {
    const { provider, retired } = setup({ [OLD]: index() });
    await provider.uninstall("ghost");
    expect(retired.map.size).toBe(0);
  });

  test("without a retired store, uninstall still works and a missing bridge is named from its registry", async () => {
    const { provider, installed } = setup({ [OLD]: index() }, { retired: false });
    await provider.add(OLD);
    await provider.install(OLD, "adult");
    await provider.uninstall("adult");
    expect(await installed.get("adult")).toBeNull();
    expect(await provider.describeBridges(["adult"])).toEqual([
      { id: "adult", name: "Adult", nsfw: true, capabilities: ["direct"], registryUrl: OLD },
    ]);
  });

  test("goes to the network only when asked to and something is still unknown", async () => {
    const { provider, registries, fetches } = setup({ [OLD]: index({ bridges: [bridge({ id: "remote", name: "Remote" })] }) });
    // Saved without a fetch, so nothing is cached.
    registries.map.set(OLD, { url: OLD, name: "old", requireSignature: false });

    expect(await provider.describeBridges([])).toEqual([]);
    expect(await provider.describeBridges(["remote"], { network: false })).toEqual([{ id: "remote" }]);
    expect(fetches()).toBe(0);

    expect((await provider.describeBridges(["remote", "nobody"]))).toEqual([
      { id: "remote", name: "Remote", nsfw: true, capabilities: ["direct"], registryUrl: OLD },
      { id: "nobody" },
    ]);
    expect(fetches()).toBeGreaterThan(0);
  });

  test("a registry move repoints retired records too", async () => {
    const { publicKey } = await generateKeyPair();
    const fp = await publicKeyFingerprint(publicKey);
    const both = [bridge(), bridge({ id: "keeper", name: "Keeper", nsfw: false, capabilities: [] })];
    const indexes: Record<string, RegistryIndex> = { [OLD]: index({ bridges: both, publicKey }) };
    const first = setup(indexes);
    await first.provider.add(OLD);
    first.registries.map.set(OLD, { ...(await first.registries.get(OLD))!, publicKeyFingerprint: fp });
    await first.provider.install(OLD, "adult");
    await first.provider.install(OLD, "keeper");
    await first.provider.uninstall("adult");

    // The registry moves. A fresh provider, so the memoized old index doesn't hide the move.
    indexes[OLD] = index({ bridges: [], publicKey, movedTo: NEW });
    indexes[NEW] = index({ bridges: both, publicKey });
    const { registries, retired } = first;
    const provider = new EmbeddedRegistryProvider({
      registries,
      installed: first.installed,
      installedTrackers: new MemTrackers(),
      retired,
      fetcher: { fetchIndex: async (url) => indexes[url]!, downloadBundle: async () => ({ text: "" }) },
    });
    await provider.browse(OLD);

    expect((await registries.all()).map((r) => r.url)).toEqual([NEW]);
    expect(retired.map.get("adult")?.registryUrl).toBe(NEW);
  });
});
