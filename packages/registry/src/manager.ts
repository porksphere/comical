/**
 * RegistryManager — the central M4 coordinator.
 *
 * Owns the full lifecycle:
 *   - add / remove / list registries
 *   - browse bridges available in a registry
 *   - install a bridge (download → verify → cache → manifest)
 *   - check for available updates (manual policy: expose info, never auto-install)
 *   - uninstall / block orphaned bridges
 *
 * "Orphaned" = installed from a registry that has since been removed. Orphaned bridges
 * are recorded in the manifest but their bundles are marked unloadable. The caller
 * (host-server BridgeManager) checks isOrphaned() before loading.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { downloadBundle, fetchIndex } from "./fetcher.ts";
import { ManifestStore } from "./manifest.ts";
import type { InstalledBridge, InstalledTracker, RegistryIndex, SavedRegistry } from "./schema.ts";
import { resolveRegistryUrl, registryDisplayName } from "./url.ts";
import { publicKeyFingerprint } from "./verify.ts";
// Install-status view types live in a Node-free module so the host-server router can name them
// without importing this Node-bound manager. Re-exported here to preserve the barrel surface.
import type { AvailableBridge, AvailableTracker, InstallResult } from "./available.ts";
export type { AvailableBridge, AvailableTracker, InstallResult } from "./available.ts";

export interface RegistryManagerOptions {
  /** Directory where bridge bundles are cached (separate from local dev bridges/). */
  cacheDir: string;
  manifest: ManifestStore;
}

export class RegistryManager {
  private readonly cache = new Map<string, RegistryIndex>();

  constructor(private readonly opts: RegistryManagerOptions) {}

  // ── Registries ──────────────────────────────────────────────────────────────

  async add(rawUrl: string, opts: { requireSignature?: boolean } = {}): Promise<SavedRegistry> {
    const url = resolveRegistryUrl(rawUrl);
    const index = await this.fetchAndCache(url);

    const fingerprint = index.publicKey
      ? await publicKeyFingerprint(index.publicKey)
      : undefined;

    const registry: SavedRegistry = {
      url,
      name: registryDisplayName(url),
      lastFetched: new Date().toISOString(),
      requireSignature: opts.requireSignature ?? false,
      ...(fingerprint ? { publicKeyFingerprint: fingerprint } : {}),
      ...(index.displayName ? { displayName: index.displayName } : {}),
    };

    await this.opts.manifest.addRegistry(registry);
    return registry;
  }

  async remove(rawUrl: string): Promise<void> {
    const url = resolveRegistryUrl(rawUrl);
    // Bridges from this registry become orphaned — they stay in the manifest with
    // registryUrl intact so the host can detect and block them, but they are not deleted
    // from disk (the user may re-add the registry later).
    await this.opts.manifest.removeRegistry(url);
    this.cache.delete(url);
  }

  async list(): Promise<SavedRegistry[]> {
    return this.opts.manifest.allRegistries();
  }

  // ── Browsing ────────────────────────────────────────────────────────────────

