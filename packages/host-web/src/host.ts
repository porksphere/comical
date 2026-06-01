/**
 * Assembles a full `HostCapabilities` for the browser runtime: proxy-backed network,
 * localStorage (or memory) storage, console log, and user-supplied settings.
 */
import type { HostCapabilities, LogCapability, ResolvedSettings } from "@comical/contract";
import { createProxyNetwork, type ProxyNetworkOptions } from "./network.ts";
import { createWebStorage } from "./storage.ts";

export interface WebHostOptions {
  bridgeId: string;
  proxy: ProxyNetworkOptions;
  settings?: ResolvedSettings;
  log?: LogCapability;
}

export const webConsoleLog: LogCapability = {
  debug: (...a) => console.debug("[bridge]", ...a),
  info: (...a) => console.info("[bridge]", ...a),
  warn: (...a) => console.warn("[bridge]", ...a),
  error: (...a) => console.error("[bridge]", ...a),
};

export function createWebHost(opts: WebHostOptions): HostCapabilities {
  return {
    network: createProxyNetwork(opts.proxy),
    storage: createWebStorage(opts.bridgeId),
    log: opts.log ?? webConsoleLog,
    settings: opts.settings ?? {},
  };
}
