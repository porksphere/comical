/**
 * Assembles a full `HostCapabilities` for the Bun/desktop runtime: native network, filesystem or
 * in-memory storage namespaced per bridge, a console logger, and the user-supplied settings (backend
 * URL, credentials) for the bridge being loaded. The cookie jar / session state lives in core's
 * gated network, so this host just reports Set-Cookie via the raw network.
 */
import { join } from "node:path";
import type { HostCapabilities, LogCapability, ResolvedSettings } from "@comical/contract";
import { createBunNetwork } from "./network.ts";
import { FileStorage, MemoryStorage } from "./storage.ts";

export interface BunHostOptions {
  /** Identifies the bridge, for storage namespacing. */
  bridgeId: string;
  /** Resolved user settings for this bridge (backend URL, credentials, …). */
  settings?: ResolvedSettings;
  /** Base directory for persistent storage. If omitted, storage is in-memory only. */
  dataDir?: string;
  log?: LogCapability;
  userAgent?: string;
  /** Base URL of the host server. Forwarded to the bridge via HostCapabilities.hostUrl. */
  hostUrl?: string;
}

export const consoleLog: LogCapability = {
  debug: (...a) => console.debug("[bridge]", ...a),
  info: (...a) => console.info("[bridge]", ...a),
  warn: (...a) => console.warn("[bridge]", ...a),
  error: (...a) => console.error("[bridge]", ...a),
};

export function createBunHost(opts: BunHostOptions): HostCapabilities {
  const network = createBunNetwork(
    opts.userAgent !== undefined ? { userAgent: opts.userAgent } : {},
  );
  const storage =
    opts.dataDir !== undefined
      ? new FileStorage(join(opts.dataDir), opts.bridgeId)
      : new MemoryStorage();

  return {
    network,
    storage,
    log: opts.log ?? consoleLog,
    settings: opts.settings ?? {},
    ...(opts.hostUrl !== undefined && { hostUrl: opts.hostUrl }),
  };
}
