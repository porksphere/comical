/**
 * The type contract for embedding the Comical runtime in a React Native / Expo app.
 *
 * The bridge-management surface (`BridgeProvider`/`BridgeSummary`) is re-exported from the real
 * `@comical/host-server/bridge-provider` (Node-free), so an embedder's provider is checked against
 * the exact interface `createRouter` drives — no drift-prone mirror. The RN-specific seams below
 * (the native-module JSON contract, the bundle source, the in-process router adapter) are defined
 * here because they don't exist elsewhere in comical: this package is their canonical home.
 */
import type { BridgeInfo, TrackerInfo } from "@comical/contract";
import type { BlobStore, DownloadEngine, Downloads, DownloadsStore, PageFetcher, PageResolver, PendingPage } from "@comical/downloads";
import type { RegistryProvider } from "@comical/host-server/registry-provider";
import type { TrackerProvider } from "@comical/host-server/tracker-provider";
import type { Library, LibraryStore } from "@comical/library";
import type { SavedRegistry } from "@comical/registry/schema";
import type { ComicalRuntime } from "@comical/runtime";

export type { Library, LibraryStore } from "@comical/library";
export type {
  BlobStore,
  DownloadEngine,
  DownloadEngineEvent,
  Downloads,
  DownloadsStore,
  FetchedPage,
  PageFetcher,
  PageResolver,
  PendingPage,
} from "@comical/downloads";
export type { ComicalRuntime } from "@comical/runtime";

/**
 * The device seams for an embedded download engine. Supplied by the app alongside `downloadsStore`:
 * the engine itself (drain loop, queue, events) is built here from `@comical/downloads`, and the
 * app injects only what's platform-bound — where bytes land (`blobs`, expo-file-system in an app),
 * how a `sourceUrl` becomes bytes (`fetchPage`, the reader's own asset resolver), the Wi-Fi-only
 * policy gate, and the between-attempts retry hook (busting a stale asset resolution).
 */
export interface EmbeddedDownloadsEngineConfig {
  blobs: BlobStore;
  fetchPage: PageFetcher;
  mayDownload?: () => Promise<boolean>;
  onPageRetry?: (page: PendingPage) => void;
  /** How lazily-enqueued chapters resolve their page lists at download time. Defaults to driving
   *  the reused router's own `/bridges/...` routes in-process — override only in tests. */
  resolvePages?: PageResolver;
}

/**
 * The device seams for guaranteed-offline library covers: where cover bytes land (`blobs`, a covers-
 * rooted store WITH `read` — the router serves them back at `/library/entries/:b/:s/cover`) and how
 * a cover URL becomes bytes (`fetchPage`, typically the same fetcher the download engine uses).
 */
export interface EmbeddedCoversConfig {
  blobs: BlobStore;
  fetchPage: PageFetcher;
}

export type { BridgeProvider, BridgeSummary, BridgeSource } from "@comical/host-server/bridge-provider";
export type { RegistryProvider } from "@comical/host-server/registry-provider";
export type { TrackerProvider, TrackerSummary } from "@comical/host-server/tracker-provider";

/**
 * A `Hono`-like app as returned by `@comical/host-server`'s `createRouter` — only `.fetch` is used
 * in-process. Kept as a narrow adapter (rather than `typeof createRouter`) so consumers don't pull
 * Hono's types; the caller passes the real `createRouter` and casts to `CreateRouter`.
 */
export interface EmbeddedRouter {
  fetch(req: Request): Response | Promise<Response>;
}

/** The subset of `@comical/host-server`'s `createRouter` signature the embedded runtime uses. */
export type CreateRouter = (
  manager: import("@comical/host-server/bridge-provider").BridgeProvider,
  opts?: {
    origin?: string;
    cors?: boolean;
    registry?: RegistryProvider;
    /** Local library service — enables the `/library*` endpoints when provided. */
    library?: Library;
    /** Runtime orchestration layer — paired with `library` for addToLibrary / read-sync / sync. */
    runtime?: ComicalRuntime;
    /** Downloads service — enables the `/downloads*` offline-manifest endpoints when provided. */
    downloads?: Downloads;
    /** Download engine — with it the router's downloads routes go host-managed (engine-delegated
     *  mutations, host-side blob deletion). The embedded host runs the engine in-process; clients
     *  subscribe to it directly (never via `/downloads/events`, which the buffering transport
     *  could not stream). */
    downloadEngine?: DownloadEngine;
    /** Cover byte cache — with it (alongside `library`) the router captures and serves library
     *  entries' covers for guaranteed-offline rendering. */
    covers?: EmbeddedCoversConfig;
    /** Tracker-management surface — enables the `/trackers*` endpoints when provided. */
    trackers?: TrackerProvider;
  },
) => EmbeddedRouter;

