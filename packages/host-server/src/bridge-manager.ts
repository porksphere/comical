/**
 * Manages the lifecycle of loaded bridges on the server.
 *
 * M4 extension: bridges can now come from two sources:
 *   - Local (bridges/ directory, built with `bun run build`) — source: "local"
 *   - Registry (downloaded, verified, cached in dataDir/bridge-cache/) — source: "registry"
 *
 * Registry bridges are registry-aware: orphaned bridges (from a removed registry) are
 * blocked at load time with a clear error rather than failing mid-request.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeInfo, SettingDescriptor, SettingValue } from "@comical/contract";
import { type LoadedBridge, loadBridge, resolveSettings } from "@comical/core";
import { createBunHost } from "@comical/host-bun";
import type { RegistryManager } from "@comical/registry";
import {
  type DiscoveredBridge,
  discoverBridges,
  resolveBridge,
} from "../../cli/src/discover.ts";
import type { SettingsStore } from "./settings-store.ts";

export interface BridgeManagerOptions {
  bridgesDir: string | string[];
  dataDir: string;
  settings: SettingsStore;
  /** Registry manager, if M4 registry support is enabled. */
  registry?: RegistryManager;
}

export type BridgeSource = "local" | "registry";

export interface BridgeSummary {
  info: BridgeInfo;
  settings: SettingDescriptor[];
  configured: boolean;
  /** Required setting keys with neither a value nor a default — the bridge can't serve content yet. */
  missingRequired: string[];
  source: BridgeSource;
  /** Version available in the registry, if newer than installed. */
  availableVersion?: string;
}

export class BridgeManager {
  private readonly loaded = new Map<string, LoadedBridge>();
  private discovered: DiscoveredBridge[] | undefined;

  constructor(private readonly opts: BridgeManagerOptions) {}

  refresh(): void {
    this.discovered = undefined;
    this.loaded.clear();
  }

  invalidate(id: string): void {
    this.loaded.delete(id);
  }

  async updateSettings(
    id: string,
    patch: Record<string, SettingValue>,
  ): Promise<Record<string, SettingValue>> {
    const updated = (await this.opts.settings.patch(id, patch)) as Record<string, SettingValue>;
    this.invalidate(id);
    return updated;
  }

  private discover(): DiscoveredBridge[] {
    if (!this.discovered) this.discovered = discoverBridges(this.opts.bridgesDir);
    return this.discovered;
  }

  async list(): Promise<BridgeSummary[]> {
    const results: BridgeSummary[] = [];

    // Local bridges.
    for (const d of this.discover()) {
      const bridge = await this.get(d.id);
      const userSettings = await this.opts.settings.get(d.id);
      results.push({
        info: bridge.info,
        settings: bridge.getSettings?.() ?? [],
        configured: Object.keys(userSettings).length > 0,
        missingRequired: await this.missingRequired(d.id),
        source: "local",
      });
    }

    // Registry-installed bridges not present locally.
    if (this.opts.registry) {
      const updates = await this.opts.registry.checkUpdates();
      const updateMap = new Map(updates.map((u) => [u.id, u.availableVersion]));

      const allInstalled = await this.opts.registry.resolveBundle("__nonexistent__")
        .then(() => [] as string[])
        .catch(() => [] as string[]);

      // Add update info to already-listed local bridges.
      for (const summary of results) {
        const av = updateMap.get(summary.info.id);
        if (av) summary.availableVersion = av;
      }
    }

    return results;
  }

  async get(id: string): Promise<LoadedBridge> {
    const cached = this.loaded.get(id);
    if (cached) return cached;

    // Check if orphaned before doing anything else.
    if (this.opts.registry && await this.opts.registry.isOrphaned(id)) {
      throw new Error(
        `bridge "${id}" is orphaned — it was installed from a registry that has been removed. ` +
        `Re-add the registry or reinstall the bridge.`,
      );
    }

    const code = await this.resolveCode(id);
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

  /** The raw stored user settings for a bridge (no defaults applied). */
  async storedSettings(id: string): Promise<Record<string, SettingValue>> {
    return (await this.opts.settings.get(id)) as Record<string, SettingValue>;
  }

  /** Required setting keys this bridge still needs before it can serve content. */
  async missingRequired(id: string): Promise<string[]> {
    const bridge = await this.get(id);
    const descriptors = bridge.getSettings?.();
    if (!descriptors || descriptors.length === 0) return [];
    const stored = await this.opts.settings.get(id);
    return resolveSettings(stored, descriptors).missingRequired;
  }

  private async resolveCode(id: string): Promise<string> {
    // 1. Registry cache takes precedence when present (verified bundle).
    if (this.opts.registry) {
      const bundlePath = await this.opts.registry.resolveBundle(id);
      if (bundlePath && existsSync(bundlePath)) return readFileSync(bundlePath, "utf8");
    }

    // 2. Fall back to locally built bundle.
    const discovered = resolveBridge(this.opts.bridgesDir, id);
    return readFileSync(discovered.bundlePath, "utf8");
  }
}
