/**
 * Install/remove the embedded transport. The embedder supplies `setTransport` (its `api.ts`'s
 * transport setter) so this package never imports the app; passing `null` there restores the app's
 * remote transport.
 *
 * `installEmbeddedTransport` builds the whole on-device stack — the manifest-backed `BundleSource`,
 * the `EmbeddedRegistryProvider` (per-bridge install/update/uninstall over the app's AsyncStorage
 * stores), the proxy `BridgeProvider`, and the reused-router transport — and makes it active, so
 * browse/search/reader *and* registry management all resolve on-device with no external server. It's
 * a no-op when the native engine is unavailable (web, or before the native module ships), so calling
 * it unconditionally at startup is safe — the app simply stays remote.
 */
import { getNativeBridgeRuntime } from "./native-runtime.ts";
import { EmbeddedBridgeProvider } from "./provider.ts";
import { EmbeddedRegistryProvider } from "./registry-provider.ts";
import { ManifestBundleSource } from "./registry-bundle-source.ts";
import type { BundleCache, RegistryFetcher } from "./registry-bundle-source.ts";
import { createEmbeddedTransport } from "./transport.ts";
import type {
  CreateRouter,
  EmbeddedTransport,
  InstalledStore,
  SavedRegistryStore,
  SettingsStore,
} from "./types.ts";

export interface EmbeddedRuntimeConfig {
  /** `@comical/host-server`'s `createRouter` (from the built package), cast to `CreateRouter`. */
  createRouter: CreateRouter;
  /** `@comical/registry`'s `{ fetchIndex, downloadBundle }` (from the built package). */
  fetcher: RegistryFetcher;
  /** The installed-bridge manifest (AsyncStorage-backed in an app) — what `installed()` reads. */
  installed: InstalledStore;
  /** The saved-registry list (AsyncStorage-backed in an app). */
  registries: SavedRegistryStore;
  /** Per-bridge settings persistence (AsyncStorage-backed in an app). */
  settings: SettingsStore;
  /** The embedder's transport setter — passed the embedded transport (or `null` to restore remote). */
  setTransport: (transport: EmbeddedTransport | null) => void;
  /** Refuse unsigned bundles (default false — SHA-256 integrity is always enforced). */
  requireSignature?: boolean;
  /** Persistent bundle cache (defaults to in-memory). */
  cache?: BundleCache;
  /** Optional GatedNetworkOptions overrides forwarded into each bridge load. */
  networkJson?: string;
  /** Fired after an install/update/uninstall so the embedder can refetch data screens (epoch bump). */
  onRegistryChange?: () => void;
}

let provider: EmbeddedBridgeProvider | null = null;
let activeSetTransport: ((transport: EmbeddedTransport | null) => void) | null = null;

/**
 * Install the embedded transport via the supplied `setTransport`.
 * @returns true if installed, false if the native runtime is unavailable (stayed remote).
 */
export function installEmbeddedTransport(config: EmbeddedRuntimeConfig): boolean {
  const native = getNativeBridgeRuntime();
  if (!native) return false;

  const bundles = new ManifestBundleSource({
    installed: config.installed,
    fetcher: config.fetcher,
    ...(config.cache ? { cache: config.cache } : {}),
    ...(config.requireSignature !== undefined ? { requireSignature: config.requireSignature } : {}),
  });
  const registry = new EmbeddedRegistryProvider({
    registries: config.registries,
    installed: config.installed,
    fetcher: config.fetcher,
  });

  const bridgeProvider = new EmbeddedBridgeProvider({
    native,
    bundles,
    settings: config.settings,
    ...(config.networkJson !== undefined ? { networkJson: config.networkJson } : {}),
    refreshUpdates: () => registry.checkUpdates().then(() => undefined),
  });

  // An install/update/uninstall changes what's installed: drop the proxy provider's cached bridge
  // state so the next `list()`/`get()` re-reads the manifest, then let the app refetch its screens.
  registry.onChange = () => {
    bridgeProvider.refresh();
    config.onRegistryChange?.();
  };

  provider = bridgeProvider;
  activeSetTransport = config.setTransport;
  config.setTransport(createEmbeddedTransport(bridgeProvider, config.createRouter, registry));
  return true;
}

/** Restore the remote transport and tear down native bridge contexts. */
export function uninstallEmbeddedTransport(): void {
  provider?.refresh();
  provider = null;
  activeSetTransport?.(null);
}
