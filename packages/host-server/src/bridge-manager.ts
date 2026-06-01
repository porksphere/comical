/**
 * Manages the lifecycle of loaded bridges on the server.
 *
 * Bridges are loaded on first request and cached. When a bridge's settings change
 * the cached instance is invalidated so the next call reloads with the new config.
 * This means a browser client can update `baseUrl` via PUT /bridges/:id/settings and
 * the change takes effect immediately on the next request.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeInfo, SettingDescriptor } from "@comical/contract";
import { type LoadedBridge, loadBridge } from "@comical/core";
import { createBunHost } from "@comical/host-bun";
import {
  type DiscoveredBridge,
  discoverBridges,
  resolveBridge,
} from "../../cli/src/discover.ts";
import type { SettingsStore } from "./settings-store.ts";

export interface BridgeManagerOptions {
  bridgesDir: string;
  dataDir: string;
  settings: SettingsStore;
}

export interface BridgeSummary {
  info: BridgeInfo;
  settings: SettingDescriptor[];
  configured: boolean;
}

export class BridgeManager {
  private readonly loaded = new Map<string, LoadedBridge>();
  private discovered: DiscoveredBridge[] | undefined;

  constructor(private readonly opts: BridgeManagerOptions) {}

  /** Invalidate discovery cache (e.g. after a new bridge is installed). */
  refresh(): void {
    this.discovered = undefined;
    this.loaded.clear();
  }

  /** Invalidate a single bridge's loaded instance (e.g. after settings change). */
  invalidate(id: string): void {
    this.loaded.delete(id);
  }

  /** Update user settings for a bridge; invalidates the cached instance. */
  async updateSettings(
    id: string,
    patch: Record<string, string | boolean>,
  ): Promise<Record<string, string | boolean>> {
    const updated = await this.opts.settings.patch(id, patch) as Record<string, string | boolean>;
    this.invalidate(id);
    return updated;
  }

  private discover(): DiscoveredBridge[] {
    if (!this.discovered) this.discovered = discoverBridges(this.opts.bridgesDir);
    return this.discovered;
  }

  async list(): Promise<BridgeSummary[]> {
    const results: BridgeSummary[] = [];
    for (const d of this.discover()) {
      const bridge = await this.get(d.id);
      const userSettings = await this.opts.settings.get(d.id);
      results.push({
        info: bridge.info,
        settings: bridge.getSettings?.() ?? [],
        configured: Object.keys(userSettings).length > 0,
      });
    }
    return results;
  }

  async get(id: string): Promise<LoadedBridge> {
    const cached = this.loaded.get(id);
    if (cached) return cached;

    const discovered = resolveBridge(this.opts.bridgesDir, id);
    const code = readFileSync(discovered.bundlePath, "utf8");
    const userSettings = await this.opts.settings.get(id);

    const capabilities = createBunHost({
      bridgeId: id,
      settings: userSettings,
      dataDir: join(this.opts.dataDir, "bridge-storage"),
    });

    const bridge = loadBridge({ code, capabilities, expectedId: id });
    this.loaded.set(id, bridge);
    return bridge;
  }
}
