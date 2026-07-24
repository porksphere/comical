/**
 * The on-device `RegistryProvider` — the embedded counterpart to the server's `RegistryManager`.
 * It gives comical-app the same per-bridge install model the remote path has: browse a repo's
 * catalog, install/update/uninstall *individual* bridges, and detect version changes /
 * discontinuation — all driven through the **same** `@comical/host-server` router endpoints the
 * remote server exposes, so the app's existing registry UI works unchanged on device.
 *
 * It implements host-server's Node-free `RegistryProvider` interface over injected AsyncStorage
 * stores (the saved-registry list + the installed-bridge and installed-tracker manifests) and the
 * injected registry fetcher. Unlike `RegistryManager` it caches nothing to disk: an install writes
 * a pinned `InstalledBridgeRecord`/`InstalledTrackerRecord` (version + bundle url/sha256/signature)
 * that `ManifestBundleSource`/`ManifestTrackerBundleSource` later resolve. `remove` leaves installed
 * records intact — a pinned bridge/tracker keeps working after its registry is removed (the app
 * just stops seeing updates for it).
 *
 * Trackers are installed exactly like bridges — registry-backed, not a static app-bundled map (see
 * `TrackerBundleSource` in `types.ts`). The tracker methods below mirror the bridge methods above
 * 1:1, operating on `index.trackers` and `deps.installedTrackers` instead.
 */
import type { AvailableBridge, AvailableTracker, InstallResult } from "@comical/registry/available";
import type { RegistryIndex, SavedRegistry } from "@comical/registry/schema";
import { registryDisplayName, resolveRegistryUrl } from "@comical/registry/url";
import type { RegistryProvider, RegistryUpdate } from "@comical/host-server/registry-provider";
import { entryToInfo, entryToTrackerInfo, type RegistryFetcher } from "./registry-bundle-source.ts";
import type {
  InstalledBridgeRecord,
  InstalledStore,
  InstalledTrackerRecord,
  InstalledTrackerStore,
  SavedRegistryStore,
} from "./types.ts";

export interface EmbeddedRegistryProviderDeps {
  registries: SavedRegistryStore;
  installed: InstalledStore;
  installedTrackers: InstalledTrackerStore;
  fetcher: RegistryFetcher;
}

export class EmbeddedRegistryProvider implements RegistryProvider {
  /** Per-session index memo (mirrors `RegistryManager.fetchAndCache`); cleared per-url on update. */
  private readonly indexCache = new Map<string, RegistryIndex>();

  /**
   * Fired after any install/update/uninstall so the embedder can tear down cached bridge state and
   * refetch data screens. Set by the runtime wiring (see `install.ts`); a bare provider is inert.
   */
  onChange?: () => void;

  constructor(private readonly deps: EmbeddedRegistryProviderDeps) {}

  private async fetchAndCache(url: string): Promise<RegistryIndex> {
    const cached = this.indexCache.get(url);
    if (cached) return cached;
    const index = await this.deps.fetcher.fetchIndex(url);
    this.indexCache.set(url, index);
    await this.reconcileDisplayName(url, index);
    return index;
  }

  /**
   * Keep a saved registry's `displayName` in sync with its index, on every index fetch (the choke
   * point every browse/install/update/checkUpdates flows through) — so an operator's label change
   * propagates without re-adding, riding a fetch that was already happening. No-op unless it changed;
   * skipped for a url not yet saved (the fetch inside `add()`, which stores the label itself).
   */
  private async reconcileDisplayName(url: string, index: RegistryIndex): Promise<void> {
    const saved = await this.deps.registries.get(url);
    if (!saved) return;
    if ((saved.displayName ?? undefined) === (index.displayName ?? undefined)) return;
    const next = { ...saved };
    if (index.displayName) next.displayName = index.displayName;
    else delete next.displayName; // exactOptionalPropertyTypes: clear, don't write undefined
    await this.deps.registries.add(next); // upsert by url
  }

  // ── Registries ────────────────────────────────────────────────────────────────

  async list(): Promise<SavedRegistry[]> {
    return this.deps.registries.all();
  }

  async add(rawUrl: string, opts: { requireSignature?: boolean } = {}): Promise<SavedRegistry> {
    const url = resolveRegistryUrl(rawUrl);
    // Validate it's reachable + a well-formed index before saving, and capture the operator's label.
    const index = await this.fetchAndCache(url);
    const registry: SavedRegistry = {
      url,
      name: registryDisplayName(url),
      lastFetched: new Date().toISOString(),
      requireSignature: opts.requireSignature ?? false,
      ...(index.displayName ? { displayName: index.displayName } : {}),
    };
    await this.deps.registries.add(registry);
    return registry;
  }

  async remove(rawUrl: string): Promise<void> {
    const url = resolveRegistryUrl(rawUrl);
    await this.deps.registries.remove(url);
    this.indexCache.delete(url);
    // Installed bridges from this registry stay in the manifest (pinned) and keep working.
  }

