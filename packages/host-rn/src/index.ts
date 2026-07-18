/**
 * `@comical/host-rn` — reusable glue for embedding the Comical bridge runtime in a React Native /
 * Expo app.
 *
 * An embedder wires three things it owns — the native module (resolved and passed to
 * `setNativeBridgeRuntime`), its `api.ts` transport setter, and a `SettingsStore` — then calls
 * `configureEmbeddedRuntime` + `applyEmbeddedMode`. Everything else (the in-process proxy
 * `BridgeProvider`, the reused-router transport, the registry-download `BundleSource`, the Hermes
 * WebCrypto shim) lives here. The package is Node-free and free of `expo`/RN imports.
 */
export { installWebCryptoShim } from "./crypto-shim.ts";
export { configureEmbeddedRuntime, applyEmbeddedMode } from "./bootstrap.ts";
export type { EmbeddedBootstrapConfig } from "./bootstrap.ts";
export { getEmbeddedDownloadEngine, installEmbeddedTransport, uninstallEmbeddedTransport } from "./install.ts";
export type { EmbeddedRuntimeConfig } from "./install.ts";
export { getNativeBridgeRuntime, setNativeBridgeRuntime, isEmbeddedRuntimeAvailable } from "./native-runtime.ts";
export { EmbeddedBridgeProvider, missingRequiredFor } from "./provider.ts";
export type { EmbeddedProviderDeps } from "./provider.ts";
export { EmbeddedRegistryProvider } from "./registry-provider.ts";
export type { EmbeddedRegistryProviderDeps } from "./registry-provider.ts";
export { buildProxyBridge } from "./proxy-bridge.ts";
export { CAPABILITY_METHODS, methodsForBridge } from "./capabilities.ts";
export { createEmbeddedTransport } from "./transport.ts";
export {
  RegistryBundleSource,
  MultiRegistryBundleSource,
  ManifestBundleSource,
  MemoryBundleCache,
  entryToInfo,
  type BundleCache,
  type BundleEntryLike,
  type RegistryBundleSourceOptions,
  type MultiRegistryBundleSourceOptions,
  type ManifestBundleSourceOptions,
  type RegistryFetcher,
} from "./registry-bundle-source.ts";
export type {
  BlobStore,
  BridgeProvider,
  BridgeSource,
  BridgeSummary,
  BundleSource,
  CreateRouter,
  DownloadEngine,
  DownloadEngineEvent,
  EmbeddedCoversConfig,
  EmbeddedDownloadsEngineConfig,
  EmbeddedRouter,
  EmbeddedTransport,
  FetchedPage,
  InitResult,
  InstalledBridge,
  InstalledBridgeRecord,
  InstalledStore,
  NativeBridgeRuntime,
  PageFetcher,
  PendingPage,
  RegistryProvider,
  SavedRegistryStore,
  SettingsStore,
} from "./types.ts";
