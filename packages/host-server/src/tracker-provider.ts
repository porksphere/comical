/**
 * The tracker-management surface the router depends on — extracted as a Node-free interface so
 * `router.ts` can be consumed without dragging in `tracker-manager.ts` (which imports `node:fs`
 * and the Bun host). The server's `TrackerManager` satisfies this structurally. Mirrors
 * `BridgeProvider`; a host without tracker support omits `RouterOptions.trackers`.
 */
import type { SettingDescriptor, SettingValue, TrackerInfo } from "@comical/contract";
import type { LoadedTracker } from "@comical/core/tracker-loader";

export interface TrackerSummary {
  info: TrackerInfo;
  settings: SettingDescriptor[];
  values: Record<string, SettingValue>;
  secretsSet: string[];
  configured: boolean;
  missingRequired: string[];
}

/** The tracker-manager methods `createRouter` calls. `TrackerManager` satisfies this structurally. */
export interface TrackerProvider {
  list(): Promise<TrackerSummary[]>;
  /** Load (or return cached) a tracker; throws an Error whose message includes "not found" for unknown ids. */
  get(id: string): Promise<LoadedTracker>;
  storedSettings(id: string): Promise<Record<string, SettingValue>>;
  updateSettings(id: string, patch: Record<string, SettingValue>): Promise<Record<string, SettingValue>>;
  invalidate(id: string): void;
}