  // ── Browsing ──────────────────────────────────────────────────────────────────

  async browse(rawUrl: string): Promise<AvailableBridge[]> {
    const url = resolveRegistryUrl(rawUrl);
    const index = await this.fetchAndCache(url);
    const installed = await this.deps.installed.all();
    const map = new Map(installed.map((b) => [b.id, b]));
    return index.bridges.map((entry) => {
      const local = map.get(entry.id);
      return {
        entry,
        registryUrl: url,
        installedVersion: local?.version ?? null,
        updateAvailable: !!local && isNewer(entry.version, local.version),
      };
    });
  }

  async browseAll(): Promise<AvailableBridge[]> {
    const registries = await this.list();
    const out: AvailableBridge[] = [];
    for (const reg of registries) {
      try {
        out.push(...(await this.browse(reg.url)));
      } catch {
        // A failing registry doesn't block the others.
      }
    }
    return out;
  }

  // ── Install / update / uninstall ────────────────────────────────────────────────

  async install(registryUrl: string, bridgeId: string): Promise<InstallResult> {
    const url = resolveRegistryUrl(registryUrl);
    const index = await this.fetchAndCache(url);
    const entry = index.bridges.find((b) => b.id === bridgeId);
    if (!entry) throw new Error(`bridge "${bridgeId}" not found in registry ${url}`);

    const record: InstalledBridgeRecord = {
      id: entry.id,
      registryUrl: url,
      version: entry.version,
      contractVersion: entry.contractVersion,
      info: entryToInfo(entry),
      url: entry.url,
      sha256: entry.sha256,
      ...(entry.signature !== undefined ? { signature: entry.signature } : {}),
      ...(index.publicKey !== undefined ? { publicKey: index.publicKey } : {}),
    };
    await this.deps.installed.add(record); // upsert — installing over an existing version re-pins it
    this.onChange?.();
    return { id: entry.id, version: entry.version, bundlePath: "" };
  }

  async update(bridgeId: string): Promise<InstallResult> {
    const current = await this.deps.installed.get(bridgeId);
    if (!current) throw new Error(`bridge "${bridgeId}" is not installed`);
    this.indexCache.delete(current.registryUrl); // force a refetch so a just-published version is seen
    return this.install(current.registryUrl, bridgeId);
  }

  async uninstall(bridgeId: string): Promise<void> {
    await this.deps.installed.remove(bridgeId);
    this.onChange?.();
  }

  /**
   * Refresh update/discontinuation annotations across all installed bridges (manual policy — never
   * auto-installs). Persists `availableVersion`/`discontinued` onto each record so `installed()` can
   * badge them without a round trip, and returns the rows that have a newer version (for the router's
   * `/registry/updates`). A bridge absent from its registry's index is marked `discontinued`.
   */
  async checkUpdates(): Promise<RegistryUpdate[]> {
    const installed = await this.deps.installed.all();
    const updates: RegistryUpdate[] = [];
    let persisted = false;
    for (const rec of installed) {
      let index: RegistryIndex;
      try {
        index = await this.fetchAndCache(rec.registryUrl);
      } catch {
        continue; // offline / registry unavailable — leave the record's annotations as they were
      }
      const entry = index.bridges.find((b) => b.id === rec.id);
      const discontinued = !entry;
      const availableVersion = entry && isNewer(entry.version, rec.version) ? entry.version : undefined;

      // A registry can (by operator mistake) republish different bytes at the SAME version — see
      // `assertVersionImmutable` in @comical/registry, which now guards new publishes against this.
      // A device that already pinned the earlier bytes gets a permanent SHA-256 verification failure
      // on every reload, with no version bump to ever surface as an "update available": silently
      // re-pin to the registry's current url/sha256/signature/info for this version so the next load
      // recovers instead of staying wedged forever.
      if (entry && !availableVersion && !discontinued && entry.sha256 !== rec.sha256) {
        const { availableVersion: _av, discontinued: _dc, ...base } = rec;
        await this.deps.installed.add({
          ...base,
          info: entryToInfo(entry),
          url: entry.url,
          sha256: entry.sha256,
          ...(entry.signature !== undefined ? { signature: entry.signature } : {}),
        });
        persisted = true;
        continue;
      }

      if ((rec.availableVersion ?? undefined) !== availableVersion || Boolean(rec.discontinued) !== discontinued) {
        // Rebuild off a base without the annotation fields so a no-longer-applicable one is cleared
        // (exactOptionalPropertyTypes forbids writing them back as `undefined`).
        const { availableVersion: _av, discontinued: _dc, ...base } = rec;
        await this.deps.installed.add({
          ...base,
          ...(availableVersion !== undefined ? { availableVersion } : {}),
          ...(discontinued ? { discontinued: true } : {}),
        });
        persisted = true;
      }
      if (availableVersion) {
        updates.push({ id: rec.id, installedVersion: rec.version, availableVersion });
      }
    }
    // Only when an annotation actually changed: let the embedder drop cached bridge state and refetch
    // its screens (same path as install/uninstall). This is what makes a background update check —
    // run off the bridge-list critical path (see EmbeddedBridgeProvider.list) — surface a newly
    // detected update/discontinuation badge without the user re-navigating.
    if (persisted) this.onChange?.();
    return updates;
  }

