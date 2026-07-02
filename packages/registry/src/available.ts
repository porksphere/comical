/**
 * Registry install-status view types — the shapes `RegistryManager` returns from its browse/install
 * methods. Kept in their own Node-free module (they reference only zod-inferred `schema.ts` types) so
 * the host-server router's `RegistryProvider` interface can name them without importing `manager.ts`,
 * which pulls `node:fs`. See `@comical/host-server`'s `registry-provider.ts`.
 */
import type { RegistryBridgeEntry, RegistryTrackerEntry } from "./schema.ts";

export interface AvailableBridge {
  entry: RegistryBridgeEntry;
  registryUrl: string;
  /** Installed version, if any. null = not installed. */
  installedVersion: string | null;
  /** True when a newer version is available in the registry. */
  updateAvailable: boolean;
}

export interface AvailableTracker {
  entry: RegistryTrackerEntry;
  registryUrl: string;
  installedVersion: string | null;
  updateAvailable: boolean;
}

export interface InstallResult {
  id: string;
  version: string;
  bundlePath: string;
}
