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
import { DownloadEngine, Downloads } from "@comical/downloads";
import { Library } from "@comical/library";
import { ComicalRuntime } from "@comical/runtime";
import { getNativeBridgeRuntime } from "./native-runtime.ts";
import { EmbeddedBridgeProvider } from "./provider.ts";
import { EmbeddedRegistryProvider } from "./registry-provider.ts";
import { ManifestBundleSource } from "./registry-bundle-source.ts";
import type { BundleCache, RegistryFetcher } from "./registry-bundle-source.ts";
import { createEmbeddedTransport, type EmbeddedLibrary } from "./transport.ts";
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
  /** Optional on-device library persistence (AsyncStorage-backed in an app). When supplied, the
   *  reused router also mounts the `/library*` endpoints so the app's Library/History/Activity work
   *  on-device — omit it and those endpoints simply 404 (the app shows a "needs a library" state). */
  libraryStore?: LibraryStore;
  /** Optional on-device downloads persistence (AsyncStorage-backed in an app). When supplied, the
   *  reused router also mounts the `/downloads*` endpoints so the app's offline-download manifest works
   *  on-device — omit it and those endpoints simply 404. This store persists only the manifest. */
  downloadsStore?: DownloadsStore;
  /** Optional device seams for the embedded download engine (blob store, page fetcher, policy gate).
   *  When supplied alongside `downloadsStore`, the engine runs in-process behind the router — the
   *  router's downloads routes go host-managed (pages-less enqueue, engine-delegated pause/resume,
   *  host-side blob deletion) and the app observes progress via `getEmbeddedDownloadEngine()`. */
  downloadsEngine?: EmbeddedDownloadsEngineConfig;
  /** Optional device seams for guaranteed-offline library covers (a covers-rooted blob store with
   *  `read`, plus the page fetcher). Supplied alongside `libraryStore`; the reused router captures
   *  covers on library-add/browse and serves them at `/library/entries/:b/:s/cover`. */
  covers?: EmbeddedCoversConfig;
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
let activeEngine: DownloadEngine | null = null;

/**
 * The in-process download engine while the embedded transport is active, else `null`. The app
 * subscribes to it for live progress (embedded mode never streams `/downloads/events` — the
 * buffering in-process transport can't) and drives boot-resume/backgrounding via `kick()`/`stop()`.
 */
export function getEmbeddedDownloadEngine(): DownloadEngine | null {
  return activeEngine;
}

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

  // When a library store is supplied, build the same Library + ComicalRuntime the standalone server
  // wires (host-server/server.ts) — but over the app's on-device store — so the reused router mounts
  // the `/library*` endpoints in-process. `ComicalRuntime`'s bridge provider is just `{ get(id) }`,
  // which `EmbeddedBridgeProvider` already satisfies (it's the same object driving the router).
  let embeddedLibrary: EmbeddedLibrary | undefined;
  if (config.libraryStore) {
    const library = new Library(config.libraryStore);
    const runtime = new ComicalRuntime({ bridges: bridgeProvider, library });
    embeddedLibrary = { library, runtime };
  }

  // Same for downloads: when an on-device store is supplied, build the Downloads service so the reused
  // router mounts `/downloads*` in-process. With engine seams too, build the DownloadEngine over the
  // app's blob store / page fetcher, so the router's downloads routes go host-managed exactly like the
  // standalone server's — one behavior on every host.
  const embeddedDownloads = config.downloadsStore ? new Downloads(config.downloadsStore) : undefined;
  const embeddedEngine =
    embeddedDownloads && config.downloadsEngine
      ? new DownloadEngine({ downloads: embeddedDownloads, ...config.downloadsEngine })
      : undefined;

  provider = bridgeProvider;
  activeSetTransport = config.setTransport;
  activeEngine = embeddedEngine ?? null;
  config.setTransport(
    createEmbeddedTransport(
      bridgeProvider,
      config.createRouter,
      registry,
      embeddedLibrary,
      embeddedDownloads,
      embeddedEngine,
      embeddedLibrary ? config.covers : undefined, // covers only make sense with a library
    ),
  );
  return true;
}

/** Restore the remote transport and tear down native bridge contexts. */
export function uninstallEmbeddedTransport(): void {
  provider?.refresh();
  provider = null;
  activeEngine?.stop();
  activeEngine = null;
  activeSetTransport?.(null);
}
