/**
 * The in-process `TrackerProvider` an embedder hands to `@comical/host-server`'s `createRouter` —
 * parallel to `provider.ts`'s `EmbeddedBridgeProvider`. Trackers are registry-installed exactly
 * like bridges (`TrackerBundleSource` — see its doc comment in `types.ts`); this class holds no
 * static bundle map.
 *
 * `get(id)` lazily loads a tracker's code into the native engine (`initTracker`) — resolving its
 * bundle from the `TrackerBundleSource`, its user settings from the `SettingsStore` — then returns
 * a proxy tracker whose methods marshal back to that native context. On load it also captures the
 * tracker's setting descriptors (via `getSettings`, when advertised), so `missingRequired`/`list`
 * report `configured` faithfully — mirroring how the server's `TrackerManager` derives the same
 * `TrackerSummary` shape. Loaded proxies + descriptors are cached; a settings change or explicit
 * `invalidate` drops the cache (and the native context) via `invalidate`/`refresh`.
 *
 * Every proxy call drains + persists a refreshed OAuth token blob (see `ProxyTrackerHooks.afterCall`
 * and `NativeTrackerRuntime.drainTrackerSettingsPatch`) — the on-device equivalent of
 * `TrackerManager.get()`'s `RefreshableNetwork` `onRefreshed` callback, just polled after the fact
 * instead of pushed mid-request, since the sandboxed native context has no other channel out.
 */
import type { SettingDescriptor, SettingValue } from "@comical/contract";
import type { LoadedTracker } from "@comical/core/tracker-loader";
import { redactSettingSecrets, resolveSettings } from "@comical/core/settings";
import { methodsForTracker } from "./tracker-capabilities.ts";
import { buildProxyTracker } from "./tracker-proxy.ts";
import type {
  NativeTrackerRuntime,
  SettingsStore,
  TrackerBundleSource,
  TrackerInitResult,
  TrackerProvider,
  TrackerSummary,
} from "./types.ts";

export interface EmbeddedTrackerProviderDeps {
  native: NativeTrackerRuntime;
  bundles: TrackerBundleSource;
  settings: SettingsStore;
  /** Optional GatedNetworkOptions overrides forwarded to loadTracker (rate limits, etc.). */
  networkJson?: string;
  /**
   * Best-effort refresh of the installed trackers' update/discontinuation annotations, run at the
   * start of `list()` — mirrors `EmbeddedProviderDeps.refreshUpdates`. Wired to
   * `EmbeddedRegistryProvider.checkTrackerUpdates`; errors are swallowed so an offline registry
   * never breaks the tracker list.
   */
  refreshUpdates?: () => Promise<void>;
}

interface LoadedEntry {
  tracker: LoadedTracker;
  descriptors: SettingDescriptor[];
}

export class EmbeddedTrackerProvider implements TrackerProvider {
  private readonly loaded = new Map<string, LoadedEntry>();
  /** In-flight background update check, so overlapping `list()` calls don't stack duplicate checks. */
  private updateCheckInFlight: Promise<void> | undefined;

  constructor(private readonly deps: EmbeddedTrackerProviderDeps) {}

  /**
   * Poll the native context for a token it refreshed since the last drain and, if present, persist
   * it into the settings store and drop the cached proxy so the NEXT load re-inits native with the
   * fresh token. The call that triggered the refresh already completed against its own live native
   * context and is unaffected by the drop.
   */
  private async drainAndPersist(id: string): Promise<void> {
    const patchJson = await this.deps.native.drainTrackerSettingsPatch(id);
    if (!patchJson) return;
    const { key, blob } = JSON.parse(patchJson) as { key: string; blob: unknown };
    const current = await this.deps.settings.get(id);
    await this.deps.settings.set(id, { ...current, [key]: JSON.stringify(blob) });
    this.loaded.delete(id);
  }