/** A fetch-shaped transport: resolves a server-relative path to a `Response`, same contract as `fetch`. */
export type EmbeddedTransport = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * The native-module JSON contract — an Expo (or bare-RN) native module wrapping `ComicalBridgeContext`
 * (JSC on iOS, QuickJS on Android). Bundle code runs in a separate JS engine; everything crosses the
 * boundary as JSON. `initBridge` returns the loaded bridge's `{ info, methods }` (see `InitResult`).
 *
 * This is the contract comical's `describeJson`/`callJson` native host implementations are written
 * against; it lives here so the native module and its JS consumers share one definition.
 */
export interface NativeBridgeRuntime {
  initBridge(id: string, code: string, settingsJson: string, networkJson?: string): Promise<string>;
  callBridge(id: string, method: string, argsJson: string): Promise<string>;
  disposeBridge(id: string): void;
}

/** What `initBridge` resolves to (JSON-encoded). */
export interface InitResult {
  info: BridgeInfo;
  /** Method names the loaded bridge implements; omitted by older native builds (see capabilities.ts fallback). */
  methods?: string[];
}

/**
 * An installed bridge's cheap metadata — the `info` a registry index already carries (capabilities,
 * nsfw, icon), so a browse list needs no bundle load. Settings descriptors are NOT here: they
 * require loading the bridge, so the provider fetches them lazily (mirroring how the server's
 * BridgeManager loads a bridge to build its summary).
 */
export interface InstalledBridge {
  info: BridgeInfo;
  source: "local" | "registry";
  availableVersion?: string;
  /** True when the bridge's registry no longer lists it (dropped from the index). Surfaced as a
   *  "no longer offered" badge; the bridge keeps working from its pinned bundle. */
  discontinued?: boolean;
}

/**
 * A *pinned* installed-bridge record — the on-device equivalent of the server's manifest
 * `InstalledBridge` (`@comical/registry/schema`). Unlike the registry index (which only ever carries
 * each bridge's latest version), a record freezes the exact version the user installed: its `info`
 * snapshot lets `installed()` list it with no index fetch (offline-friendly), and its `url`/`sha256`/
 * `signature`/`publicKey` let the bundle be re-downloaded + verified even after the index moves on.
 * `availableVersion`/`discontinued` are annotations refreshed by `EmbeddedRegistryProvider.checkUpdates`.
 */
export interface InstalledBridgeRecord {
  id: string;
  /** The resolved `index.json` URL this bridge was installed from. */
  registryUrl: string;
  version: string;
  contractVersion: string;
  info: BridgeInfo;
  /** Absolute URL of the pinned CJS bundle. */
  url: string;
  sha256: string;
  signature?: string;
  /** The registry's Ed25519 public key at install time (for re-verifying a signed bundle). */
  publicKey?: string;
  availableVersion?: string;
  discontinued?: boolean;
}

/**
 * Persistence for the on-device installed-bridge manifest (AsyncStorage-backed in an app). `add`
 * is an upsert — it replaces any existing record with the same `id`.
 */
