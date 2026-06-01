/**
 * Discovers built bridges on disk. For M1 a bridge "registry" is just the local `bridges/`
 * directory; each `<bridge>/dist/bridge.js` is loaded (with a no-network host) to read its info.
 * Networked registries are a later milestone.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeInfo, HostCapabilities } from "@comical/contract";
import { loadBridge } from "@comical/core";

export interface DiscoveredBridge {
  id: string;
  info: BridgeInfo;
  bundlePath: string;
  dir: string;
}

/** A host with no real capabilities — enough to instantiate a bridge and read its static info. */
function infoOnlyHost(): HostCapabilities {
  return {
    network: { request: async () => { throw new Error("network unavailable in info-only host"); } },
    storage: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      keys: async () => [],
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    settings: {},
  };
}

export function readBundle(bundlePath: string): string {
  return readFileSync(bundlePath, "utf8");
}

export function discoverBridges(bridgesDir: string): DiscoveredBridge[] {
  let dirs: string[];
  try {
    dirs = readdirSync(bridgesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const found: DiscoveredBridge[] = [];
  for (const dir of dirs) {
    const bundlePath = join(bridgesDir, dir, "dist", "bridge.js");
    let code: string;
    try {
      code = readFileSync(bundlePath, "utf8");
    } catch {
      continue; // not built yet
    }
    try {
      const bridge = loadBridge({ code, capabilities: infoOnlyHost() });
      found.push({ id: bridge.info.id, info: bridge.info, bundlePath, dir });
    } catch {
      // Skip bundles that fail to load (e.g. incompatible contract version).
    }
  }
  return found;
}

export function resolveBridge(bridgesDir: string, id: string): DiscoveredBridge {
  const match = discoverBridges(bridgesDir).find((b) => b.id === id);
  if (!match) {
    throw new Error(`bridge "${id}" not found in ${bridgesDir} (did you run \`bun run build\`?)`);
  }
  return match;
}
