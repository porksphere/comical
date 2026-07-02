/**
 * Install/remove the embedded transport. The embedder supplies `setTransport` (its `api.ts`'s
 * transport setter) so this package never imports the app; passing `null` there restores the app's
 * remote transport.
 *
 * `installEmbeddedTransport` builds the proxy `BridgeProvider` + the reused-router transport and makes
 * it active, so browse/search/reader resolve on-device with no external server. It's a no-op when the
 * native engine is unavailable (web, or before the native module ships), so calling it unconditionally
 * at startup is safe — the app simply stays remote.
 */
import { getNativeBridgeRuntime } from "./native-runtime.ts";
import { EmbeddedBridgeProvider } from "./provider.ts";
import { createEmbeddedTransport } from "./transport.ts";
import type { BundleSource, CreateRouter, EmbeddedTransport, SettingsStore } from "./types.ts";

export interface EmbeddedRuntimeConfig {
  /** `@comical/host-server`'s `createRouter` (from the built package), cast to `CreateRouter`. */
  createRouter: CreateRouter;
  /** Supplies installed bridges + their bundle code (registry-download-backed in v1). */
  bundles: BundleSource;
  /** Per-bridge settings persistence (AsyncStorage-backed in an app). */
  settings: SettingsStore;
  /** The embedder's transport setter — passed the embedded transport (or `null` to restore remote). */
  setTransport: (transport: EmbeddedTransport | null) => void;
  /** Optional GatedNetworkOptions overrides forwarded into each bridge load. */
  networkJson?: string;
}

let provider: EmbeddedBridgeProvider | null = null;
let activeSetTransport: ((transport: EmbeddedTransport | null) => void) | null = null;

/**
 * Install the embedded transport via the supplied `setTransport`.
 * @returns true if installed, false if the native runtime is unavailable (stayed remote).
 */
export function installEmbeddedTransport(config: EmbeddedRuntimeConfig): boolean {
  const native = getNativeBridgeRuntime();
  if (!native) return false;
  provider = new EmbeddedBridgeProvider({
    native,
    bundles: config.bundles,
    settings: config.settings,
    ...(config.networkJson !== undefined ? { networkJson: config.networkJson } : {}),
  });
  activeSetTransport = config.setTransport;
  config.setTransport(createEmbeddedTransport(provider, config.createRouter));
  return true;
}

/** Restore the remote transport and tear down native bridge contexts. */
export function uninstallEmbeddedTransport(): void {
  provider?.refresh();
  provider = null;
  activeSetTransport?.(null);
}
