/**
 * Manages the lifecycle of loaded trackers on the server.
 *
 * Trackers are scanned from `{trackersDir}/{id}/dist/tracker.js` bundles — the same layout
 * used by bridges in their own repos. Each is loaded once and cached; `get(id)` throws if the
 * id is unknown or the bundle fails to load.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SettingDescriptor, SettingValue, TrackerInfo } from "@comical/contract";
import { type LoadedTracker, loadTracker, resolveSettings } from "@comical/core";
import { createBunHost } from "@comical/host-bun";
import type { SettingsStore } from "./settings-store.ts";

export interface TrackerManagerOptions {
  trackersDir: string | string[];
  dataDir: string;
  settings: SettingsStore;
}

export interface TrackerSummary {
  info: TrackerInfo;
  settings: SettingDescriptor[];
  configured: boolean;
  missingRequired: string[];
}

interface DiscoveredTracker {
  id: string;
  bundlePath: string;
}

function discoverTrackers(dirs: string | string[]): DiscoveredTracker[] {
  const dirList = Array.isArray(dirs) ? dirs : [dirs];
  const found: DiscoveredTracker[] = [];
  for (const dir of dirList) {
    if (!existsSync(dir)) continue;
    // Each subdir is a tracker id; look for dist/tracker.js inside it.
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

  invalidate(id: string): void {
    this.loaded.delete(id);
  }

  private discover(): DiscoveredTracker[] {
    if (!this.discovered) this.discovered = discoverTrackers(this.opts.trackersDir);
    return this.discovered;
  }

  async get(id: string): Promise<LoadedTracker> {
    const cached = this.loaded.get(id);
    if (cached) return cached;

    const found = this.discover().find((d) => d.id === id);
    if (!found) throw new Error(`tracker not found: ${id}`);

    const code = readFileSync(found.bundlePath, "utf8");
    const stored = (await this.opts.settings.get(id)) as Record<string, SettingValue>;
    const host = createBunHost({ bridgeId: id, dataDir: join(this.opts.dataDir, "trackers", id), settings: stored });
    const tracker = loadTracker({ code, capabilities: host, expectedId: id });
    this.loaded.set(id, tracker);
    return tracker;
  }

  async list(): Promise<TrackerSummary[]> {
    const results: TrackerSummary[] = [];
    for (const d of this.discover()) {
      try {
        const tracker = await this.get(d.id);
        const settings = tracker.getSettings?.() ?? [];
        const stored = (await this.opts.settings.get(d.id)) as Record<string, SettingValue>;
        const { missingRequired } = resolveSettings(stored, settings);
        results.push({
          info: tracker.info,
          settings,
          configured: missingRequired.length === 0,
          missingRequired,
        });
      } catch {
        // skip trackers that fail to load
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
