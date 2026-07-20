/**
 * The shared native runtime glue. Installs the `comical_*` globals the platform hosts call
 * (Swift/Kotlin), backed by the shared @comical/core loader and the NativeContextEvaluator.
 *
 * This replaces the old hand-written harness shims: instead of calling the bridge factory directly
 * (skipping rate limiting, settings enforcement, contract checks, timeouts, caching), every call
 * now goes through `loadBridge`, so native behaves identically to the server/web hosts.
 *
 * `makeHost` is the platform capability adapter (callback-style for iOS, async for Android).
 */
import type { HostCapabilities, ResolvedSettings, SettingValue } from "@comical/contract";
import { loadBridge, type LoadedBridge } from "@comical/core/loader";
import { loadTracker, type LoadedTracker } from "@comical/core/tracker-loader";
import {
  buildRefreshConfigs,
  type OAuthTokenBlob,
  RefreshableNetwork,
  resolveAccessToken,
} from "@comical/core/net/refreshable-network";
import { NativeContextEvaluator } from "./native-context-evaluator.ts";

export type MakeHost = (settings: ResolvedSettings) => HostCapabilities;

interface HarnessGlobal {
  comical_bridge?: LoadedBridge | null;
  /** networkJSON is an optional GatedNetworkOptions object (rate-limit overrides, etc). */
  comical_init?: (code: string, settingsJSON?: string, networkJSON?: string) => string | null;
  comical_call?: (method: string, argsJSON?: string) => Promise<string>;

  comical_tracker?: LoadedTracker | null;
  /** Same shape as comical_init, but `settingsJSON` carries the RAW stored values (oauth-pin/
   *  oauth-callback keys may be JSON token blobs, not plain access-token strings) — this function
   *  unwraps them itself before handing them to the tracker, mirroring `TrackerManager.get()`. */
  comical_init_tracker?: (code: string, settingsJSON?: string, networkJSON?: string) => string | null;
  comical_call_tracker?: (method: string, argsJSON?: string) => Promise<string>;
  /**
   * Drains the OAuth token blob (if any) refreshed by the tracker's most recent call(s), as JSON
   * `{ key: string, blob: OAuthTokenBlob }`, or `null` if nothing has refreshed since the last
   * drain. The native side polls this after every `comical_call_tracker` and persists a non-null
   * result back through the settings store — the sandboxed context has no other channel to write
   * durable state outside itself (see `EmbeddedTrackerProvider`/`NativeTrackerRuntime.callTracker`).
   */
  comical_drain_tracker_patch?: () => string | null;
}

/** See the comment on `comical_init`'s body — shared by the tracker init path too. */
function disableCallTimeout(): boolean {
  return (
    (globalThis as unknown as { __comical_disable_call_timeout?: boolean }).__comical_disable_call_timeout === true
  );
}

