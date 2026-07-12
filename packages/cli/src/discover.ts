/**
 * Discovers built bridges on disk. For M1 a bridge "registry" is just the local `bridges/`
 * directory; each `<bridge>/dist/bridge.js` is loaded (with a no-network host) to read its info.
 * Networked registries are a later milestone.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeInfo, HostCapabilities, TrackerInfo } from "@comical/contract";
import { loadBridge, loadTracker } from "@comical/core";

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

export function discoverBridges(bridgesDir: string | string[]): DiscoveredBridge[] {
  const roots = Array.isArray(bridgesDir) ? bridgesDir : [bridgesDir];
  const found: DiscoveredBridge[] = [];
  for (const root of roots) {
    let dirs: string[];
    try {
      dirs = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const bundlePath = join(root, dir, "dist", "bridge.js");
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
  }
  return found;
}

/**
 * Filter discovered bridges by their declared `nsfw` rating. Used by `registry publish --nsfw`
 * to emit a rating-specific registry (an SFW-only or NSFW-only `index.json`). A `nsfwFilter` of
 * `undefined` means "no filter" — every bridge is kept (the default publish behavior).
 */
export function filterBridgesByNsfw<T extends { info: Pick<BridgeInfo, "nsfw"> }>(
  bridges: T[],
  nsfwFilter: boolean | undefined,
): T[] {
  return nsfwFilter === undefined ? bridges : bridges.filter((b) => b.info.nsfw === nsfwFilter);
}

export function resolveBridge(bridgesDir: string | string[], id: string): DiscoveredBridge {
  const match = discoverBridges(bridgesDir).find((b) => b.id === id);
  if (!match) {
    const dirs = Array.isArray(bridgesDir) ? bridgesDir.join(", ") : bridgesDir;
    throw new Error(`bridge "${id}" not found in ${dirs} (did you run \`bun run build\`?)`);
  }
  return match;
}

// ── Tracker discovery ─────────────────────────────────────────────────────────

export interface DiscoveredTracker {
  id: string;
  info: TrackerInfo;
  bundlePath: string;
  dir: string;
}

export function discoverTrackers(trackersDir: string | string[]): DiscoveredTracker[] {
  const roots = Array.isArray(trackersDir) ? trackersDir : [trackersDir];
  const found: DiscoveredTracker[] = [];
  for (const root of roots) {
    let dirs: string[];
    try {
      dirs = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const bundlePath = join(root, dir, "dist", "tracker.js");
      let code: string;
      try {
        code = readFileSync(bundlePath, "utf8");
      } catch {
        continue;
      }
      try {
        const tracker = loadTracker({ code, capabilities: infoOnlyHost() });
        found.push({ id: tracker.info.id, info: tracker.info, bundlePath, dir });
      } catch {
        // Skip bundles that fail to load
      }
    }
  }
  return found;
}
