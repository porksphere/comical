/**
 * The standalone server: `createHost()` (host.ts) behind `Bun.serve`.
 *
 * This is the only Bun-specific line in the package. Everything the host does — the Hono router,
 * `BridgeManager`, the `node:vm` evaluator, the file stores — is plain Node; see host.ts. A Node
 * embedder (Electron, a test) uses `createHost()` and picks its own listener, or none.
 */
import { join } from "node:path";
import { createHost, type HostOptions } from "./host.ts";

export interface ServerOptions extends HostOptions {
  /** Defaults to 3100. Also the default `hostUrl`'s port. */
  port?: number;
}

export function createServer(opts: ServerOptions): ReturnType<typeof Bun.serve> {
  const port = opts.port ?? 3100;
  const host = createHost({
    hostUrl: `http://localhost:${port}`,
    ...(process.env.COMICAL_OAUTH_REDIRECT_URL ? { oauthRedirectUrl: process.env.COMICAL_OAUTH_REDIRECT_URL } : {}),
    ...opts,
  });
  return Bun.serve({ port, fetch: host.router.fetch });
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
    sync: true,
    ...(process.env.COMICAL_ORIGIN ? { origin: process.env.COMICAL_ORIGIN } : {}),
    ...(process.env.COMICAL_TOKEN ? { token: process.env.COMICAL_TOKEN } : {}),
  });

  console.log(`comical-server running on http://localhost:${server.port}`);
  if (!process.env.COMICAL_TOKEN) {
    console.warn("  COMICAL_TOKEN is not set — server is unauthenticated (LAN use only)");
  }
}
