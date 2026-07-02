/**
 * The bridge-management surface the router depends on — extracted as a Node-free interface so
 * `router.ts` can be consumed without dragging in `bridge-manager.ts` (which imports `node:fs`,
 * `node:path`, and the Bun host).
 *
 * The server's `BridgeManager` implements this by loading bundles from disk/registry; comical-app's
 * on-device runtime implements it with a proxy provider whose `get(id)` returns a `LoadedBridge`
 * whose methods marshal to a native JS engine (JSC/QuickJS). Both drive the same router.
 */
import type { BridgeInfo, SettingDescriptor, SettingValue } from "@comical/contract";
import type { LoadedBridge } from "@comical/core/loader";

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

/** The manager methods `createRouter` calls. `BridgeManager` satisfies this structurally. */
export interface BridgeProvider {
  /** All installed bridges with their configured status (for `GET /bridges`). */
  list(): Promise<BridgeSummary[]>;
  /** Load (or return cached) a bridge; throws an Error whose message includes "not found" for unknown ids. */
  get(id: string): Promise<LoadedBridge>;
  /** Required setting keys still unset for a bridge — empty means it can serve content. */
  missingRequired(id: string): Promise<string[]>;
  /** The bridge's persisted settings map (used to read reserved keys like excluded-tags). */
  storedSettings(id: string): Promise<Record<string, SettingValue>>;
  /** Persist a validated settings patch; returns the merged settings. */
  updateSettings(id: string, values: Record<string, SettingValue>): Promise<Record<string, SettingValue>>;
  /** Drop a bridge's cached instance (e.g. after a settings change or registry update). */
  invalidate(id: string): void;
  /** Forget discovered-bridge state so the next call re-scans (e.g. after install/uninstall). */
  refresh(): void;
}
