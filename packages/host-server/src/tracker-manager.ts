/**
 * Manages the lifecycle of loaded trackers on the server.
 *
 * Trackers can come from two sources:
 *   - Local: `{trackersDir}/{id}/dist/tracker.js` bundles (optional)
 *   - Registry: downloaded, verified, cached via RegistryManager (optional)
 *
 * `get(id)` tries local first, then falls back to the registry cache.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { HostCapabilities, SettingValue } from "@comical/contract";
import {
  buildRefreshConfigs,
  type LoadedTracker,
  loadTracker,
  redactSettingSecrets,
  resolveAccessToken,
  RefreshableNetwork,
  resolveSettings,
} from "@comical/core";
import { createBunHost } from "@comical/host-bun";
import type { RegistryManager } from "@comical/registry";
import type { SettingsStore } from "./settings-store.ts";
// TrackerSummary lives in the Node-free provider module (so the router can name it); import for
// local use and re-export to preserve this module's public surface.
import type { TrackerSummary } from "./tracker-provider.ts";
export type { TrackerSummary } from "./tracker-provider.ts";

export interface TrackerManagerOptions {
  trackersDir?: string | string[];
  dataDir: string;
  settings: SettingsStore;
  registry?: RegistryManager;
}

interface DiscoveredTracker {
  id: string;
  bundlePath: string;
}

// OAuth token blob parsing (`parseOAuthBlob`/`resolveAccessToken`), refresh-config building
// (`buildRefreshConfigs`), and the `RefreshableNetwork` wrapper itself now live in
// `@comical/core`'s `net/refreshable-network.ts` — shared with host-rn's embedded tracker
// provider so both hosts drive one implementation instead of duplicating the refresh-retry logic.

// ── Tracker discovery ─────────────────────────────────────────────────────────

function discoverTrackers(dirs: string | string[]): DiscoveredTracker[] {
  const dirList = Array.isArray(dirs) ? dirs : [dirs];
  const found: DiscoveredTracker[] = [];
  for (const dir of dirList) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const id of entries) {
      const bundlePath = join(dir, id, "dist", "tracker.js");
      if (existsSync(bundlePath)) found.push({ id, bundlePath });
    }
  }
  return found;
}

export class TrackerManager {
  private readonly loaded = new Map<string, LoadedTracker>();
  private discovered: DiscoveredTracker[] | undefined;

  constructor(private readonly opts: TrackerManagerOptions) {}

  refresh(): void {
    this.discovered = undefined;
    this.loaded.clear();
  }

  invalidate(id: string): void {
    this.loaded.delete(id);
  }

  private discover(): DiscoveredTracker[] {
    if (!this.discovered) {
      this.discovered = this.opts.trackersDir ? discoverTrackers(this.opts.trackersDir) : [];
    }
    return this.discovered;
  }

  async get(id: string): Promise<LoadedTracker> {
    const cached = this.loaded.get(id);
    if (cached) return cached;

    // Find the bundle — local discovery first, then registry cache.
    const found = this.discover().find((d) => d.id === id);
    let bundlePath: string | undefined = found?.bundlePath;

    if (!bundlePath && this.opts.registry) {
      const p = await this.opts.registry.resolveTrackerBundle(id);
      if (p && existsSync(p)) bundlePath = p;
    }

    if (!bundlePath) throw new Error(`tracker not found: ${id}`);

    const code = readFileSync(bundlePath, "utf8");
    const stored = (await this.opts.settings.get(id)) as Record<string, SettingValue>;

    // Unwrap oauth-pin token blobs → plain access-token strings for the tracker.
    const settingsForTracker: Record<string, SettingValue> = {};
    for (const [k, v] of Object.entries(stored)) settingsForTracker[k] = resolveAccessToken(v);

    const bunHost = createBunHost({ bridgeId: id, dataDir: join(this.opts.dataDir, "trackers", id), settings: settingsForTracker });
    const refreshable = new RefreshableNetwork(
      bunHost.network,
      async (key, blob) => {
        await this.opts.settings.patch(id, { [key]: JSON.stringify(blob) });
        this.invalidate(id);
      },
    );
    const host: HostCapabilities = { ...bunHost, network: refreshable };
    const tracker = loadTracker({ code, capabilities: host, expectedId: id });

    // Configure refresh now that we have descriptors.
    const descriptors = tracker.getSettings?.() ?? [];
    const refreshConfigs = buildRefreshConfigs(descriptors, stored, settingsForTracker);
    if (refreshConfigs.length > 0) refreshable.configure(refreshConfigs);

    this.loaded.set(id, tracker);
    return tracker;
  }

  private async summarize(id: string, source: "local" | "registry"): Promise<TrackerSummary> {
    const tracker = await this.get(id);
    const settings = tracker.getSettings?.() ?? [];
    const stored = (await this.opts.settings.get(id)) as Record<string, SettingValue>;
    const { missingRequired } = resolveSettings(stored, settings);
    const secretKeys = new Set(
      settings.filter((d) => (d.type === "string" && !!d.secret) || d.type === "oauth-pin" || d.type === "oauth-callback").map((d) => d.key),
    );
    const values: Record<string, SettingValue> = {};
    const secretsSet: string[] = [];
    for (const [k, v] of Object.entries(stored)) {
      if (secretKeys.has(k)) { if (v !== undefined && v !== "") secretsSet.push(k); }
      else values[k] = v;
    }
    return { info: tracker.info, settings: redactSettingSecrets(settings), values, secretsSet, configured: missingRequired.length === 0, missingRequired, source };
  }

  async list(): Promise<TrackerSummary[]> {
    const results: TrackerSummary[] = [];
    const localIds = new Set(this.discover().map((d) => d.id));

    // Local trackers (server-built — not uninstallable).
    for (const d of this.discover()) {
      try { results.push(await this.summarize(d.id, "local")); } catch { /* skip */ }
    }

    // Registry-installed trackers not present in a local dir (uninstallable).
    if (this.opts.registry) {
      const installed = await this.opts.registry.allInstalledTrackers();
      for (const t of installed) {
        if (localIds.has(t.id)) continue;
        try { results.push(await this.summarize(t.id, "registry")); } catch { /* skip */ }
      }
    }

    return results;
  }

  async storedSettings(id: string): Promise<Record<string, SettingValue>> {
    return (await this.opts.settings.get(id)) as Record<string, SettingValue>;
  }

  async updateSettings(id: string, patch: Record<string, SettingValue>): Promise<Record<string, SettingValue>> {
    const updated = (await this.opts.settings.patch(id, patch)) as Record<string, SettingValue>;
    this.invalidate(id);
    return updated;
  }

  async missingRequired(id: string): Promise<string[]> {
    const tracker = await this.get(id);
    const settings = tracker.getSettings?.() ?? [];
    const stored = await this.storedSettings(id);
    const { missingRequired } = resolveSettings(stored, settings);
    return missingRequired;
  }
}
