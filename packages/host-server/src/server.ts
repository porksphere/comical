/**
 * Assembles the complete server: SettingsStore + BridgeManager + RegistryManager + Hono router.
 */
import { join } from "node:path";
import { Library, type LibraryStore } from "@comical/library";
import { ManifestStore, RegistryManager } from "@comical/registry";
import { ComicalRuntime } from "@comical/runtime";
import { BridgeManager } from "./bridge-manager.ts";
import { FileLibraryStore } from "./library-store.ts";
import { createRouter, type RouterOptions } from "./router.ts";
import { SettingsStore } from "./settings-store.ts";
import { SyncHub } from "./sync-hub.ts";
import { FileAccountStore } from "./account-store.ts";
import { adminConsolePage, adminLoginPage } from "./admin-page.ts";
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
   * Enable the tracker plugin system. Pass a path (or array of paths) to scan for tracker bundles.
   * Omit to leave `/trackers` endpoints unmounted entirely.
   */
  trackersDir?: string | string[];
  /**
   * Act as the cross-device sync hub. `true` stores accounts under `{dataDir}/sync`; pass `{ dir }`
   * to override. Defaults to `COMICAL_SYNC=1`. Omit to leave `/sync` unmounted entirely.
   *
   * Requires `token` — see `RouterOptions.sync`.
   */
  sync?: boolean | { dir?: string };
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

  // Defaulting from the environment means an existing embedder (comical-web's server.dev.ts, the
  // production container) becomes the sync hub by configuration alone, with no code change.
  const sync = opts.sync ?? (process.env.COMICAL_SYNC === "1");

  // The library store is SHARED between the `/library` endpoints and the sync hub, so a web client
  // browsing /library and a native device syncing via /sync operate on the same data. Build it once
  // if either needs it.
  let libraryStore: LibraryStore | undefined;
  if (opts.library || sync) {
    const dir = typeof opts.library === "object" && opts.library.dir
      ? opts.library.dir
      : join(opts.dataDir, "library");
    libraryStore = new FileLibraryStore(dir);
  }

  if (sync) {
    const dir = typeof sync === "object" && sync.dir ? sync.dir : join(opts.dataDir, "sync");
    // The hub is a sync NODE, not a passive relay: it projects pushed records onto the library
    // (native → web) and, via wrapLibrary(), captures library writes back as records (web → native).
    const hub = new SyncHub(dir, libraryStore!);
    routerOpts.sync = hub;
    libraryStore = hub.wrapLibrary(); // the Library service now writes through the hub
    // Accounts are created/managed through the master `token`, so they're only useful — and only
    // stood up — when a token is configured. With a token, login mints the per-device session tokens
    // that reach /sync (and the rest of the API). Without one, no accounts store is created, and
    // createRouter's fail-closed check refuses `sync` outright: a sync hub with no credential at all
    // would serve the whole library to anyone who can reach the port.
    if (routerOpts.token) routerOpts.accounts = new FileAccountStore(join(opts.dataDir, "accounts"));
  }

  if (opts.library) {
    const lib = new Library(libraryStore!);
    routerOpts.library = lib;
    routerOpts.runtime = new ComicalRuntime({
      bridges: manager,
      library: lib,
      ...(trackerManager ? { trackers: trackerManager } : {}),
    });
  }

  const router = createRouter(manager, routerOpts);

  // Browser account console — create/manage accounts without a terminal. Registered HERE (not in the
  // router) so its HTML never lands in router.ts's bundle, which the React Native app embeds. Behind
  // the master token; the mutations go through the master-guarded /accounts + /sessions JSON routes.
  const accounts = routerOpts.accounts;
  const masterToken = routerOpts.token;
  if (accounts && masterToken) {
    router.get("/admin", async (c) => {
      const token = c.req.query("token");
      if (!token) return c.html(adminLoginPage());
      if (token !== masterToken) return c.html(adminLoginPage("That token was not accepted."), 401);
      return c.html(adminConsolePage({ accounts: await accounts.list(), token }));
    });
  }

  return Bun.serve({ port: opts.port ?? 3100, fetch: router.fetch });
}

// ── Standalone entry point ────────────────────────────────────────────────────

if (import.meta.main) {
  const ROOT = join(import.meta.dir, "..", "..", "..");
  // A sync hub with no credential would expose the whole library, so createServer refuses it. Catch
  // the misconfiguration here to point the operator at the fix rather than dumping a stack trace.
  if (process.env.COMICAL_SYNC === "1" && !process.env.COMICAL_TOKEN) {
    console.error("COMICAL_SYNC=1 requires COMICAL_TOKEN — the admin credential that creates accounts.");
    console.error("Set COMICAL_TOKEN to a secret, then create accounts at /admin or with `comical accounts add`.");
    process.exit(1);
  }
  const server = createServer({
    port: Number(process.env.PORT ?? 3100),
    bridgesDir: join(ROOT, "bridges"),
    dataDir: process.env.COMICAL_DATA_DIR ?? join(ROOT, ".comical"),
    library: true,
    ...(process.env.COMICAL_ORIGIN ? { origin: process.env.COMICAL_ORIGIN } : {}),
    ...(process.env.COMICAL_TOKEN ? { token: process.env.COMICAL_TOKEN } : {}),
  });

  console.log(`comical-server running on http://localhost:${server.port}`);
  if (process.env.COMICAL_SYNC === "1") {
    console.log("  cross-device sync hub enabled — clients authenticate with POST /login");
    console.log(`  manage accounts: open http://localhost:${server.port}/admin, or run \`comical accounts …\``);
  } else if (!process.env.COMICAL_TOKEN) {
    console.warn("  COMICAL_TOKEN is not set — server is unauthenticated (LAN use only)");
  }
}
