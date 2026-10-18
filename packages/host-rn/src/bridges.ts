/**
 * `@comical/host-rn/bridges` — the bridges-only embedding entry.
 *
 * Same native-engine proxy provider, reused router, registry install/update, and tracker support
 * as the root entry, but with no value import of `@comical/library`, `@comical/runtime`, or
 * `@comical/downloads`: the `/library*` and `/downloads*` routes stay unmounted (404) and none of
 * that code is bundled. For an app that rolls its own library over the bridge API, this is the
 * whole surface. (`test/bridges-entry.test.ts` walks the import graph to keep it that way.)
 */
import { installEmbeddedTransportWith, type EmbeddedRuntimeConfig } from "./install-core.ts";

/** `EmbeddedRuntimeConfig` minus the options that need the product modules. */
export type EmbeddedBridgesConfig = Omit<
  EmbeddedRuntimeConfig,
  "libraryStore" | "downloadsStore" | "downloadsEngine" | "covers"
>;

/**
 * Install the embedded transport with bridges (and trackers, when configured) only.
 * @returns true if installed, false if the native runtime is unavailable (stayed remote).
 */
export function installEmbeddedBridges(config: EmbeddedBridgesConfig): boolean {
  return installEmbeddedTransportWith(config, {});
}

export { uninstallEmbeddedTransport } from "./install-core.ts";
export { installWebCryptoShim } from "./crypto-shim.ts";
export {
  getNativeBridgeRuntime,
  setNativeBridgeRuntime,
  isEmbeddedRuntimeAvailable,
  getNativeTrackerRuntime,
  setNativeTrackerRuntime,
} from "./native-runtime.ts";
export { EmbeddedBridgeProvider, missingRequiredFor } from "./provider.ts";
export type { EmbeddedProviderDeps } from "./provider.ts";
export { EmbeddedRegistryProvider } from "./registry-provider.ts";
export type { EmbeddedRegistryProviderDeps } from "./registry-provider.ts";
export { buildProxyBridge } from "./proxy-bridge.ts";
export { CAPABILITY_METHODS, methodsForBridge } from "./capabilities.ts";
export { buildProxyTracker } from "./tracker-proxy.ts";
export type { ProxyTrackerHooks } from "./tracker-proxy.ts";
export { TRACKER_CAPABILITY_METHODS, methodsForTracker } from "./tracker-capabilities.ts";
export { EmbeddedTrackerProvider } from "./tracker-provider.ts";
export type { EmbeddedTrackerProviderDeps } from "./tracker-provider.ts";
export {
  RegistryBundleSource,
  MultiRegistryBundleSource,
  ManifestBundleSource,
  ManifestTrackerBundleSource,
  MemoryBundleCache,
  entryToInfo,
  entryToTrackerInfo,
  type BundleCache,
  type BundleEntryLike,
  type RegistryBundleSourceOptions,
  type MultiRegistryBundleSourceOptions,
  type ManifestBundleSourceOptions,
  type ManifestTrackerBundleSourceOptions,
  type RegistryFetcher,
} from "./registry-bundle-source.ts";
export type {
  BridgeProvider,
  BridgeSource,
  BridgeSummary,
  BundleSource,
  CreateRouter,
  EmbeddedRouter,
  EmbeddedTransport,
  InitResult,
  InstalledBridge,
  InstalledBridgeRecord,
  InstalledStore,
  InstalledTracker,
  InstalledTrackerRecord,
  InstalledTrackerStore,
  NativeBridgeRuntime,
  NativeTrackerRuntime,
  RegistryProvider,
  RetiredStore,
  SavedRegistryStore,
  SettingsStore,
  TrackerBundleSource,
  TrackerInitResult,
  TrackerProvider,
  TrackerSummary,
} from "./types.ts";
