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

/** A registry move that was refused because it doesn't look like the same registry. */
export class MoveError extends Error {
  override readonly name = "MoveError";
}

/** Hard cap on `movedTo` hops followed in one resolution, so a chain can't run away. */
const MAX_MOVE_HOPS = 3;

/** An index fetch after following any `movedTo` pointers. */
interface ResolvedIndex {
  /** The URL the index was ultimately read from — the canonical one after a followed move. */
  url: string;
  index: RegistryIndex;
  /** True when a move was claimed but held for user confirmation, so `index` may be a stub. */
  pendingMove?: boolean;
}

export class RegistryManager {
  private readonly cache = new Map<string, RegistryIndex>();

  constructor(private readonly opts: RegistryManagerOptions) {}

  // ── Registries ──────────────────────────────────────────────────────────────

  async add(rawUrl: string, opts: { requireSignature?: boolean } = {}): Promise<SavedRegistry> {
    // A `movedTo` here is asserted by the host the user just chose to trust, so it's followed to the
    // canonical home — adding a moved registry lands you at the registry, not at its forwarding note.
    const { url, index } = await this.resolveIndex(resolveRegistryUrl(rawUrl), { trustMove: true });

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
    // Only now that it's saved can predecessor claims be matched against the user's other registries.
    await this.adoptPredecessors(url, index);
    return (await this.opts.manifest.getRegistry(url)) ?? registry;
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
    const { url, index } = await this.resolveIndex(resolveRegistryUrl(rawUrl));
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
    const { url, index } = await this.resolveIndex(resolveRegistryUrl(registryUrl));
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
        const { index, pendingMove } = await this.resolveIndex(bridge.registryUrl);
        // A held move means this index is a forwarding note, possibly an empty stub — evaluating
        // against it would report the bridge missing rather than moved.
        if (pendingMove) continue;
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
    const { url, index } = await this.resolveIndex(resolveRegistryUrl(rawUrl));
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
    const { url, index } = await this.resolveIndex(resolveRegistryUrl(registryUrl));
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
        const { index, pendingMove } = await this.resolveIndex(tracker.registryUrl);
        if (pendingMove) continue; // see checkUpdates
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

  // ── Moves / migration ───────────────────────────────────────────────────────

  /**
   * Confirm a `movedTo` that couldn't be verified by key continuity — the user's explicit "yes,
   * this is the same registry". Rebinds the saved registry and everything installed from it.
   */
  async confirmMove(rawUrl: string): Promise<string> {
    const url = resolveRegistryUrl(rawUrl);
    const saved = await this.opts.manifest.getRegistry(url);
    const target = saved?.pendingMove;
    if (!target) throw new MoveError(`registry ${url} has no pending move to confirm`);
    const index = await this.fetchAndCache(target);
    await this.assertSameRegistry(url, target, index);
    await this.opts.manifest.rebindRegistry(url, target);
    return target;
  }

  /** Drop an unverified move claim without following it. */
  async dismissMove(rawUrl: string): Promise<void> {
    await this.opts.manifest.setPendingMove(resolveRegistryUrl(rawUrl), undefined);
  }

  /**
   * Confirm one unverified `movedFrom` adoption: `oldRawUrl`'s installs become `newRawUrl`'s.
   * Only offered for URLs the new registry actually named, so a stale prompt can't be replayed.
   */
  async confirmAdoption(newRawUrl: string, oldRawUrl: string): Promise<void> {
    const newUrl = resolveRegistryUrl(newRawUrl);
    const oldUrl = resolveRegistryUrl(oldRawUrl);
    const saved = await this.opts.manifest.getRegistry(newUrl);
    if (!saved?.pendingAdoption?.includes(oldUrl)) {
      throw new MoveError(`registry ${newUrl} does not claim ${oldUrl} as a predecessor`);
    }
    const index = await this.fetchAndCache(newUrl);
    await this.assertSameRegistry(oldUrl, newUrl, index);
    await this.opts.manifest.rebindRegistry(oldUrl, newUrl);
    // rebindRegistry cleared the flags on the row it moved; re-record any remaining candidates.
    const remaining = saved.pendingAdoption.filter((u) => u !== oldUrl);
    await this.opts.manifest.setPendingAdoption(newUrl, remaining);
  }

  /**
   * Guard against a "move" that isn't one. Bridge ids are the key for *everything* the user owns —
   * settings, credentials, library entries (`entryKey(bridgeId, seriesId)`), history — so a move must
   * preserve them. If a registry has installs and the target index shares none of their ids, this is
   * a different registry wearing the name, and rebinding would silently mark every install
   * discontinued while the "new" ones look uninstalled. A *partial* overlap is normal (a publisher
   * dropping a bridge) and allowed.
   */
  private async assertSameRegistry(oldUrl: string, newUrl: string, index: RegistryIndex): Promise<void> {
    const bridgeIds = await this.opts.manifest.bridgesFromRegistry(oldUrl);
    const trackerIds = await this.opts.manifest.trackersFromRegistry(oldUrl);
    if (bridgeIds.length === 0 && trackerIds.length === 0) return; // nothing at stake
    const offered = new Set<string>([
      ...index.bridges.map((b) => b.id),
      ...(index.trackers ?? []).map((t) => t.id),
    ]);
    const kept = [...bridgeIds, ...trackerIds].filter((id) => offered.has(id));
    if (kept.length === 0) {
      throw new MoveError(
        `refusing to move ${oldUrl} → ${newUrl}: none of the ${bridgeIds.length + trackerIds.length} ` +
          `installed id(s) appear in the target index, so this is not the same registry`,
      );
    }
  }

  /** True when `index` is signed by the same key already pinned for `url` — proof of succession. */
  private async hasKeyContinuity(url: string, index: RegistryIndex): Promise<boolean> {
    const saved = await this.opts.manifest.getRegistry(url);
    if (!saved?.publicKeyFingerprint || !index.publicKey) return false;
    return (await publicKeyFingerprint(index.publicKey)) === saved.publicKeyFingerprint;
  }

  /**
   * Fetch an index, following `movedTo` pointers.
   *
   * `trustMove` is the whole trust model in one flag. On a user-initiated add the pointer comes from
   * the very host the user just chose to trust, so it's followed. On background paths (browse,
   * install, update checks) it's followed only with key continuity — otherwise an expired domain or
   * a compromised repo could redirect every device to a hostile registry — and is otherwise parked
   * as `pendingMove` for the UI to confirm.
   */
  private async resolveIndex(startUrl: string, opts: { trustMove?: boolean } = {}): Promise<ResolvedIndex> {
    let url = startUrl;
    let index = await this.fetchAndCache(url);
    const seen = new Set<string>([url]);

    for (let hop = 0; index.movedTo && hop < MAX_MOVE_HOPS; hop++) {
      const target = resolveRegistryUrl(index.movedTo);
      if (seen.has(target)) break; // cycle (incl. self-reference) — stay put
      seen.add(target);

      const trusted = opts.trustMove || (await this.hasKeyContinuity(url, index));
      if (!trusted) {
        await this.opts.manifest.setPendingMove(url, target);
        return { url, index, pendingMove: true };
      }

      const next = await this.fetchAndCache(target);
      await this.assertSameRegistry(url, target, next);
      await this.opts.manifest.rebindRegistry(url, target);
      url = target;
      index = next;
    }
    return { url, index };
  }

  /**
   * Honour a new index's `movedFrom` claims against the user's saved registries. Verified claims
   * (same key) are adopted immediately; the rest are parked on the new registry for the UI to offer,
   * because this is an unauthenticated assertion by an arbitrary publisher — adopting it silently
   * would hand update authority over installed bridges to whoever asked loudest.
   */
  private async adoptPredecessors(newUrl: string, index: RegistryIndex): Promise<void> {
    const claims = (index.movedFrom ?? []).map(resolveRegistryUrl).filter((u) => u !== newUrl);
    if (claims.length === 0) return;

    const pending: string[] = [];
    for (const oldUrl of claims) {
      if (!(await this.opts.manifest.getRegistry(oldUrl))) continue; // not one of ours — ignore
      try {
        await this.assertSameRegistry(oldUrl, newUrl, index);
      } catch {
        continue; // shares no installed ids — not a successor, don't even offer it
      }
      if (await this.hasKeyContinuity(oldUrl, index)) await this.opts.manifest.rebindRegistry(oldUrl, newUrl);
      else pending.push(oldUrl);
    }
    await this.opts.manifest.setPendingAdoption(newUrl, pending);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async fetchAndCache(url: string): Promise<RegistryIndex> {
    const cached = this.cache.get(url);
    if (cached) return cached;
    const index = await fetchIndex(url);
    this.cache.set(url, index);
    await this.reconcileDisplayName(url, index);
    return index;
  }

  /**
   * Keep a saved registry's `displayName` in sync with its index. Called on every index fetch (the
   * single choke point every browse/install/update/checkUpdates flows through), so an operator's
   * label change propagates without the user re-adding the registry — and it costs nothing extra,
   * riding a fetch that was already happening. A no-op unless the value actually changed, and skipped
   * for a url not yet in the manifest (e.g. the fetch inside `add()`, which saves the label itself).
   */
  private async reconcileDisplayName(url: string, index: RegistryIndex): Promise<void> {
    const saved = await this.opts.manifest.getRegistry(url);
    if (!saved) return;
    if ((saved.displayName ?? undefined) === (index.displayName ?? undefined)) return;
    const next = { ...saved };
    if (index.displayName) next.displayName = index.displayName;
    else delete next.displayName; // exactOptionalPropertyTypes: clear, don't write undefined
    await this.opts.manifest.addRegistry(next); // addRegistry upserts by url
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
