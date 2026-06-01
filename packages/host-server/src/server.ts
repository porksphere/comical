/**
 * Assembles the complete server: SettingsStore + BridgeManager + RegistryManager + Hono router.
 */
import { join } from "node:path";
import { ManifestStore, RegistryManager } from "@comical/registry";
import { BridgeManager } from "./bridge-manager.ts";
import { createRouter, type RouterOptions } from "./router.ts";
import { SettingsStore } from "./settings-store.ts";

export interface ServerOptions {
  port?: number;
  bridgesDir: string;
  dataDir: string;
  origin?: string;
  token?: string;
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
  });

  const routerOpts: RouterOptions = { registry };
  if (opts.origin) routerOpts.origin = opts.origin;
  if (opts.token) routerOpts.token = opts.token;
  const router = createRouter(manager, routerOpts);

  return Bun.serve({ port: opts.port ?? 3100, fetch: router.fetch });
}

// ── Standalone entry point ────────────────────────────────────────────────────

if (import.meta.main) {
  const ROOT = join(import.meta.dir, "..", "..", "..");
  const server = createServer({
    port: Number(process.env.PORT ?? 3100),
    bridgesDir: join(ROOT, "bridges"),
    dataDir: process.env.COMICAL_DATA_DIR ?? join(ROOT, ".comical"),
    ...(process.env.COMICAL_ORIGIN ? { origin: process.env.COMICAL_ORIGIN } : {}),
    ...(process.env.COMICAL_TOKEN ? { token: process.env.COMICAL_TOKEN } : {}),
  });

  console.log(`comical-server running on http://localhost:${server.port}`);
  if (!process.env.COMICAL_TOKEN) {
    console.warn("  COMICAL_TOKEN is not set — server is unauthenticated (LAN use only)");
  }
}
