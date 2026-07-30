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
import { assertContractCompatible, isEntryCompatible } from "@comical/registry/compat";
import { assertInstallableFrom } from "@comical/registry/conflicts";
import { MAX_MOVE_HOPS, MoveError, assertSameRegistry, hasKeyContinuity } from "@comical/registry/moves";
import type { RegistryBridgeEntry, RegistryIndex, RegistryTrackerEntry, SavedRegistry } from "@comical/registry/schema";
import { registryDisplayName, resolveRegistryUrl } from "@comical/registry/url";
import { publicKeyFingerprint } from "@comical/registry/verify";
import type { RegistryProvider, RegistryUpdate } from "@comical/host-server/registry-provider";
import { entryToInfo, entryToTrackerInfo, type RegistryFetcher } from "./registry-bundle-source.ts";
import type {
  InstalledBridgeRecord,
  InstalledStore,
  InstalledTrackerRecord,
  InstalledTrackerStore,
  SavedRegistryStore,
} from "./types.ts";

/** An index fetch after following any `movedTo` pointers. */
interface ResolvedIndex {
  /** The URL the index was ultimately read from — the canonical one after a followed move. */
  url: string;
  index: RegistryIndex;
  /** True when a move was claimed but held for user confirmation, so `index` may be a stub. */
  pendingMove?: boolean;
}

export interface EmbeddedRegistryProviderDeps {
  registries: SavedRegistryStore;
  installed: InstalledStore;
  installedTrackers: InstalledTrackerStore;
  fetcher: RegistryFetcher;
}

export class EmbeddedRegistryProvider implements RegistryProvider {
  /** Per-session index memo (mirrors `RegistryManager.fetchAndCache`); cleared per-url on update. */
  private readonly indexCache = new Map<string, RegistryIndex>();
  /** In-flight `fetchAndCache(url)` calls, keyed by url — de-dupes concurrent callers (bridge list +
   *  tracker list + the background update check can all miss a cold cache for the same registry at
   *  once) so they share one network fetch instead of each firing their own. */
  private readonly fetching = new Map<string, Promise<RegistryIndex>>();

  /**
   * Fired after any install/update/uninstall so the embedder can tear down cached bridge state and
   * refetch data screens. Set by the runtime wiring (see `install.ts`); a bare provider is inert.
   */
  onChange?: () => void;

  constructor(private readonly deps: EmbeddedRegistryProviderDeps) {}

