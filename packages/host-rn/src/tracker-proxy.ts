/**
 * Builds the proxy tracker the router drives — parallel to `proxy-bridge.ts`'s `buildProxyBridge`.
 * `info` + `getSettings()` are served from cached load metadata (no round-trip); every other method
 * is a thin marshaller that JSON-encodes its args, calls into the native engine (`callTracker`), and
 * parses the result. Only the methods the tracker implements are attached, so the router's
 * `if (!tracker.getLibrary)` capability checks stay honest.
 *
 * The result is typed as `LoadedTracker` (what `TrackerProvider.get` returns) via a cast, for the
 * same reason `buildProxyBridge` casts to `LoadedBridge`: the object is a dynamic method bag.
 */
import type { SettingDescriptor, TrackerInfo } from "@comical/contract";
import type { LoadedTracker } from "@comical/core/tracker-loader";
import type { NativeTrackerRuntime } from "./types.ts";

export interface ProxyTrackerHooks {
  /**
   * Invoked after every `callTracker` settles (success or throw) — lets the caller poll
   * `drainTrackerSettingsPatch` and persist a refreshed OAuth token without threading a
   * `SettingsStore` into this otherwise-pure marshalling module. See `EmbeddedTrackerProvider`,
   * which is the only caller that supplies this. Kept optional so `tracker-proxy.test.ts` can build
   * a proxy without a settings store.
   */
  afterCall?: () => void | Promise<void>;
}

export function buildProxyTracker(
  id: string,
  info: TrackerInfo,
  settings: SettingDescriptor[],
  methods: string[],
  native: NativeTrackerRuntime,
  hooks?: ProxyTrackerHooks,
): LoadedTracker {
  const tracker: Record<string, unknown> = {
    info,
    getSettings: () => settings,
  };
  for (const method of methods) {
    // Same guard as buildProxyBridge: getSettings is served synchronously from the cached
    // descriptor array captured at load — never overwrite it with an async marshaller.
    if (method === "getSettings" || method === "info") continue;
    tracker[method] = async (...args: unknown[]): Promise<unknown> => {
      try {
        const raw = await native.callTracker(id, method, JSON.stringify(args));
        // Same `Promise<string>`-of-valid-JSON contract as buildProxyBridge — see its comment for the
        // void/"null" distinction this preserves (e.g. getLibrary's page-not-found vs. a real null).
        if (raw == null || raw === "" || raw === "undefined") return undefined;
        return JSON.parse(raw) as unknown;
      } finally {
        // Runs even on throw: a call can refresh the token and still fail for an unrelated reason
        // (or fail on the retry itself) — either way, a refreshed token is real and must be persisted.
        await hooks?.afterCall?.();
      }
    };
  }
  return tracker as unknown as LoadedTracker;
}