export interface InstalledStore {
  all(): Promise<InstalledBridgeRecord[]>;
  get(id: string): Promise<InstalledBridgeRecord | null>;
  add(record: InstalledBridgeRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Persistence for the on-device saved-registry list. `add` upserts by `url`. */
export interface SavedRegistryStore {
  all(): Promise<SavedRegistry[]>;
  get(url: string): Promise<SavedRegistry | null>;
  add(registry: SavedRegistry): Promise<void>;
  remove(url: string): Promise<void>;
}

/**
 * Supplies installed bridges + their bundle code. The content-only v1 implementation
 * (`RegistryBundleSource`) downloads + verifies + caches bundles from a registry.
 */
export interface BundleSource {
  /** All installed bridges with their index metadata — cheap, no bundle load required. */
  installed(): Promise<InstalledBridge[]>;
  /** The bundle source code for a bridge id; throws with "not found" for an unknown id. */
  resolveBundle(id: string): Promise<string>;
}

/** Minimal per-bridge settings persistence (AsyncStorage-backed in an app; injectable for tests). */
export interface SettingsStore {
  get(id: string): Promise<Record<string, import("@comical/contract").SettingValue>>;
  set(id: string, values: Record<string, import("@comical/contract").SettingValue>): Promise<void>;
}

/**
 * The native-module JSON contract for trackers — parallel to `NativeBridgeRuntime`, wrapping
 * `ComicalTrackerContext` (see host-native's `comical_init_tracker`/`comical_call_tracker`).
 *
 * `drainTrackerSettingsPatch` is tracker-only (no bridge equivalent): the sandboxed context has no
 * channel to persist a refreshed OAuth token back to the RN-level settings store on its own, so it
 * buffers the refreshed blob and the native side polls it after every `callTracker` — see
 * `installComicalHarness`'s `comical_drain_tracker_patch` doc comment in `@comical/host-native`.
 */
export interface NativeTrackerRuntime {
  initTracker(id: string, code: string, settingsJson: string, networkJson?: string): Promise<string>;
  callTracker(id: string, method: string, argsJson: string): Promise<string>;
  disposeTracker(id: string): void;
  /** JSON `{ key: string, blob: OAuthTokenBlob }` if a token was refreshed since the last drain,
   *  else `null`. Call after every `callTracker`. */
  drainTrackerSettingsPatch(id: string): Promise<string | null>;
}

/** What `initTracker` resolves to (JSON-encoded) — parallel to `InitResult`. */
export interface TrackerInitResult {
  info: TrackerInfo;
  /** Method names the loaded tracker implements; omitted by older native builds (see
   *  tracker-capabilities.ts fallback). */
  methods?: string[];
}

/**
 * A *pinned* installed-tracker record — the tracker equivalent of `InstalledBridgeRecord`. No
 * `info` snapshot: unlike bridge browse lists (which need cheap metadata to avoid a bundle load),
 * `EmbeddedTrackerProvider.list()` always loads the tracker natively regardless (no listing-only
 * optimization exists for trackers server-side either — see `TrackerProvider`), so there's no use
 * for a cached `TrackerInfo` here.
 */
export interface InstalledTrackerRecord {
  id: string;
  /** The resolved `index.json` URL this tracker was installed from. */
  registryUrl: string;
  version: string;
  contractVersion: string;
  /** Absolute URL of the pinned CJS bundle. */
  url: string;
  sha256: string;
  signature?: string;
  /** The registry's Ed25519 public key at install time (for re-verifying a signed bundle). */
  publicKey?: string;
  availableVersion?: string;
  discontinued?: boolean;
}

/**
 * Persistence for the on-device installed-tracker manifest (AsyncStorage-backed in an app). `add`
 * is an upsert — it replaces any existing record with the same `id`.
 */
export interface InstalledTrackerStore {
  all(): Promise<InstalledTrackerRecord[]>;
  get(id: string): Promise<InstalledTrackerRecord | null>;
  add(record: InstalledTrackerRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

/**
 * Supplies installed tracker ids + their bundle code — the tracker equivalent of `BundleSource`,
 * deliberately simpler (ids only, no metadata) since no listing-without-a-load optimization exists
 * for trackers. `ManifestTrackerBundleSource` (registry-bundle-source.ts) is the standard
 * implementation: reads the pinned manifest for `ids()`, downloads + verifies + caches for
 * `resolveBundle()` — the same install model bridges use, not a static app-bundled map.
 */
export interface TrackerBundleSource {
  /** Ids of all installed trackers — cheap, no bundle load required. */
  ids(): Promise<string[]>;
  /** The bundle source code for a tracker id; throws with "not found" for an unknown id. */
  resolveBundle(id: string): Promise<string>;
}
