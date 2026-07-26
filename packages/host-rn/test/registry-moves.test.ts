/**
 * On-device registry moves — `EmbeddedRegistryProvider`'s half of `movedTo`/`movedFrom`.
 *
 * The trust decisions themselves are shared with the server (`@comical/registry/moves`) and covered
 * in that package's tests. What's device-specific — and tested here — is the persistence: three
 * separate AsyncStorage documents instead of one manifest file, records that pin an absolute bundle
 * URL on the host that may be the very thing that went away, and `checkUpdates` marking anything
 * absent from an index `discontinued` (which a forwarding stub would trip for every bridge at once).
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPair, publicKeyFingerprint } from "@comical/registry/verify";
import { MoveError } from "@comical/registry/moves";
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

const OLD = "https://old.example/index.json";
const NEW = "https://new.example/index.json";

// ── In-memory stores ──────────────────────────────────────────────────────────

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

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SHA = "a".repeat(64);

function bridge(over: Partial<RegistryBridgeEntry> = {}): RegistryBridgeEntry {
  return {
    id: "demo", name: "Demo", version: "1.0.0", contractVersion: "1.0.0",
    languages: ["en"], nsfw: false, capabilities: ["search"],
    url: `${new URL(OLD).origin}/bridges/demo.js`, sha256: SHA, ...over,
  };
}

function tracker(over: Partial<RegistryTrackerEntry> = {}): RegistryTrackerEntry {
  return {
    id: "anilist", name: "AniList", version: "1.0.0", contractVersion: "1.0.0",
    capabilities: ["library-sync"], url: `${new URL(OLD).origin}/trackers/anilist.js`,
    sha256: SHA, ...over,
  };
}

function index(over: Partial<RegistryIndex> = {}): RegistryIndex {
  return { registryVersion: "1", updated: new Date().toISOString(), bridges: [bridge()], ...over };
}

function record(over: Partial<InstalledBridgeRecord> = {}): InstalledBridgeRecord {
  const e = bridge();
  return {
    id: e.id, registryUrl: OLD, version: e.version, contractVersion: e.contractVersion,
    info: entryToInfo(e), url: e.url, sha256: e.sha256, ...over,
  };
}

function trackerRecord(over: Partial<InstalledTrackerRecord> = {}): InstalledTrackerRecord {
  const e = tracker();
  return {
    id: e.id, registryUrl: OLD, version: e.version, contractVersion: e.contractVersion,
    info: entryToTrackerInfo(e), url: e.url, sha256: e.sha256, ...over,
  };
}

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

interface SetupOpts {
  indexes: Record<string, RegistryIndex>;
  saved?: SavedRegistry[];
  installed?: InstalledBridgeRecord[];
  trackers?: InstalledTrackerRecord[];
}

function setup({ indexes, saved = [], installed = [], trackers = [] }: SetupOpts) {
  const registries = new MemRegistries();
  const inst = new MemInstalled();
  const trk = new MemTrackers();
  for (const r of saved) registries.map.set(r.url, r);
  for (const r of installed) inst.map.set(r.id, r);
  for (const r of trackers) trk.map.set(r.id, r);
  const provider = new EmbeddedRegistryProvider({
    registries, installed: inst, installedTrackers: trk, fetcher: fetcher(indexes),
  });
  return { provider, registries, installed: inst, trackers: trk };
}

const savedAt = (url: string, over: Partial<SavedRegistry> = {}): SavedRegistry =>
  ({ url, name: url, requireSignature: false, ...over });

// ── movedTo ───────────────────────────────────────────────────────────────────

describe("movedTo", () => {
  test("with key continuity: repoints the registry, the bridges and the trackers", async () => {
    const { publicKey } = await generateKeyPair();
    const fp = await publicKeyFingerprint(publicKey);
    const { provider, registries, installed, trackers } = setup({
      indexes: {
        [OLD]: index({ bridges: [], publicKey, movedTo: NEW }),
        [NEW]: index({ bridges: [bridge()], trackers: [tracker()], publicKey }),
      },
      saved: [savedAt(OLD, { publicKeyFingerprint: fp })],
      installed: [record()],
      trackers: [trackerRecord()],
    });

    await provider.browse(OLD);

    expect((await registries.all()).map((r) => r.url)).toEqual([NEW]);
    expect((await installed.get("demo"))?.registryUrl).toBe(NEW);
    expect((await trackers.get("anilist"))?.registryUrl).toBe(NEW);
    // The pinned key travels with the registry, so the *next* move is verifiable too.
    expect((await registries.get(NEW))?.publicKeyFingerprint).toBe(fp);
  });

  test("re-pins the bundle URL onto the new host when the bytes are identical", async () => {
    // The old host is the one that went away — a record still pointing at it would 404 on the next
    // cache miss, which on device means the bridge stops loading entirely.
    const { publicKey } = await generateKeyPair();
    const fp = await publicKeyFingerprint(publicKey);
    const newBundleUrl = "https://new.example/bridges/demo.js";
    const { provider, installed } = setup({
      indexes: {
        [OLD]: index({ bridges: [], publicKey, movedTo: NEW }),
        [NEW]: index({ bridges: [bridge({ url: newBundleUrl })], publicKey }),
      },
      saved: [savedAt(OLD, { publicKeyFingerprint: fp })],
      installed: [record()],
    });

    await provider.browse(OLD);

    const rec = await installed.get("demo");
    expect(rec?.url).toBe(newBundleUrl);
    expect(rec?.sha256).toBe(SHA); // unchanged — that's the precondition for re-pinning at all
    expect(rec?.version).toBe("1.0.0");
  });

  test("leaves the pinned URL alone when the target serves different bytes at that version", async () => {
    // Different sha256 at the same version is a republish, not a move artefact. Re-pinning would
    // swap the installed bytes silently; leave it for checkUpdates' same-version self-heal instead.
    const { publicKey } = await generateKeyPair();
    const fp = await publicKeyFingerprint(publicKey);
    const { provider, installed } = setup({
      indexes: {
        [OLD]: index({ bridges: [], publicKey, movedTo: NEW }),
        [NEW]: index({ bridges: [bridge({ url: "https://new.example/x.js", sha256: "b".repeat(64) })], publicKey }),
      },
      saved: [savedAt(OLD, { publicKeyFingerprint: fp })],
      installed: [record()],
    });

    await provider.browse(OLD);

    const rec = await installed.get("demo");
    expect(rec?.url).toBe("https://old.example/bridges/demo.js");
    expect(rec?.sha256).toBe(SHA);
    expect(rec?.registryUrl).toBe(NEW); // the registry still moved
  });

  test("without key continuity: parked as pendingMove, nothing repointed", async () => {
    const { provider, registries, installed } = setup({
      indexes: {
        [OLD]: index({ bridges: [], movedTo: NEW }),
        [NEW]: index(),
      },
      saved: [savedAt(OLD)],
      installed: [record()],
    });

    await provider.browse(OLD);

    expect((await registries.get(OLD))?.pendingMove).toBe(NEW);
    expect((await installed.get("demo"))?.registryUrl).toBe(OLD);
  });

  test("a forwarding stub never marks the registry's bridges discontinued", async () => {
    // Without the pendingMove guard, checkUpdates would evaluate every install against an index that
    // deliberately lists nothing — and flag the lot as gone.
    const { provider, registries, installed } = setup({
      indexes: { [OLD]: index({ bridges: [], movedTo: NEW }), [NEW]: index() },
      saved: [savedAt(OLD)],
      installed: [record()],
      trackers: [trackerRecord()],
    });

    expect(await provider.checkUpdates()).toEqual([]);
    expect(await provider.checkTrackerUpdates()).toEqual([]);
    expect((await installed.get("demo"))?.discontinued).toBeUndefined();
    expect((await registries.get(OLD))?.pendingMove).toBe(NEW);
  });

  test("confirmMove applies a held move; dismissMove drops it", async () => {
    const { provider, registries, installed } = setup({
      indexes: { [OLD]: index({ bridges: [], movedTo: NEW }), [NEW]: index() },
      saved: [savedAt(OLD)],
      installed: [record()],
    });
    await provider.browse(OLD); // parks the claim

    expect(await provider.confirmMove(OLD)).toBe(NEW);
    expect((await registries.all()).map((r) => r.url)).toEqual([NEW]);
    expect((await installed.get("demo"))?.registryUrl).toBe(NEW);
    expect((await registries.get(NEW))?.pendingMove).toBeUndefined();

    const d = setup({
      indexes: { [OLD]: index({ bridges: [], movedTo: NEW }), [NEW]: index() },
      saved: [savedAt(OLD)],
      installed: [record()],
    });
    await d.provider.browse(OLD);
    await d.provider.dismissMove(OLD);
    expect((await d.registries.get(OLD))?.pendingMove).toBeUndefined();
    expect((await d.registries.all()).map((r) => r.url)).toEqual([OLD]);
  });

  test("confirmMove refuses when the target shares no installed ids", async () => {
    const { provider, installed } = setup({
      indexes: {
        [OLD]: index({ bridges: [], movedTo: NEW }),
        [NEW]: index({ bridges: [bridge({ id: "someone-else" })] }),
      },
      saved: [savedAt(OLD)],
      installed: [record()],
    });
    await provider.browse(OLD);
    await expect(provider.confirmMove(OLD)).rejects.toBeInstanceOf(MoveError);
    expect((await installed.get("demo"))?.registryUrl).toBe(OLD);
  });

  test("add() follows the move and lands on the canonical URL", async () => {
    const { provider, registries } = setup({
      indexes: { [OLD]: index({ bridges: [], movedTo: NEW }), [NEW]: index() },
    });
    const added = await provider.add(OLD);
    expect(added.url).toBe(NEW);
    expect((await registries.all()).map((r) => r.url)).toEqual([NEW]);
  });

  test("add() pins the index's key fingerprint", async () => {
    const { publicKey } = await generateKeyPair();
    const { provider, registries } = setup({ indexes: { [OLD]: index({ publicKey }) } });
    await provider.add(OLD);
    expect((await registries.get(OLD))?.publicKeyFingerprint).toBe(await publicKeyFingerprint(publicKey));
  });

  test("a self-referencing movedTo terminates", async () => {
    const { provider, registries } = setup({ indexes: { [OLD]: index({ movedTo: OLD }) } });
    await provider.add(OLD);
    expect((await registries.all()).map((r) => r.url)).toEqual([OLD]);
  });
});

// ── movedFrom ─────────────────────────────────────────────────────────────────

describe("movedFrom", () => {
  test("adopts a predecessor automatically under key continuity", async () => {
    const { publicKey } = await generateKeyPair();
    const fp = await publicKeyFingerprint(publicKey);
    const { provider, registries, installed } = setup({
      indexes: { [NEW]: index({ publicKey, movedFrom: [OLD] }) },
      saved: [savedAt(OLD, { publicKeyFingerprint: fp })],
      installed: [record()],
    });

    await provider.add(NEW);

    expect((await registries.all()).map((r) => r.url)).toEqual([NEW]);
    expect((await installed.get("demo"))?.registryUrl).toBe(NEW);
    expect((await registries.get(NEW))?.pendingAdoption).toBeUndefined();
  });

  test("an unverified claim is offered, not taken — then confirmAdoption applies it", async () => {
    const { provider, registries, installed } = setup({
      indexes: { [NEW]: index({ movedFrom: [OLD] }) },
      saved: [savedAt(OLD)],
      installed: [record()],
    });

    const added = await provider.add(NEW);
    expect(added.pendingAdoption).toEqual([OLD]);
    expect((await installed.get("demo"))?.registryUrl).toBe(OLD);
    expect((await registries.all()).length).toBe(2);

    await provider.confirmAdoption(NEW, OLD);
    expect((await registries.all()).map((r) => r.url)).toEqual([NEW]);
    expect((await installed.get("demo"))?.registryUrl).toBe(NEW);
    expect((await registries.get(NEW))?.pendingAdoption).toBeUndefined();
  });

  test("confirmAdoption refuses a URL the registry never claimed", async () => {
    const { provider } = setup({
      indexes: { [NEW]: index(), [OLD]: index() },
      saved: [savedAt(OLD), savedAt(NEW)],
    });
    await expect(provider.confirmAdoption(NEW, OLD)).rejects.toBeInstanceOf(MoveError);
  });

  test("a claim sharing no installed ids is not even offered", async () => {
    const { provider, registries, installed } = setup({
      indexes: { [NEW]: index({ bridges: [bridge({ id: "unrelated" })], movedFrom: [OLD] }) },
      saved: [savedAt(OLD)],
      installed: [record()],
    });
    await provider.add(NEW);
    expect((await registries.get(NEW))?.pendingAdoption).toBeUndefined();
    expect((await installed.get("demo"))?.registryUrl).toBe(OLD);
  });

  test("a claim on a registry the user doesn't have is ignored", async () => {
    const { provider, registries } = setup({
      indexes: { [NEW]: index({ movedFrom: ["https://never-added.example/index.json"] }) },
    });
    await provider.add(NEW);
    expect((await registries.get(NEW))?.pendingAdoption).toBeUndefined();
  });
});

// ── Store write ordering ──────────────────────────────────────────────────────

describe("rebind write ordering", () => {
  test("the new registry row is written before any install moves, and the old row removed last", async () => {
    // Three separate AsyncStorage documents means a rebind can be interrupted between writes. This
    // order is what guarantees the intermediate states are all survivable: an install always points
    // at a registry that is in the saved list.
    const { publicKey } = await generateKeyPair();
    const fp = await publicKeyFingerprint(publicKey);
    const registries = new MemRegistries();
    const installed = new MemInstalled();
    registries.map.set(OLD, savedAt(OLD, { publicKeyFingerprint: fp }));
    installed.map.set("demo", record());

    const log: string[] = [];
    const traced: SavedRegistryStore = {
      all: () => registries.all(),
      get: (u) => registries.get(u),
      async add(r) { log.push(`registry.add ${r.url}`); await registries.add(r); },
      async remove(u) { log.push(`registry.remove ${u}`); await registries.remove(u); },
    };
    const tracedInstalled: InstalledStore = {
      all: () => installed.all(),
      get: (i) => installed.get(i),
      async add(r) { log.push(`installed.add ${r.id}→${r.registryUrl}`); await installed.add(r); },
      remove: (i) => installed.remove(i),
    };

    const provider = new EmbeddedRegistryProvider({
      registries: traced,
      installed: tracedInstalled,
      installedTrackers: new MemTrackers(),
      fetcher: fetcher({
        [OLD]: index({ bridges: [], publicKey, movedTo: NEW }),
        [NEW]: index({ publicKey }),
      }),
    });
    await provider.browse(OLD);

    expect(log).toEqual([
      `registry.add ${NEW}`,
      `installed.add demo→${NEW}`,
      `registry.remove ${OLD}`,
    ]);
  });

  test("locally-pinned records from other registries are untouched", async () => {
    const { publicKey } = await generateKeyPair();
    const fp = await publicKeyFingerprint(publicKey);
    const other = "https://other.example/index.json";
    const { provider, installed } = setup({
      indexes: {
        [OLD]: index({ bridges: [], publicKey, movedTo: NEW }),
        [NEW]: index({ publicKey }),
      },
      saved: [savedAt(OLD, { publicKeyFingerprint: fp }), savedAt(other)],
      installed: [record(), record({ id: "elsewhere", registryUrl: other })],
    });

    await provider.browse(OLD);

    expect((await installed.get("demo"))?.registryUrl).toBe(NEW);
    expect((await installed.get("elsewhere"))?.registryUrl).toBe(other);
  });
});
