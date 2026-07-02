/**
 * The registry-management surface the router depends on — extracted as a Node-free interface so
 * `router.ts` can be consumed without dragging in `@comical/registry`'s barrel (which re-exports
 * `manager.ts`, importing `node:fs`).
 *
 * The server's `RegistryManager` satisfies this structurally. A non-Node host that doesn't offer
 * registry-management endpoints simply omits `RouterOptions.registry`. Mirrors `BridgeProvider`.
 */
import type { AvailableBridge, AvailableTracker, InstallResult } from "@comical/registry/available";
import type { SavedRegistry } from "@comical/registry/schema";

/** One row of `checkUpdates`/`checkTrackerUpdates`. */
export interface RegistryUpdate {
  id: string;
  installedVersion: string;
  availableVersion: string;
}

/** The registry-manager methods `createRouter` calls. `RegistryManager` satisfies this structurally. */
export interface RegistryProvider {
  list(): Promise<SavedRegistry[]>;
  add(rawUrl: string, opts?: { requireSignature?: boolean }): Promise<SavedRegistry>;
  remove(rawUrl: string): Promise<void>;
  browse(rawUrl: string): Promise<AvailableBridge[]>;
  browseAll(): Promise<AvailableBridge[]>;
  install(registryUrl: string, bridgeId: string): Promise<InstallResult>;
  update(bridgeId: string): Promise<InstallResult>;
  uninstall(bridgeId: string): Promise<void>;
  checkUpdates(): Promise<RegistryUpdate[]>;
  browseTrackers(rawUrl: string): Promise<AvailableTracker[]>;
  browseAllTrackers(): Promise<AvailableTracker[]>;
  installTracker(registryUrl: string, trackerId: string): Promise<InstallResult>;
  updateTracker(trackerId: string): Promise<InstallResult>;
  uninstallTracker(trackerId: string): Promise<void>;
  checkTrackerUpdates(): Promise<RegistryUpdate[]>;
}