  async browse(rawUrl: string): Promise<AvailableBridge[]> {
    const url = resolveRegistryUrl(rawUrl);
    const index = await this.fetchAndCache(url);
    const installed = await this.opts.manifest.allInstalled();
    const installedMap = new Map(installed.map((b) => [b.id, b]));

    return index.bridges.map((entry) => {
      const local = installedMap.get(entry.id);
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
    const results: AvailableBridge[] = [];
    for (const reg of registries) {
      try {
        results.push(...await this.browse(reg.url));
      } catch {
        // A failing registry doesn't block others.
      }
    }
    return results;
  }

  // ── Install / update ────────────────────────────────────────────────────────

  async install(registryUrl: string, bridgeId: string): Promise<InstallResult> {
    const url = resolveRegistryUrl(registryUrl);
    const index = await this.fetchAndCache(url);
    const entry = index.bridges.find((b) => b.id === bridgeId);
    if (!entry) throw new Error(`bridge "${bridgeId}" not found in registry ${url}`);

    const registry = await this.opts.manifest.getRegistry(url);

    const downloadOpts: Parameters<typeof downloadBundle>[1] = {
      requireSignature: registry?.requireSignature ?? false,
    };
    if (index.publicKey) downloadOpts.publicKey = index.publicKey;
    const result = await downloadBundle(entry, downloadOpts);

    // Cache the bundle on disk.
    const bundlePath = join(this.opts.cacheDir, bridgeId, entry.version, "bridge.js");
    await mkdir(dirname(bundlePath), { recursive: true });
    await writeFile(bundlePath, result.text, "utf8");

    const installed: InstalledBridge = {
      id: bridgeId,
      version: entry.version,
      contractVersion: entry.contractVersion,
      registryUrl: url,
      bundlePath,
      sha256: result.sha256,
      installedAt: new Date().toISOString(),
    };
    await this.opts.manifest.addInstalled(installed);
    await this.opts.manifest.updateLastFetched(url);

    return { id: bridgeId, version: entry.version, bundlePath };
  }

  /**
   * Update a bridge to the latest version available in its source registry.
   * Manual-only — this is called explicitly by the user, never automatically.
   */
  async update(bridgeId: string): Promise<InstallResult> {
    const current = await this.opts.manifest.getInstalled(bridgeId);
    if (!current?.registryUrl) {
      throw new Error(`bridge "${bridgeId}" was not installed from a registry — cannot auto-update`);
    }
    return this.install(current.registryUrl, bridgeId);
  }

  /** Uninstall a bridge (removes from manifest; bundle file stays on disk). */
  async uninstall(bridgeId: string): Promise<void> {
    await this.opts.manifest.removeInstalled(bridgeId);
  }

  // ── Update detection (for API/UI "update available" badge) ──────────────────

  /**
   * Returns update info for all installed registry bridges.
   * Does NOT install anything — purely informational (manual update policy).
   */
  async checkUpdates(): Promise<Array<{ id: string; installedVersion: string; availableVersion: string }>> {
    const installed = await this.opts.manifest.allInstalled();
    const updates: Array<{ id: string; installedVersion: string; availableVersion: string }> = [];

    for (const bridge of installed) {
      if (!bridge.registryUrl) continue;
      try {
        const index = await this.fetchAndCache(bridge.registryUrl);
        const entry = index.bridges.find((b) => b.id === bridge.id);
        if (entry && isNewer(entry.version, bridge.version)) {
          updates.push({
            id: bridge.id,
            installedVersion: bridge.version,
            availableVersion: entry.version,
          });
        }
      } catch {
        // Offline / registry unavailable — skip silently.
      }
    }
    return updates;
  }

  // ── Orphan detection ────────────────────────────────────────────────────────

  /**
   * A bridge is orphaned if it was installed from a registry that no longer exists
   * in the user's registry list. Orphaned bridges cannot be loaded.
   */
  async isOrphaned(bridgeId: string): Promise<boolean> {
    const installed = await this.opts.manifest.getInstalled(bridgeId);
    if (!installed?.registryUrl) return false; // locally built — not orphaned
    const reg = await this.opts.manifest.getRegistry(installed.registryUrl);
    return !reg;
  }

  /** Bundle path for an installed bridge, or null if not installed / orphaned. */
  async resolveBundle(bridgeId: string): Promise<string | null> {
    if (await this.isOrphaned(bridgeId)) return null;
    const installed = await this.opts.manifest.getInstalled(bridgeId);
    return installed?.bundlePath ?? null;
  }

  // ── Tracker browsing ────────────────────────────────────────────────────────

  async browseTrackers(rawUrl: string): Promise<AvailableTracker[]> {
    const url = resolveRegistryUrl(rawUrl);
    const index = await this.fetchAndCache(url);
    const installed = await this.opts.manifest.allInstalledTrackers();
    const installedMap = new Map(installed.map((t) => [t.id, t]));

    return (index.trackers ?? []).map((entry) => {
      const local = installedMap.get(entry.id);
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
    const results: AvailableTracker[] = [];
    for (const reg of registries) {
      try {
        results.push(...await this.browseTrackers(reg.url));
      } catch { /* skip failing registries */ }
    }
    return results;
  }

  // ── Tracker install / update / uninstall ────────────────────────────────────

  async installTracker(registryUrl: string, trackerId: string): Promise<InstallResult> {
    const url = resolveRegistryUrl(registryUrl);
    const index = await this.fetchAndCache(url);
    const entry = (index.trackers ?? []).find((t) => t.id === trackerId);
    if (!entry) throw new Error(`tracker "${trackerId}" not found in registry ${url}`);

    const registry = await this.opts.manifest.getRegistry(url);
    const dlOpts: Parameters<typeof downloadBundle>[1] = {
      requireSignature: registry?.requireSignature ?? false,
    };
    if (index.publicKey) dlOpts.publicKey = index.publicKey;
    const result = await downloadBundle(entry, dlOpts);

    const bundlePath = join(this.opts.cacheDir, "trackers", trackerId, entry.version, "tracker.js");
    await mkdir(dirname(bundlePath), { recursive: true });
    await writeFile(bundlePath, result.text, "utf8");

    const installed: InstalledTracker = {
      id: trackerId,
      version: entry.version,
      contractVersion: entry.contractVersion,
      registryUrl: url,
      bundlePath,
      sha256: result.sha256,
      installedAt: new Date().toISOString(),
    };
    await this.opts.manifest.addInstalledTracker(installed);
    await this.opts.manifest.updateLastFetched(url);

    return { id: trackerId, version: entry.version, bundlePath };
  }

  async updateTracker(trackerId: string): Promise<InstallResult> {
    const current = await this.opts.manifest.getInstalledTracker(trackerId);
    if (!current?.registryUrl) {
      throw new Error(`tracker "${trackerId}" was not installed from a registry — cannot auto-update`);
    }
    return this.installTracker(current.registryUrl, trackerId);
  }

  async uninstallTracker(trackerId: string): Promise<void> {
    await this.opts.manifest.removeInstalledTracker(trackerId);
  }

  // ── Tracker update detection ─────────────────────────────────────────────────

  async checkTrackerUpdates(): Promise<Array<{ id: string; installedVersion: string; availableVersion: string }>> {
    const installed = await this.opts.manifest.allInstalledTrackers();
    const updates: Array<{ id: string; installedVersion: string; availableVersion: string }> = [];
    for (const tracker of installed) {
      if (!tracker.registryUrl) continue;
      try {
        const index = await this.fetchAndCache(tracker.registryUrl);
        const entry = (index.trackers ?? []).find((t) => t.id === tracker.id);
        if (entry && isNewer(entry.version, tracker.version)) {
          updates.push({ id: tracker.id, installedVersion: tracker.version, availableVersion: entry.version });
        }
      } catch { /* offline */ }
    }
    return updates;
  }

  async isTrackerOrphaned(trackerId: string): Promise<boolean> {
    const installed = await this.opts.manifest.getInstalledTracker(trackerId);
    if (!installed?.registryUrl) return false;
    const reg = await this.opts.manifest.getRegistry(installed.registryUrl);
    return !reg;
  }

  async resolveTrackerBundle(trackerId: string): Promise<string | null> {
    if (await this.isTrackerOrphaned(trackerId)) return null;
    const installed = await this.opts.manifest.getInstalledTracker(trackerId);
    return installed?.bundlePath ?? null;
  }

  async allInstalledTrackers() {
    return this.opts.manifest.allInstalledTrackers();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async fetchAndCache(url: string): Promise<RegistryIndex> {
    const cached = this.cache.get(url);
    if (cached) return cached;
    const index = await fetchIndex(url);
    this.cache.set(url, index);
    return index;
  }
}

/** Semver-style "is a newer than b?" — compares major.minor.patch numerically. */
function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const [aMaj = 0, aMin = 0, aPat = 0] = parse(a);
  const [bMaj = 0, bMin = 0, bPat = 0] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}