  /** Load the bundle into the native engine, capturing its info, methods, and setting descriptors. */
  private async load(id: string): Promise<LoadedEntry> {
    const existing = this.loaded.get(id);
    if (existing) return existing;

    const [code, stored] = await Promise.all([
      this.deps.bundles.resolveBundle(id),
      this.deps.settings.get(id),
    ]);

    const init = JSON.parse(
      await this.deps.native.initTracker(id, code, JSON.stringify(stored), this.deps.networkJson),
    ) as TrackerInitResult;
    // Same defensive normalization as EmbeddedBridgeProvider — native reports info verbatim, never
    // re-validated against the contract schema. Guard against a tracker that omits `capabilities`.
    if (!Array.isArray(init.info.capabilities)) init.info.capabilities = [];
    const methods = init.methods ?? methodsForTracker(init.info);

    let descriptors: SettingDescriptor[] = [];
    if (methods.includes("getSettings")) {
      descriptors = JSON.parse(await this.deps.native.callTracker(id, "getSettings", "[]")) as SettingDescriptor[];
    }
    const tracker = buildProxyTracker(id, init.info, descriptors, methods, this.deps.native, {
      afterCall: () => this.drainAndPersist(id),
    });
    const entry: LoadedEntry = { tracker, descriptors };
    this.loaded.set(id, entry);
    return entry;
  }

  /** Mirrors `TrackerManager.summarize()`: settings descriptors redacted of the OAuth exchange
   *  secret, stored values split into non-secret `values` vs. a `secretsSet` presence list. */
  private async summarize(id: string): Promise<TrackerSummary> {
    const { tracker, descriptors } = await this.load(id);
    const stored = await this.deps.settings.get(id);
    const { missingRequired } = resolveSettings(stored, descriptors);
    const secretKeys = new Set(
      descriptors
        .filter((d) => (d.type === "string" && !!d.secret) || d.type === "oauth-pin" || d.type === "oauth-callback")
        .map((d) => d.key),
    );
    const values: Record<string, SettingValue> = {};
    const secretsSet: string[] = [];
    for (const [k, v] of Object.entries(stored)) {
      if (secretKeys.has(k)) {
        if (v !== undefined && v !== "") secretsSet.push(k);
      } else {
        values[k] = v;
      }
    }
    return {
      info: tracker.info,
      settings: redactSettingSecrets(descriptors),
      values,
      secretsSet,
      configured: missingRequired.length === 0,
      missingRequired,
      // On-device every tracker comes from the registry-download bundle source (there's no
      // server-built "local" tracker here), so all are uninstallable — mirrors how
      // EmbeddedBridgeProvider forwards each installed bridge's `source`.
      source: "registry",
    };
  }

  async list(): Promise<TrackerSummary[]> {
    // Keep the (networked) update check off the list's critical path, mirroring
    // EmbeddedBridgeProvider.list() — see runUpdateCheck.
    this.runUpdateCheck();

    const results: TrackerSummary[] = [];
    for (const id of await this.deps.bundles.ids()) {
      try {
        results.push(await this.summarize(id));
      } catch {
        // A tracker bundle that fails to load (bad code, contract-version mismatch, …) is skipped —
        // mirrors TrackerManager.list()'s per-tracker try/catch.
      }
    }
    return results;
  }

  /** Run the (networked) update check off the list's critical path, at most one at a time — see
   *  EmbeddedBridgeProvider.runUpdateCheck for the full rationale. */
  private runUpdateCheck(): void {
    if (!this.deps.refreshUpdates || this.updateCheckInFlight) return;
    this.updateCheckInFlight = this.deps
      .refreshUpdates()
      .catch(() => {})
      .finally(() => {
        this.updateCheckInFlight = undefined;
      });
  }

  async get(id: string): Promise<LoadedTracker> {
    return (await this.load(id)).tracker;
  }

  async storedSettings(id: string): Promise<Record<string, SettingValue>> {
    return this.deps.settings.get(id);
  }

  async updateSettings(
    id: string,
    patch: Record<string, SettingValue>,
  ): Promise<Record<string, SettingValue>> {
    const merged = { ...(await this.deps.settings.get(id)), ...patch };
    await this.deps.settings.set(id, merged);
    this.invalidate(id); // next load() reloads the native context with the new settings
    return merged;
  }

  invalidate(id: string): void {
    if (this.loaded.delete(id)) this.deps.native.disposeTracker(id);
  }

  refresh(): void {
    for (const id of this.loaded.keys()) this.deps.native.disposeTracker(id);
    this.loaded.clear();
  }
}
