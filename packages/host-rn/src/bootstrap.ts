/**
 * Startup wiring for the embedded runtime.
 *
 * `configureEmbeddedRuntime` is called once at app launch with the pieces that come from the built
 * comical packages — `@comical/host-server`'s `createRouter` and `@comical/registry`'s fetcher — plus
 * the app's persistence (the saved-registry list, the installed-bridge manifest, per-bridge
 * settings), the embedder's `setTransport`, and a change callback. Keeping these injected is what
 * lets this package stay free of the app and of `expo`/RN imports.
 *
 * `applyEmbeddedMode(enabled)` installs or removes the embedded transport accordingly. It's safe to
 * call before `configureEmbeddedRuntime` or when the native runtime is absent (web) — it simply
 * ensures the remote transport stays active and returns false.
 */
import { installEmbeddedTransport, uninstallEmbeddedTransport } from "./install.ts";
import { isEmbeddedRuntimeAvailable } from "./native-runtime.ts";
import type { BundleCache, RegistryFetcher } from "./registry-bundle-source.ts";
import type {
  CreateRouter,
  DownloadsStore,
  EmbeddedCoversConfig,
  EmbeddedDownloadsEngineConfig,
  EmbeddedTransport,
  InstalledStore,
  LibraryStore,
  SavedRegistryStore,
  SettingsStore,
  TrackerBundles,
} from "./types.ts";

export interface EmbeddedBootstrapConfig {
  /** `@comical/host-server`'s `createRouter` (from the built package), cast to `CreateRouter`. */
  createRouter: CreateRouter;
  /** `@comical/registry`'s `{ fetchIndex, downloadBundle }` (from the built package). */
  fetcher: RegistryFetcher;
  /** The installed-bridge manifest (AsyncStorage-backed) — only installed bridges load. */
  installed: InstalledStore;
  /** The saved-registry list (AsyncStorage-backed). */
  registries: SavedRegistryStore;
  /** The embedder's transport setter (its `api.ts`'s `setTransport`). */
  setTransport: (transport: EmbeddedTransport | null) => void;
  /** Per-bridge settings persistence (AsyncStorage-backed in an app). */
  settings: SettingsStore;
  /** Optional on-device library persistence (AsyncStorage-backed in an app). Supplying it mounts the
   *  `/library*` endpoints on the embedded router; omitting it leaves them unmounted (they 404). */
  libraryStore?: LibraryStore;
  /** Optional on-device downloads persistence (AsyncStorage-backed in an app). Supplying it mounts the
   *  `/downloads*` endpoints on the embedded router; omitting it leaves them unmounted (they 404). */
  downloadsStore?: DownloadsStore;
  /** Optional device seams (blob store, page fetcher, policy gate) for the embedded download engine.
   *  Supplying it alongside `downloadsStore` runs the engine in-process behind the router — see
   *  `getEmbeddedDownloadEngine`. */
  downloadsEngine?: EmbeddedDownloadsEngineConfig;
  /** Optional device seams for guaranteed-offline library covers (covers-rooted blob store with
   *  `read` + page fetcher). Only effective alongside `libraryStore`. */
  covers?: EmbeddedCoversConfig;
  /** Static id → bundle source code for the trackers built into the app. Supplying it alongside
   *  `trackerSettings` mounts the `/trackers*` endpoints (also needs a native tracker runtime
   *  registered — see `EmbeddedRuntimeConfig.trackerBundles`'s doc comment in install.ts). */
  trackerBundles?: TrackerBundles;
  /** Per-tracker settings persistence (AsyncStorage-backed in an app). */
  trackerSettings?: SettingsStore;
  /** The app's own custom-scheme OAuth redirect base (e.g. `comical://oauth-callback`) — see
   *  `EmbeddedRuntimeConfig.oauthCallbackUrl` in install.ts. Only meaningful alongside
   *  `trackerBundles`/`trackerSettings`; a tracker with an `oauth-callback` field simply can't
   *  connect on-device without it. */
  oauthCallbackUrl?: string;
  /** Refuse unsigned bundles (default false — SHA-256 integrity is always enforced). */
  requireSignature?: boolean;
  /** Persistent bundle cache (defaults to in-memory; an expo-file-system adapter is a follow-up). */
  cache?: BundleCache;
  networkJson?: string;
  /** Fired after an install/update/uninstall so the embedder can refetch data screens. */
  onRegistryChange?: () => void;
}

let config: EmbeddedBootstrapConfig | null = null;

/** Register the injected runtime dependencies. Call once at app launch (native entry only). */
export function configureEmbeddedRuntime(next: EmbeddedBootstrapConfig): void {
  config = next;
}

/**
 * Install the embedded transport when `enabled` (and configured + available), else restore remote.
 * @returns true if the embedded transport is now active.
 */
export function applyEmbeddedMode(enabled: boolean): boolean {
  if (!enabled || !config || !isEmbeddedRuntimeAvailable()) {
    uninstallEmbeddedTransport();
    return false;
  }
  return installEmbeddedTransport({
    createRouter: config.createRouter,
    fetcher: config.fetcher,
    installed: config.installed,
    registries: config.registries,
    settings: config.settings,
    setTransport: config.setTransport,
    ...(config.libraryStore ? { libraryStore: config.libraryStore } : {}),
    ...(config.downloadsStore ? { downloadsStore: config.downloadsStore } : {}),
    ...(config.downloadsEngine ? { downloadsEngine: config.downloadsEngine } : {}),
    ...(config.covers ? { covers: config.covers } : {}),
    ...(config.trackerBundles ? { trackerBundles: config.trackerBundles } : {}),
    ...(config.trackerSettings ? { trackerSettings: config.trackerSettings } : {}),
    ...(config.oauthCallbackUrl ? { oauthCallbackUrl: config.oauthCallbackUrl } : {}),
    ...(config.cache ? { cache: config.cache } : {}),
    ...(config.requireSignature !== undefined ? { requireSignature: config.requireSignature } : {}),
    ...(config.networkJson !== undefined ? { networkJson: config.networkJson } : {}),
    ...(config.onRegistryChange ? { onRegistryChange: config.onRegistryChange } : {}),
  });
}
