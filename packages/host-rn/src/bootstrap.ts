/**
 * Startup wiring for the embedded runtime.
 *
 * `configureEmbeddedRuntime` is called once at app launch with the pieces that come from the built
 * comical packages — `@comical/host-server`'s `createRouter` and `@comical/registry`'s fetcher — plus
 * the app's persistence (the saved-registry list, the installed-bridge manifest, per-bridge
 * settings), the embedder's `setTransport`, and a change callback. Keeping these injected is what
 * lets this package stay free of the app and of `expo`/RN imports.
 *
 * `applyEmbeddedMode(enabled)` installs or removes the embedded transport accordingly. It's safe to
 * call before `configureEmbeddedRuntime` or when the native runtime is absent (web) — it simply
 * ensures the remote transport stays active and returns false.
 */
import { installEmbeddedTransport, uninstallEmbeddedTransport } from "./install.ts";
import { isEmbeddedRuntimeAvailable } from "./native-runtime.ts";
import type { BundleCache, RegistryFetcher } from "./registry-bundle-source.ts";
import type {
  CreateRouter,
  EmbeddedTransport,
  InstalledStore,
  SavedRegistryStore,
  SettingsStore,
} from "./types.ts";

export interface EmbeddedBootstrapConfig {
  /** `@comical/host-server`'s `createRouter` (from the built package), cast to `CreateRouter`. */
  createRouter: CreateRouter;
  /** `@comical/registry`'s `{ fetchIndex, downloadBundle }` (from the built package). */
  fetcher: RegistryFetcher;
  /** The installed-bridge manifest (AsyncStorage-backed) — only installed bridges load. */
  installed: InstalledStore;
  /** The saved-registry list (AsyncStorage-backed). */
  registries: SavedRegistryStore;
  /** The embedder's transport setter (its `api.ts`'s `setTransport`). */
  setTransport: (transport: EmbeddedTransport | null) => void;
  /** Per-bridge settings persistence (AsyncStorage-backed in an app). */
  settings: SettingsStore;
  /** Refuse unsigned bundles (default false — SHA-256 integrity is always enforced). */
  requireSignature?: boolean;
  /** Persistent bundle cache (defaults to in-memory; an expo-file-system adapter is a follow-up). */
  cache?: BundleCache;
  networkJson?: string;
  /** Fired after an install/update/uninstall so the embedder can refetch data screens. */
  onRegistryChange?: () => void;
}

let config: EmbeddedBootstrapConfig | null = null;

/** Register the injected runtime dependencies. Call once at app launch (native entry only). */
export function configureEmbeddedRuntime(next: EmbeddedBootstrapConfig): void {
  config = next;
}

/**
 * Install the embedded transport when `enabled` (and configured + available), else restore remote.
 * @returns true if the embedded transport is now active.
 */
export function applyEmbeddedMode(enabled: boolean): boolean {
  if (!enabled || !config || !isEmbeddedRuntimeAvailable()) {
    uninstallEmbeddedTransport();
    return false;
  }
  return installEmbeddedTransport({
    createRouter: config.createRouter,
    fetcher: config.fetcher,
    installed: config.installed,
    registries: config.registries,
    settings: config.settings,
    setTransport: config.setTransport,
    ...(config.cache ? { cache: config.cache } : {}),
    ...(config.requireSignature !== undefined ? { requireSignature: config.requireSignature } : {}),
    ...(config.networkJson !== undefined ? { networkJson: config.networkJson } : {}),
    ...(config.onRegistryChange ? { onRegistryChange: config.onRegistryChange } : {}),
  });
}
