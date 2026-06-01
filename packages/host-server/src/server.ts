/**
 * Assembles the complete server: SettingsStore + BridgeManager + Hono router + Bun.serve.
 * This is the entry point for `comical serve` and `bun run packages/host-server/src/server.ts`.
 */
import { join } from "node:path";
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
  const manager = new BridgeManager({
    bridgesDir: opts.bridgesDir,
    dataDir: opts.dataDir,
    settings,
  });
  const routerOpts: RouterOptions = {};
  if (opts.origin) routerOpts.origin = opts.origin;
  if (opts.token) routerOpts.token = opts.token;
  const router = createRouter(manager, routerOpts);

  const server = Bun.serve({
    port: opts.port ?? 3100,
    fetch: router.fetch,
  });

  return server;
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
  console.log(`  bridges: ${join(import.meta.dir, "..", "..", "..", "bridges")}`);
  if (!process.env.COMICAL_TOKEN) {
    console.warn("  COMICAL_TOKEN is not set — server is unauthenticated (LAN use only)");
  }
}