  // ── Trackers (mirrors the bridge methods above 1:1) ─────────────────────────────

  async browseTrackers(rawUrl: string): Promise<AvailableTracker[]> {
    const url = resolveRegistryUrl(rawUrl);
    const index = await this.fetchAndCache(url);
    const installed = await this.deps.installedTrackers.all();
    const map = new Map(installed.map((t) => [t.id, t]));
    return (index.trackers ?? []).map((entry) => {
      const local = map.get(entry.id);
      return {
        entry,
        registryUrl: url,
        installedVersion: local?.version ?? null,
        updateAvailable: !!local && isNewer(entry.version, local.version),
      };
    });
  }

  async browseAllTrackers(): Promise<AvailableTracker[]> {
    const registries = await this.list();
    const out: AvailableTracker[] = [];
    for (const reg of registries) {
      try {
        out.push(...(await this.browseTrackers(reg.url)));
      } catch {
        // A failing registry doesn't block the others.
      }
    }
    return out;
  }

  async installTracker(registryUrl: string, trackerId: string): Promise<InstallResult> {
    const url = resolveRegistryUrl(registryUrl);
    const index = await this.fetchAndCache(url);
    const entry = (index.trackers ?? []).find((t) => t.id === trackerId);
    if (!entry) throw new Error(`tracker "${trackerId}" not found in registry ${url}`);

    const record: InstalledTrackerRecord = {
      id: entry.id,
      registryUrl: url,
      version: entry.version,
      contractVersion: entry.contractVersion,
      info: entryToTrackerInfo(entry),
      url: entry.url,
      sha256: entry.sha256,
      ...(entry.signature !== undefined ? { signature: entry.signature } : {}),
      ...(index.publicKey !== undefined ? { publicKey: index.publicKey } : {}),
    };
    await this.deps.installedTrackers.add(record); // upsert — installing over an existing version re-pins it
    this.onChange?.();
    return { id: entry.id, version: entry.version, bundlePath: "" };
  }

  async updateTracker(trackerId: string): Promise<InstallResult> {
    const current = await this.deps.installedTrackers.get(trackerId);
    if (!current) throw new Error(`tracker "${trackerId}" is not installed`);
    this.indexCache.delete(current.registryUrl); // force a refetch so a just-published version is seen
    return this.installTracker(current.registryUrl, trackerId);
  }

  async uninstallTracker(trackerId: string): Promise<void> {
    await this.deps.installedTrackers.remove(trackerId);
    this.onChange?.();
  }

  /** Tracker equivalent of `checkUpdates` — see its doc comment for the full rationale. */
  async checkTrackerUpdates(): Promise<RegistryUpdate[]> {
    const installed = await this.deps.installedTrackers.all();
    const updates: RegistryUpdate[] = [];
    let persisted = false;
    for (const rec of installed) {
      let index: RegistryIndex;
      try {
        index = await this.fetchAndCache(rec.registryUrl);
      } catch {
        continue; // offline / registry unavailable — leave the record's annotations as they were
      }
      const entry = (index.trackers ?? []).find((t) => t.id === rec.id);
      const discontinued = !entry;
      const availableVersion = entry && isNewer(entry.version, rec.version) ? entry.version : undefined;

      // Same same-version-hash-drift self-heal as checkUpdates — see its comment for the incident.
      if (entry && !availableVersion && !discontinued && entry.sha256 !== rec.sha256) {
        const { availableVersion: _av, discontinued: _dc, ...base } = rec;
        await this.deps.installedTrackers.add({
          ...base,
          info: entryToTrackerInfo(entry),
          url: entry.url,
          sha256: entry.sha256,
          ...(entry.signature !== undefined ? { signature: entry.signature } : {}),
        });
        persisted = true;
        continue;
      }

      if ((rec.availableVersion ?? undefined) !== availableVersion || Boolean(rec.discontinued) !== discontinued) {
        const { availableVersion: _av, discontinued: _dc, ...base } = rec;
        await this.deps.installedTrackers.add({
          ...base,
          ...(availableVersion !== undefined ? { availableVersion } : {}),
          ...(discontinued ? { discontinued: true } : {}),
        });
        persisted = true;
      }
      if (availableVersion) {
        updates.push({ id: rec.id, installedVersion: rec.version, availableVersion });
      }
    }
    if (persisted) this.onChange?.();
    return updates;
  }
}

/** Semver-style "is a newer than b?" — compares major.minor.patch numerically (mirrors manager.ts). */
function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const [aMaj = 0, aMin = 0, aPat = 0] = parse(a);
  const [bMaj = 0, bMin = 0, bPat = 0] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}
