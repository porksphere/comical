/**
 * Assembles the complete host — SettingsStore + BridgeManager + RegistryManager + the optional
 * library / sync / downloads / tracker modules — behind one Hono router, **without listening on a
 * socket**. Everything here is plain Node (`node:fs`, `node:vm`); nothing is Bun-specific.
 *
 * `createServer()` (server.ts) is this plus `Bun.serve`. Electron's main process, an in-process
 * test, or any other Node embedder uses `createHost()` directly and drives `router.fetch` (or the
 * `fetch(path, init)` seam, the same in-process shape `@comical/host-rn` uses on iOS/Android).
 */
import { join } from "node:path";
import { DownloadEngine, Downloads } from "@comical/downloads";
import { DEFAULT_USER_AGENT } from "@comical/host-bun";
import { Library, type LibraryStore } from "@comical/library";
import { ManifestStore, RegistryManager } from "@comical/registry/node";
import { ComicalRuntime, migrateInstalledBridges, withIdMigration } from "@comical/runtime";
import { BridgeManager } from "./bridge-manager.ts";
import { FileBlobStore } from "./blob-store.ts";
import { FileDownloadsStore } from "./downloads-store.ts";
import { FileLibraryStore } from "./library-store.ts";
import { createSyncHost, dropStaleLoads, type SyncApplied } from "./sync-host.ts";
import { migrateLegacyEntries } from "./legacy-entries.ts";
import { createServerPageFetcher, createServerPageResolver } from "./page-fetcher.ts";
import { createRouter, type RouterOptions } from "./router.ts";
import { SettingsStore } from "./settings-store.ts";
import { TrackerManager } from "./tracker-manager.ts";

export interface HostOptions {
  /** Where everything persists: settings, the bridge cache, and (when enabled) library/downloads. */
  dataDir: string;
  /** Directories scanned for local (unpacked) bridge bundles. Registry-installed bridges land in
   *  `{dataDir}/bridge-cache` regardless. Defaults to `{dataDir}/bridges`. */
  bridgesDir?: string | string[];
  /** The base URL bridges see as `hostUrl` (OAuth redirects, self-referencing asset URLs).
   *  Defaults to `http://localhost:3100`. */
  hostUrl?: string;
  /** CORS origin for the router; omit for the LAN-friendly `*` default. */
  origin?: string;
  /** Bearer token the router requires; omit for an unauthenticated (LAN-only) host. */
  token?: string;
  /** A self-hosted deployment that registered its own relay page with its OAuth providers. */
  oauthRedirectUrl?: string;
  /**
   * Enable the optional local library/tracking module. `true` stores it under `{dataDir}/library`;
   * pass `{ dir }` to override. Omit to leave the `/library` endpoints unmounted entirely.
   */
  library?: boolean | { dir?: string };
  /**
   * Make this host a sync hub (`/sync`) that its own library also syncs through. Needs `library`.
   * `true` keeps the hub under `{dataDir}/sync`; pass `{ dir }` to override.
   */
  sync?: boolean | { dir?: string };
  /** Another device's changes have just landed in this library or its bridges (sync only). */
  onSynced?: (applied: SyncApplied) => void;
  /**
   * Enable the optional offline-downloads module: the manifest under `{dataDir}/downloads` plus a
   * host-side download engine that fetches page bytes via the host's own bridges and stores them
   * under `{dataDir}/downloads/blobs` (served back at `/downloads/.../file`, progress at
   * `/downloads/events`). Pass `{ dir }` to override the root. Omit to leave `/downloads` unmounted.
   */
  downloads?: boolean | { dir?: string };
  /**
   * Directories to scan for local tracker bundles. Registry-installed trackers work without it;
   * the `/trackers` endpoints are always mounted.
   */
  trackersDir?: string | string[];
}

export interface ComicalHost {
  /** The assembled Hono app. `.fetch(Request)` is the whole API surface. */
  router: ReturnType<typeof createRouter>;
  /** In-process transport: a server-relative path in, a `Response` out. No socket involved. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Stop background work (the download engine, sync rounds). Persisted state is left as is. */
  close(): void;
}

/** The origin is arbitrary — the router matches on path only, and nothing leaves the process. */
const IN_PROCESS_ORIGIN = "http://host.comical.local";

