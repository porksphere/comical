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
  /**
   * True when a newer version is available in the registry AND this runtime could load it.
   * An update the loader would refuse is not an update worth offering — taking it would replace a
   * working install with a broken one.
   */
  updateAvailable: boolean;
  /**
   * Can this runtime load `entry`'s declared `contractVersion`? False means installing it is
   * refused, so a client should label the row (typically "needs a newer app") rather than offer it.
   * Listings annotate rather than filter: a hidden entry looks like a missing one.
   */
  compatible: boolean;
}

export interface AvailableTracker {
  entry: RegistryTrackerEntry;
  registryUrl: string;
  installedVersion: string | null;
  /** See {@link AvailableBridge.updateAvailable} — gated on `compatible` the same way. */
  updateAvailable: boolean;
  /** See {@link AvailableBridge.compatible}. */
  compatible: boolean;
}

export interface InstallResult {
  id: string;
  version: string;
  bundlePath: string;
}
