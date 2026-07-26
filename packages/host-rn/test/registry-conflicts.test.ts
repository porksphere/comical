/**
 * On-device half of the install-conflict guard. The decision itself is shared
 * (`@comical/registry/conflicts`) and unit-tested there; what's device-specific — and tested here —
 * is that `EmbeddedRegistryProvider`'s install paths actually consult it before writing, on both
 * bridges and trackers, and that the paths that *must* keep overwriting (update/re-pin, and an
 * install after a followed registry move) still do.
 */
import { describe, expect, test } from "bun:test";
import { InstallConflictError } from "@comical/registry/conflicts";
import { generateKeyPair, publicKeyFingerprint } from "@comical/registry/verify";
import type { RegistryBridgeEntry, RegistryIndex, RegistryTrackerEntry, SavedRegistry } from "@comical/registry/schema";
import { EmbeddedRegistryProvider } from "../src/registry-provider.ts";
import { entryToInfo, type RegistryFetcher } from "../src/registry-bundle-source.ts";
import type {
  InstalledBridgeRecord,
  InstalledStore,
  InstalledTrackerRecord,
  InstalledTrackerStore,
  SavedRegistryStore,
} from "../src/types.ts";

const A = "https://a.example/index.json";
const B = "https://b.example/index.json";
const SHA = "a".repeat(64);

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

describe("install conflicts (on device)", () => {
  test("a second registry cannot take over an installed bridge id", async () => {
    const { provider, installed } = setup(
      { [A]: index(), [B]: index({ bridges: [bridge({ url: "https://b.example/bridges/demo.js", version: "9.9.9" })] }) },
      [savedAt(A), savedAt(B)],
    );
    await provider.install(A, "demo");
    await expect(provider.install(B, "demo")).rejects.toThrow(InstallConflictError);
    // The pin still points at A — the record wasn't partially rewritten before the throw.
    const held = installed.map.get("demo")!;
    expect(held.registryUrl).toBe(A);
    expect(held.url).toBe("https://a.example/bridges/demo.js");
    expect(held.version).toBe("1.0.0");
  });

  test("the owning registry can still re-pin and update", async () => {
    const { provider, installed } = setup({ [A]: index() }, [savedAt(A)]);
    await provider.install(A, "demo");
    await provider.install(A, "demo"); // re-pin
    expect(installed.map.get("demo")!.registryUrl).toBe(A);
    await expect(provider.update("demo")).resolves.toBeDefined();
  });

  test("a second registry cannot take over an installed tracker id either", async () => {
    const withTracker = (url: string) => index({ bridges: [], trackers: [tracker({ url: `${url}/t.js` })] });
    const { provider, trackers } = setup(
      { [A]: withTracker("https://a.example"), [B]: withTracker("https://b.example") },
      [savedAt(A), savedAt(B)],
    );
    await provider.installTracker(A, "anilist");
    await expect(provider.installTracker(B, "anilist")).rejects.toThrow(InstallConflictError);
    expect(trackers.map.get("anilist")!.registryUrl).toBe(A);
  });

  test("a followed move doesn't leave the moved install unreachable to its own registry", async () => {
    // The guard compares against the record's registryUrl, and `rebind` rewrites that to the new URL
    // before any later install runs. If the two ever disagreed, a migrated user could never update
    // again — the failure mode this test exists to catch.
    const { publicKey } = await generateKeyPair();
    const fp = await publicKeyFingerprint(publicKey);
    const { provider, installed } = setup(
      {
        [A]: index({ bridges: [], publicKey, movedTo: B }),
        [B]: index({ bridges: [bridge({ url: "https://b.example/bridges/demo.js" })], publicKey }),
      },
      [savedAt(A, { publicKeyFingerprint: fp })],
    );
    // Seed an install from A, then let a background path follow the move.
    installed.map.set("demo", {
      id: "demo", registryUrl: A, version: "1.0.0", contractVersion: "1.0.0",
      info: entryToInfo(bridge()), url: "https://a.example/bridges/demo.js", sha256: SHA,
    });
    await provider.browse(A);
    expect(installed.map.get("demo")!.registryUrl).toBe(B);
    // The new home can now install/update it — the guard sees the same registry, not a takeover.
    await expect(provider.install(B, "demo")).resolves.toBeDefined();
    expect(installed.map.get("demo")!.url).toBe("https://b.example/bridges/demo.js");
  });

  test("an uninstall clears the way for the other registry", async () => {
    const { provider, installed } = setup(
      { [A]: index(), [B]: index({ bridges: [bridge({ url: "https://b.example/bridges/demo.js" })] }) },
      [savedAt(A), savedAt(B)],
    );
    await provider.install(A, "demo");
    await provider.uninstall("demo");
    await provider.install(B, "demo");
    expect(installed.map.get("demo")!.registryUrl).toBe(B);
  });
});