export function createHost(opts: HostOptions): ComicalHost {
  const settings = new SettingsStore(opts.dataDir);
  const manifest = new ManifestStore(opts.dataDir);
  const registry = new RegistryManager({
    cacheDir: join(opts.dataDir, "bridge-cache"),
    manifest,
  });
  // The library and the download engine are built further down, from options that need the manager.
  let lib: Library | undefined;
  let engine: DownloadEngine | undefined;
  // Wrapped before anything else holds it, so no caller can reach a bridge before its ids migrate.
  const manager = withIdMigration(
    new BridgeManager({
      bridgesDir: opts.bridgesDir ?? join(opts.dataDir, "bridges"),
      dataDir: opts.dataDir,
      settings,
      registry,
      hostUrl: opts.hostUrl ?? "http://localhost:3100",
    }),
    { library: () => lib, downloads: () => engine, log: console },
  );
  // What the router writes settings through; with sync on, the recording one.
  let bridges = manager;

  const routerOpts: RouterOptions = {
    registry,
    userAgent: DEFAULT_USER_AGENT,
  };
  if (opts.oauthRedirectUrl) routerOpts.oauthRedirectUrl = opts.oauthRedirectUrl;
  if (opts.origin) routerOpts.origin = opts.origin;
  if (opts.token) routerOpts.token = opts.token;

  // Always create TrackerManager so that registry-installed trackers work
  // even when no local trackersDir is configured.
  const trackerManager = new TrackerManager({
    ...(opts.trackersDir ? { trackersDir: opts.trackersDir } : {}),
    dataDir: opts.dataDir,
    settings,
    registry,
  });
  routerOpts.trackers = trackerManager;

  // Shared late-bound in-process fetch: the download engine AND the cover capture both resolve
  // server-relative asset URLs by driving this router directly, but the router can't exist until
  // its options (which reference them) are assembled — so the fetch is assigned after creation.
  let routerFetch: (req: Request) => Response | Promise<Response> = () =>
    new Response(null, { status: 503 });
  const pageFetcher = createServerPageFetcher(() => routerFetch, opts.token);

  let stopSync: (() => void) | undefined;
  if (opts.library) {
    const dir = typeof opts.library === "object" && opts.library.dir
      ? opts.library.dir
      : join(opts.dataDir, "library");
    let store: LibraryStore = new FileLibraryStore(dir);
    if (opts.sync) {
      const syncDir = typeof opts.sync === "object" && opts.sync.dir ? opts.sync.dir : join(opts.dataDir, "sync");
      const host = createSyncHost({
        dir: syncDir,
        store,
        registry,
        bridges: manager,
        lists: {
          registries: () => manifest.allRegistries(),
          installed: () => manifest.allInstalled(),
          installedTrackers: () => manifest.allInstalledTrackers(),
        },
        ...(opts.onSynced ? { onApplied: opts.onSynced } : {}),
        onRegistryApplied: dropStaleLoads(manager, trackerManager),
      });
      store = host.store;
      routerOpts.sync = host.backend;
      // The router's installs are recorded; the managers keep the plain one, they only read.
      routerOpts.registry = host.registry;
      bridges = host.bridges;
      stopSync = () => host.stop();
    }
    lib = new Library(store);
    // Rebuild series items from a pre-collections entries.json, if one is still there. Everything
    // else a series owns survived the dissolution orphaned, so this reattaches it. No-op once run.
    void migrateLegacyEntries(dir, lib)
      .then((m) => {
        if (m) console.log(`library: migrated ${m.imported} legacy entries (${m.skipped} skipped)`);
      })
      .catch((e: unknown) => console.error("library: legacy entry migration failed", e));
    routerOpts.library = lib;
    routerOpts.runtime = new ComicalRuntime({
      bridges: manager,
      library: lib,
      trackers: trackerManager,
      // So a best-effort tracker push that fails (expired token, network) shows up in the host log
      // instead of vanishing — it's fire-and-forget, nothing else would ever report it.
      log: console,
    });
    // Guaranteed-offline covers for library entries, under the library's own dir.
    routerOpts.covers = { blobs: new FileBlobStore(join(dir, "covers")), fetchPage: pageFetcher };
  }

  if (opts.downloads) {
    const dir = typeof opts.downloads === "object" && opts.downloads.dir
      ? opts.downloads.dir
      : join(opts.dataDir, "downloads");
    const downloads = new Downloads(new FileDownloadsStore(dir));
    engine = new DownloadEngine({
      downloads,
      blobs: new FileBlobStore(join(dir, "blobs")),
      fetchPage: pageFetcher,
      // Lazily-enqueued chapters (the instant bulk-enqueue path) resolve their page lists at
      // download time, through this router's own bridge routes.
      resolvePages: createServerPageResolver(() => routerFetch, opts.token),
      // Each bridge's declared image budget paces its page downloads, whatever URL shape they use.
      pageRateLimit: async (id) => (await manager.list()).find((b) => b.info.id === id)?.info.assetRateLimit,
    });
    routerOpts.downloads = downloads;
    routerOpts.downloadEngine = engine;
  }
  const router = createRouter(bridges, routerOpts);
  routerFetch = (req) => router.fetch(req);
  engine?.kick(); // resume any downloads interrupted by the previous run
  // Bridges updated while this host was down move their records now, not on first use.
  if (lib) void migrateInstalledBridges(manager, lib, console).catch((e: unknown) => console.error("id migration failed", e));

  return {
    router,
    fetch: (path, init) => Promise.resolve(router.fetch(new Request(`${IN_PROCESS_ORIGIN}${path}`, init))),
    close: () => {
      engine?.stop();
      stopSync?.();
    },
  };
}
