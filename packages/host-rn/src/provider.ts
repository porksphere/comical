/**
 * The in-process `BridgeProvider` an embedder hands to `@comical/host-server`'s `createRouter`.
 *
 * `get(id)` lazily loads a bridge bundle into the native engine (`initBridge`) — resolving its code
 * from the `BundleSource`, its user settings from the `SettingsStore` — then returns a proxy bridge
 * whose methods marshal back to that native context. On load it also captures the bridge's setting
 * descriptors (via `getSettings`, when advertised), so `missingRequired`/`list` report `configured`
 * faithfully — mirroring how the server's BridgeManager loads a bridge to build its summary. Loaded
 * proxies + descriptors are cached; a settings change or uninstall drops the cache (and the native
 * context) via `invalidate`/`refresh`.
 *
 * `missingRequired` mirrors `@comical/core`'s `resolveSettings` (a required descriptor with neither a
 * stored value nor a default is missing) so the router's "not configured" gate behaves identically.
 */
import type { SettingDescriptor, SettingValue } from "@comical/contract";
import type { LoadedBridge } from "@comical/core/loader";
import { methodsForBridge } from "./capabilities.ts";
import { buildProxyBridge } from "./proxy-bridge.ts";
import type {
  BridgeProvider,
  BridgeSummary,
  BundleSource,
  InitResult,
  InstalledBridge,
  NativeBridgeRuntime,
  SettingsStore,
} from "./types.ts";

/** Required descriptor keys with neither a stored value nor a default — matches resolveSettings. */
export function missingRequiredFor(
  descriptors: readonly SettingDescriptor[],
  stored: Record<string, SettingValue>,
): string[] {
  const missing: string[] = [];
  for (const d of descriptors) {
    const supplied = stored[d.key];
    if (supplied !== undefined && supplied !== "") continue;
    const hasDefault = "default" in d && d.default !== undefined;
    if (!hasDefault && d.required) missing.push(d.key);
  }
  return missing;
}

export interface EmbeddedProviderDeps {
  native: NativeBridgeRuntime;
  bundles: BundleSource;
  settings: SettingsStore;
  /** Optional GatedNetworkOptions overrides forwarded to loadBridge (rate limits, etc.). */
  networkJson?: string;
  /**
   * Best-effort refresh of the installed bridges' update/discontinuation annotations, run at the
   * start of `list()` — mirrors how the server's `BridgeManager.list()` consults
   * `registry.checkUpdates()`. Wired to `EmbeddedRegistryProvider.checkUpdates`; errors are swallowed
   * so an offline registry never breaks the bridge list.
   */
  refreshUpdates?: () => Promise<void>;
}

interface LoadedEntry {
  bridge: LoadedBridge;
  descriptors: SettingDescriptor[];
}

export class EmbeddedBridgeProvider implements BridgeProvider {
  private readonly loaded = new Map<string, LoadedEntry>();
  private readonly installedCache = new Map<string, InstalledBridge>();

  constructor(private readonly deps: EmbeddedProviderDeps) {}

  private async installedFor(id: string): Promise<InstalledBridge> {
    if (this.installedCache.size === 0) {
      for (const b of await this.deps.bundles.installed()) this.installedCache.set(b.info.id, b);
    }
    const found = this.installedCache.get(id);
    if (!found) throw new Error(`bridge not found: ${id}`);
    return found;
  }

  /** Load the bundle into the native engine, capturing its info, methods, and setting descriptors. */
  private async load(id: string): Promise<LoadedEntry> {
    const existing = this.loaded.get(id);
    if (existing) return existing;

    await this.installedFor(id); // throws "not found" for an unknown id before touching native
    const [code, stored] = await Promise.all([
      this.deps.bundles.resolveBundle(id),
      this.deps.settings.get(id),
    ]);
    const init = JSON.parse(
      await this.deps.native.initBridge(id, code, JSON.stringify(stored), this.deps.networkJson),
    ) as InitResult;
    // The native engine returns the bridge's *self-reported* info verbatim — unlike the remote path
    // it's never re-validated against the contract schema, so a bridge that omits these arrays would
    // otherwise flow all the way to the settings UI and throw "undefined is not a function" on the
    // first `.join`/`.includes`. Normalize at the boundary so every consumer sees real arrays.
    if (!Array.isArray(init.info.capabilities)) init.info.capabilities = [];
    if (!Array.isArray(init.info.languages)) init.info.languages = [];
    const methods = init.methods ?? methodsForBridge(init.info);

    let descriptors: SettingDescriptor[] = [];
    if (methods.includes("getSettings")) {
      descriptors = JSON.parse(await this.deps.native.callBridge(id, "getSettings", "[]")) as SettingDescriptor[];
    }
    const bridge = buildProxyBridge(id, init.info, descriptors, methods, this.deps.native);
    const entry: LoadedEntry = { bridge, descriptors };
    this.loaded.set(id, entry);
    return entry;
  }

  async list(): Promise<BridgeSummary[]> {
    if (this.deps.refreshUpdates) {
      try {
        await this.deps.refreshUpdates();
      } catch {
        // Update-check is a nicety; never let it break the installed-bridge list.
      }
    }
    const installed = await this.deps.bundles.installed();
    for (const b of installed) this.installedCache.set(b.info.id, b);
    return Promise.all(
      installed.map(async (b): Promise<BridgeSummary> => {
        const { descriptors } = await this.load(b.info.id);
        const missingRequired = missingRequiredFor(descriptors, await this.deps.settings.get(b.info.id));
        return {
          info: b.info,
          settings: descriptors,
          configured: missingRequired.length === 0,
          missingRequired,
          source: b.source,
          ...(b.availableVersion !== undefined ? { availableVersion: b.availableVersion } : {}),
          ...(b.discontinued ? { discontinued: true } : {}),
        };
      }),
    );
  }

  async get(id: string): Promise<LoadedBridge> {
    return (await this.load(id)).bridge;
  }

  async missingRequired(id: string): Promise<string[]> {
    const { descriptors } = await this.load(id);
    return missingRequiredFor(descriptors, await this.deps.settings.get(id));
  }

  storedSettings(id: string): Promise<Record<string, SettingValue>> {
    return this.deps.settings.get(id);
  }

  async updateSettings(
    id: string,
    values: Record<string, SettingValue>,
  ): Promise<Record<string, SettingValue>> {
    const merged = { ...(await this.deps.settings.get(id)), ...values };
    await this.deps.settings.set(id, merged);
    this.invalidate(id); // next load() reloads the native context with the new settings
    return merged;
  }

  invalidate(id: string): void {
    if (this.loaded.delete(id)) this.deps.native.disposeBridge(id);
  }

  refresh(): void {
    for (const id of this.loaded.keys()) this.deps.native.disposeBridge(id);
    this.loaded.clear();
    this.installedCache.clear();
  }
}