  private async fetchAndCache(url: string): Promise<RegistryIndex> {
    const cached = this.indexCache.get(url);
    if (cached) return cached;

    const inFlight = this.fetching.get(url);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const index = await this.deps.fetcher.fetchIndex(url);
      this.indexCache.set(url, index);
      await this.reconcileDisplayName(url, index);
      return index;
    })();
    this.fetching.set(url, promise);
    try {
      return await promise;
    } finally {
      if (this.fetching.get(url) === promise) this.fetching.delete(url);
    }
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
    // Validate it's reachable + a well-formed index before saving, and capture the operator's label.
    // A `movedTo` here is asserted by the host the user just chose to trust, so it's followed —
    // adding a moved registry lands you at the registry, not at its forwarding note.
    const { url, index } = await this.resolveIndex(resolveRegistryUrl(rawUrl), { trustMove: true });
    const fingerprint = index.publicKey ? await publicKeyFingerprint(index.publicKey) : undefined;
    const registry: SavedRegistry = {
      url,
      name: registryDisplayName(url),
      lastFetched: new Date().toISOString(),
      requireSignature: opts.requireSignature ?? false,
      // Pinning the key at add time is what later lets a `movedTo`/`movedFrom` claim be verified as
      // coming from the same operator instead of needing the user to vouch for it.
      ...(fingerprint ? { publicKeyFingerprint: fingerprint } : {}),
      ...(index.displayName ? { displayName: index.displayName } : {}),
    };
    await this.deps.registries.add(registry);
    // Only now that it's saved can predecessor claims be matched against the user's other registries.
    await this.adoptPredecessors(url, index);
    return (await this.deps.registries.get(url)) ?? registry;
  }

  async remove(rawUrl: string): Promise<void> {
    const url = resolveRegistryUrl(rawUrl);
    await this.deps.registries.remove(url);
    this.indexCache.delete(url);
    // Installed bridges from this registry stay in the manifest (pinned) and keep working.
  }

  // ── Browsing ──────────────────────────────────────────────────────────────────

  async browse(rawUrl: string): Promise<AvailableBridge[]> {
    const { url, index } = await this.resolveIndex(resolveRegistryUrl(rawUrl));
    const installed = await this.deps.installed.all();
    const map = new Map(installed.map((b) => [b.id, b]));
    return index.bridges.map((entry) => {
      const local = map.get(entry.id);
      const compatible = isEntryCompatible(entry.contractVersion);
      return {
        entry,
        registryUrl: url,
        installedVersion: local?.version ?? null,
        updateAvailable: compatible && !!local && isNewer(entry.version, local.version),
        compatible,
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
    const { url, index } = await this.resolveIndex(resolveRegistryUrl(registryUrl));
    const entry = index.bridges.find((b) => b.id === bridgeId);
    if (!entry) throw new Error(`bridge "${bridgeId}" not found in registry ${url}`);
    assertInstallableFrom("bridge", bridgeId, url, await this.deps.installed.get(bridgeId));
    assertContractCompatible("bridge", bridgeId, entry.contractVersion);

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
        const resolved = await this.resolveIndex(rec.registryUrl);
        // A held move means this index is a forwarding note, possibly an empty stub. Evaluating
        // against it would mark every bridge from this registry `discontinued` — the exact scare
        // a planned migration is supposed to avoid.
        if (resolved.pendingMove) continue;
        index = resolved.index;
      } catch {
        continue; // offline / registry unavailable — leave the record's annotations as they were
      }
      const entry = index.bridges.find((b) => b.id === rec.id);
      const discontinued = !entry;
      // `hasNewer` and `availableVersion` differ on exactly one case: a newer version this build
      // can't load. It isn't offered — taking it would swap a working bridge for one the loader
      // refuses — but it must still count as "newer" below, or the hash-drift self-heal would read
      // it as a same-version republish and re-pin the record onto the unloadable bundle.
      const hasNewer = !!entry && isNewer(entry.version, rec.version);
      const availableVersion =
        hasNewer && isEntryCompatible(entry!.contractVersion) ? entry!.version : undefined;

      // A registry can (by operator mistake) republish different bytes at the SAME version — see
      // `assertVersionImmutable` in @comical/registry, which now guards new publishes against this.
      // A device that already pinned the earlier bytes gets a permanent SHA-256 verification failure
      // on every reload, with no version bump to ever surface as an "update available": silently
      // re-pin to the registry's current url/sha256/signature/info for this version so the next load
      // recovers instead of staying wedged forever.
      if (entry && !hasNewer && !discontinued && entry.sha256 !== rec.sha256) {
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
    const { url, index } = await this.resolveIndex(resolveRegistryUrl(rawUrl));
    const installed = await this.deps.installedTrackers.all();
    const map = new Map(installed.map((t) => [t.id, t]));
    return (index.trackers ?? []).map((entry) => {
      const local = map.get(entry.id);
      const compatible = isEntryCompatible(entry.contractVersion);
      return {
        entry,
        registryUrl: url,
        installedVersion: local?.version ?? null,
        updateAvailable: compatible && !!local && isNewer(entry.version, local.version),
        compatible,
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
    const { url, index } = await this.resolveIndex(resolveRegistryUrl(registryUrl));
    const entry = (index.trackers ?? []).find((t) => t.id === trackerId);
    if (!entry) throw new Error(`tracker "${trackerId}" not found in registry ${url}`);
    assertInstallableFrom("tracker", trackerId, url, await this.deps.installedTrackers.get(trackerId));
    assertContractCompatible("tracker", trackerId, entry.contractVersion);

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
        const resolved = await this.resolveIndex(rec.registryUrl);
        if (resolved.pendingMove) continue; // see checkUpdates
        index = resolved.index;
      } catch {
        continue; // offline / registry unavailable — leave the record's annotations as they were
      }
      const entry = (index.trackers ?? []).find((t) => t.id === rec.id);
      const discontinued = !entry;
      // See checkUpdates for why an incompatible newer version still counts as `hasNewer`.
      const hasNewer = !!entry && isNewer(entry.version, rec.version);
      const availableVersion =
        hasNewer && isEntryCompatible(entry!.contractVersion) ? entry!.version : undefined;

      // Same same-version-hash-drift self-heal as checkUpdates — see its comment for the incident.
      if (entry && !hasNewer && !discontinued && entry.sha256 !== rec.sha256) {
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

  // ── Moves / migration (mirrors RegistryManager's; see @comical/registry/moves) ───

  /**
   * Confirm a `movedTo` that couldn't be verified by key continuity — the user's explicit "yes, this
   * is the same registry". Rebinds the saved registry and everything installed from it.
   */
  async confirmMove(rawUrl: string): Promise<string> {
    const url = resolveRegistryUrl(rawUrl);
    const saved = await this.deps.registries.get(url);
    const target = saved?.pendingMove;
    if (!target) throw new MoveError(`registry ${url} has no pending move to confirm`);
    const index = await this.fetchAndCache(target);
    await this.assertSameRegistry(url, target, index);
    await this.rebind(url, target, index);
    return target;
  }

  /** Drop an unverified move claim without following it. */
  async dismissMove(rawUrl: string): Promise<void> {
    const url = resolveRegistryUrl(rawUrl);
    const saved = await this.deps.registries.get(url);
    if (!saved?.pendingMove) return;
    const { pendingMove: _pm, ...rest } = saved;
    await this.deps.registries.add(rest);
  }

  /**
   * Confirm one unverified `movedFrom` adoption: `oldRawUrl`'s installs become `newRawUrl`'s.
   * Only offered for URLs the new registry actually named, so a stale prompt can't be replayed.
   */
  async confirmAdoption(newRawUrl: string, oldRawUrl: string): Promise<void> {
    const newUrl = resolveRegistryUrl(newRawUrl);
    const oldUrl = resolveRegistryUrl(oldRawUrl);
    const saved = await this.deps.registries.get(newUrl);
    if (!saved?.pendingAdoption?.includes(oldUrl)) {
      throw new MoveError(`registry ${newUrl} does not claim ${oldUrl} as a predecessor`);
    }
    const index = await this.fetchAndCache(newUrl);
    await this.assertSameRegistry(oldUrl, newUrl, index);
    await this.rebind(oldUrl, newUrl, index);
    // `rebind` cleared the flags on the row it moved; re-record any remaining candidates.
    await this.setPendingAdoption(newUrl, saved.pendingAdoption.filter((u) => u !== oldUrl));
  }

  /** `assertSameRegistry` over the ids installed from `oldUrl`. */
  private async assertSameRegistry(oldUrl: string, newUrl: string, index: RegistryIndex): Promise<void> {
    const installedIds = [
      ...(await this.deps.installed.all()).filter((b) => b.registryUrl === oldUrl).map((b) => b.id),
      ...(await this.deps.installedTrackers.all()).filter((t) => t.registryUrl === oldUrl).map((t) => t.id),
    ];
    assertSameRegistry(oldUrl, newUrl, installedIds, index);
  }

  /**
   * Repoint a saved registry — and every bridge/tracker installed from it — at `newUrl`.
   *
   * The server writes one manifest file, so its rebind is atomic. Here the saved-registry list and
   * the two installed manifests are separate AsyncStorage documents, so the *order* is the safety
   * property: the new registry row lands first, then the installs move, then the old row goes. An
   * interrupt at any point leaves both URLs saved with installs on one side or the other — never an
   * install pointing at a registry that isn't in the list.
   *
   * Device-only wrinkle: each record pins the *absolute bundle URL* it was installed from, on the
   * old host — which may be exactly what stopped serving. Where the target index offers the same id
   * at the same sha256, the pin is refreshed to the new host: identical bytes by definition, so
   * nothing about what's installed changes, but a later cache miss can still re-download.
   */
  private async rebind(oldUrl: string, newUrl: string, index: RegistryIndex): Promise<void> {
    if (oldUrl === newUrl) return;
    const existing = await this.deps.registries.get(oldUrl);
    if (!existing) return;

    const { pendingMove: _pm, pendingAdoption: _pa, ...base } = existing;
    await this.deps.registries.add({ ...base, url: newUrl, name: registryDisplayName(newUrl) });

    for (const rec of await this.deps.installed.all()) {
      if (rec.registryUrl !== oldUrl) continue;
      const entry = index.bridges.find((b) => b.id === rec.id && b.sha256 === rec.sha256);
      await this.deps.installed.add({ ...repin(rec, entry, index), registryUrl: newUrl });
    }
    for (const rec of await this.deps.installedTrackers.all()) {
      if (rec.registryUrl !== oldUrl) continue;
      const entry = (index.trackers ?? []).find((t) => t.id === rec.id && t.sha256 === rec.sha256);
      await this.deps.installedTrackers.add({ ...repin(rec, entry, index), registryUrl: newUrl });
    }

    await this.deps.registries.remove(oldUrl);
    this.indexCache.delete(oldUrl);
    this.onChange?.();
  }

  /** Record (or clear, with an empty list) the unverified `movedFrom` claims a registry makes. */
  private async setPendingAdoption(url: string, candidates: string[]): Promise<void> {
    const saved = await this.deps.registries.get(url);
    if (!saved) return;
    const next = candidates.length ? candidates : undefined;
    if (JSON.stringify(saved.pendingAdoption ?? undefined) === JSON.stringify(next)) return;
    const { pendingAdoption: _pa, ...base } = saved;
    await this.deps.registries.add(next ? { ...base, pendingAdoption: next } : base);
  }

  /** Record an unverified `movedTo` claim for the UI to surface as a one-tap confirm. */
  private async setPendingMove(url: string, target: string): Promise<void> {
    const saved = await this.deps.registries.get(url);
    if (!saved || saved.pendingMove === target) return;
    await this.deps.registries.add({ ...saved, pendingMove: target });
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

      const trusted = opts.trustMove || (await this.keyContinuity(url, index));
      if (!trusted) {
        await this.setPendingMove(url, target);
        return { url, index, pendingMove: true };
      }

      const next = await this.fetchAndCache(target);
      await this.assertSameRegistry(url, target, next);
      await this.rebind(url, target, next);
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
      if (!(await this.deps.registries.get(oldUrl))) continue; // not one of ours — ignore
      try {
        await this.assertSameRegistry(oldUrl, newUrl, index);
      } catch {
        continue; // shares no installed ids — not a successor, don't even offer it
      }
      if (await this.keyContinuity(oldUrl, index)) await this.rebind(oldUrl, newUrl, index);
      else pending.push(oldUrl);
    }
    await this.setPendingAdoption(newUrl, pending);
  }

  /** True when `index` is signed by the same key already pinned for `url`. */
  private async keyContinuity(url: string, index: RegistryIndex): Promise<boolean> {
    const saved = await this.deps.registries.get(url);
    return hasKeyContinuity(saved?.publicKeyFingerprint, index);
  }
}

/**
 * Refresh a record's pinned bundle location from `entry` (already matched on id **and** sha256, so
 * the bytes are identical). Signature and key are replaced wholesale — a successor may have re-signed
 * the same hash with a different key, and an unsigned successor must clear both rather than leave a
 * signature with nothing to check it against.
 */
function repin<T extends { url: string; signature?: string; publicKey?: string }>(
  rec: T,
  entry: RegistryBridgeEntry | RegistryTrackerEntry | undefined,
  index: RegistryIndex,
): T {
  if (!entry) return rec;
  const { signature: _sig, publicKey: _pk, ...base } = rec;
  return {
    ...base,
    url: entry.url,
    ...(entry.signature !== undefined ? { signature: entry.signature } : {}),
    ...(index.publicKey !== undefined ? { publicKey: index.publicKey } : {}),
  } as T;
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
