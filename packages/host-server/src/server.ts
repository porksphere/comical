/**
 * Assembles the complete server: SettingsStore + BridgeManager + RegistryManager + Hono router.
 */
import { join } from "node:path";
import { DownloadEngine, Downloads } from "@comical/downloads";
import { Library } from "@comical/library";
import { ManifestStore, RegistryManager } from "@comical/registry";
import { ComicalRuntime } from "@comical/runtime";
import { BridgeManager } from "./bridge-manager.ts";
import { FileBlobStore } from "./blob-store.ts";
import { FileDownloadsStore } from "./downloads-store.ts";
import { FileLibraryStore } from "./library-store.ts";
import { createServerPageFetcher } from "./page-fetcher.ts";
import { createRouter, type RouterOptions } from "./router.ts";
import { SettingsStore } from "./settings-store.ts";
import { TrackerManager } from "./tracker-manager.ts";

export interface ServerOptions {
  port?: number;
  bridgesDir: string | string[];
  dataDir: string;
  origin?: string;
  token?: string;
  /**
   * Enable the optional local library/tracking module. `true` stores it under `{dataDir}/library`;
   * pass `{ dir }` to override. Omit to leave the `/library` endpoints unmounted entirely.
   */
  library?: boolean | { dir?: string };
  /**
   * Enable the optional offline-downloads module: the manifest under `{dataDir}/downloads` plus a
   * server-side download engine that fetches page bytes via the server's own bridges and stores them
   * under `{dataDir}/downloads/blobs` (served back at `/downloads/.../file`, progress at
   * `/downloads/events`). Pass `{ dir }` to override the root. Omit to leave `/downloads` unmounted.
   */
  downloads?: boolean | { dir?: string };
  /**
   * Enable the tracker plugin system. Pass a path (or array of paths) to scan for tracker bundles.
   * Omit to leave `/trackers` endpoints unmounted entirely.
   */
  trackersDir?: string | string[];
}

export function createServer(opts: ServerOptions): ReturnType<typeof Bun.serve> {
  const settings = new SettingsStore(opts.dataDir);
  const manifest = new ManifestStore(opts.dataDir);
  const registry = new RegistryManager({
    cacheDir: join(opts.dataDir, "bridge-cache"),
    manifest,
  });
  const manager = new BridgeManager({
    bridgesDir: opts.bridgesDir,
    dataDir: opts.dataDir,
    settings,
    registry,
    hostUrl: `http://localhost:${opts.port ?? 3100}`,
  });

  const port = opts.port ?? 3100;
  const routerOpts: RouterOptions = { registry, callbackBaseUrl: `http://localhost:${port}` };
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

  if (opts.library) {
    const dir = typeof opts.library === "object" && opts.library.dir
      ? opts.library.dir
      : join(opts.dataDir, "library");
    const lib = new Library(new FileLibraryStore(dir));
    routerOpts.library = lib;
    routerOpts.runtime = new ComicalRuntime({
      bridges: manager,
      library: lib,
      ...(trackerManager ? { trackers: trackerManager } : {}),
    });
    // Guaranteed-offline covers for library entries, under the library's own dir.
    routerOpts.covers = { blobs: new FileBlobStore(join(dir, "covers")), fetchPage: pageFetcher };
  }

  let engine: DownloadEngine | undefined;
  if (opts.downloads) {
    const dir = typeof opts.downloads === "object" && opts.downloads.dir
      ? opts.downloads.dir
      : join(opts.dataDir, "downloads");
    const downloads = new Downloads(new FileDownloadsStore(dir));
    engine = new DownloadEngine({
      downloads,
      blobs: new FileBlobStore(join(dir, "blobs")),
      fetchPage: pageFetcher,
    });
    routerOpts.downloads = downloads;
    routerOpts.downloadEngine = engine;
  }
  const router = createRouter(manager, routerOpts);
  routerFetch = (req) => router.fetch(req);
  engine?.kick(); // resume any downloads interrupted by the previous run

  return Bun.serve({ port: opts.port ?? 3100, fetch: router.fetch });
}

// ── Standalone entry point ────────────────────────────────────────────────────

if (import.meta.main) {
  const ROOT = join(import.meta.dir, "..", "..", "..");
  const server = createServer({
    port: Number(process.env.PORT ?? 3100),
    bridgesDir: join(ROOT, "bridges"),
    dataDir: process.env.COMICAL_DATA_DIR ?? join(ROOT, ".comical"),
    library: true,
    downloads: true,
    ...(process.env.COMICAL_ORIGIN ? { origin: process.env.COMICAL_ORIGIN } : {}),
    ...(process.env.COMICAL_TOKEN ? { token: process.env.COMICAL_TOKEN } : {}),
  });

  console.log(`comical-server running on http://localhost:${server.port}`);
  if (!process.env.COMICAL_TOKEN) {
    console.warn("  COMICAL_TOKEN is not set — server is unauthenticated (LAN use only)");
  }
}
