/**
 * Startup wiring for the embedded runtime.
 *
 * `configureEmbeddedRuntime` is called once at app launch with the pieces that come from the built
 * comical packages — `@comical/host-server`'s `createRouter` and `@comical/registry`'s fetcher — plus
 * the registry index URL, the embedder's `setTransport`, and its `SettingsStore`. Keeping these
 * injected is what lets this package stay free of the app and of `expo`/RN imports.
 *
 * `applyEmbeddedMode(enabled)` installs or removes the embedded transport accordingly. It's safe to
 * call before `configureEmbeddedRuntime` or when the native runtime is absent (web) — it simply
 * ensures the remote transport stays active and returns false.
 */
import { installEmbeddedTransport, uninstallEmbeddedTransport } from "./install.ts";
import { isEmbeddedRuntimeAvailable } from "./native-runtime.ts";
import { MultiRegistryBundleSource } from "./registry-bundle-source.ts";
import type { BundleCache, RegistryFetcher } from "./registry-bundle-source.ts";
import type { CreateRouter, EmbeddedTransport, SettingsStore } from "./types.ts";

export interface EmbeddedBootstrapConfig {
  /** `@comical/host-server`'s `createRouter` (from the built package), cast to `CreateRouter`. */
  createRouter: CreateRouter;
  /** `@comical/registry`'s `{ fetchIndex, downloadBundle }` (from the built package). */
  fetcher: RegistryFetcher;
  /** Absolute URLs of the registry `index.json`s bridges are downloaded from (user-managed). */
  indexUrls: string[];
  /** The embedder's transport setter (its `api.ts`'s `setTransport`). */
  setTransport: (transport: EmbeddedTransport | null) => void;
  /** Per-bridge settings persistence (AsyncStorage-backed in an app). */
  settings: SettingsStore;
  /** Refuse unsigned bundles (default false — SHA-256 integrity is always enforced). */
  requireSignature?: boolean;
  /** Persistent bundle cache (defaults to in-memory; an expo-file-system adapter is a follow-up). */
  cache?: BundleCache;
  networkJson?: string;
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
  const bundles = new MultiRegistryBundleSource({
    indexUrls: config.indexUrls,
    fetcher: config.fetcher,
    ...(config.cache ? { cache: config.cache } : {}),
    ...(config.requireSignature !== undefined ? { requireSignature: config.requireSignature } : {}),
  });
  return installEmbeddedTransport({
    createRouter: config.createRouter,
    bundles,
    settings: config.settings,
    setTransport: config.setTransport,
    ...(config.networkJson !== undefined ? { networkJson: config.networkJson } : {}),
  });
}