export function installComicalHarness(makeHost: MakeHost): void {
  const g = globalThis as unknown as HarnessGlobal;
  const evaluator = new NativeContextEvaluator();
  let bridge: LoadedBridge | null = null;
  let tracker: LoadedTracker | null = null;
  let pendingTrackerPatch: { key: string; blob: OAuthTokenBlob } | null = null;

  g.comical_init = (code, settingsJSON, networkJSON) => {
    const settings = (settingsJSON ? JSON.parse(settingsJSON) : {}) as Record<string, SettingValue>;
    const network = networkJSON ? JSON.parse(networkJSON) : undefined;
    // The per-method call timeout schedules a setTimeout; on Android's quickjs-kt the JS event loop
    // won't return from `evaluate` until that (uncancelled) timer coroutine drains, so EVERY method
    // stalls for the full timeout. Hosts on such engines set `__comical_disable_call_timeout` — the
    // network layer (OkHttp/URLSession) still bounds request duration. JSC (iOS) keeps the timeout.
    bridge = loadBridge({
      code,
      capabilities: makeHost(settings),
      evaluator,
      network,
      ...(disableCallTimeout() ? { limits: { callTimeoutMs: 0 } } : {}),
    });
    g.comical_bridge = bridge;
    return JSON.stringify(bridge.info);
  };

  g.comical_call = async (method, argsJSON) => {
    if (!bridge) throw new Error("bridge not initialised — call comical_init first");
    const args = (argsJSON ? JSON.parse(argsJSON) : []) as unknown[];
    const fn = (bridge as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") throw new Error(`bridge has no method: ${method}`);
    const result = await (fn as (...a: unknown[]) => unknown).apply(bridge, args);
    // Honor the `Promise<string>` contract for EVERY result. A void method (addFavorite,
    // removeFavorite, addToLibrary, putBridgeSettings, recordChapterProgress, …) resolves to
    // `undefined`, and `JSON.stringify(undefined)` is the VALUE `undefined` — not a string — which
    // the native layer then coerces to the literal string "undefined", an invalid-JSON payload the
    // caller's `JSON.parse` chokes on ("Unexpected character 'u'"). `?? null` makes void serialize as
    // the valid JSON `null` instead; a method that legitimately returns null is unchanged.
    return JSON.stringify(result ?? null);
  };

  // ── Trackers (AniList/MAL-style) ────────────────────────────────────────────────────────────
  // Parallel to the bridge globals above, added purely additively — no existing bridge behavior
  // changes. `loadTracker` "mirrors loadBridge exactly" (see tracker-loader.ts's own doc comment),
  // so the shape here mirrors comical_init/comical_call closely; the one addition is wrapping the
  // tracker's network capability with `RefreshableNetwork` (shared with host-server's
  // TrackerManager — see @comical/core/net/refreshable-network) so an expired OAuth access token
  // is silently refreshed rather than surfacing a 401 to the tracker's own method logic.

  g.comical_init_tracker = (code, settingsJSON, networkJSON) => {
    // Raw, as-stored values — may include JSON token-blob strings for oauth-pin/oauth-callback
    // keys (`{access, refresh, expiresAt}`), never the plain access token. Needed both to unwrap
    // (below) and to build the refresh configs (which read the blob's `refresh` token).
    const stored = (settingsJSON ? JSON.parse(settingsJSON) : {}) as Record<string, SettingValue>;
    const network = networkJSON ? JSON.parse(networkJSON) : undefined;

    const settingsForTracker: Record<string, SettingValue> = {};
    for (const [k, v] of Object.entries(stored)) settingsForTracker[k] = resolveAccessToken(v);

    const rawHost = makeHost(settingsForTracker);
    const refreshable = new RefreshableNetwork(rawHost.network, async (key, blob) => {
      // No channel exists from inside this sandboxed context to the RN-level settings store — buffer
      // the refreshed blob for the native side to pick up (see comical_drain_tracker_patch) and
      // persist through `EmbeddedTrackerProvider`/its `SettingsStore`, exactly as `TrackerManager`'s
      // own `onRefreshed` callback persists it server-side.
      pendingTrackerPatch = { key, blob };
    });
    const host: HostCapabilities = { ...rawHost, network: refreshable };

    tracker = loadTracker({
      code,
      capabilities: host,
      evaluator,
      network,
      ...(disableCallTimeout() ? { limits: { callTimeoutMs: 0 } } : {}),
    });
    g.comical_tracker = tracker;

    const descriptors = tracker.getSettings?.() ?? [];
    const refreshConfigs = buildRefreshConfigs(descriptors, stored, settingsForTracker);
    if (refreshConfigs.length > 0) refreshable.configure(refreshConfigs);

    return JSON.stringify(tracker.info);
  };

  g.comical_call_tracker = async (method, argsJSON) => {
    if (!tracker) throw new Error("tracker not initialised — call comical_init_tracker first");
    const args = (argsJSON ? JSON.parse(argsJSON) : []) as unknown[];
    const fn = (tracker as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") throw new Error(`tracker has no method: ${method}`);
    const result = await (fn as (...a: unknown[]) => unknown).apply(tracker, args);
    // Same void → JSON "null" contract as comical_call — see its comment above.
    return JSON.stringify(result ?? null);
  };

  g.comical_drain_tracker_patch = () => {
    if (!pendingTrackerPatch) return null;
    const patch = pendingTrackerPatch;
    pendingTrackerPatch = null;
    return JSON.stringify(patch);
  };
}
