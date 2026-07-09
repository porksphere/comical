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
import { NativeContextEvaluator } from "./native-context-evaluator.ts";

export type MakeHost = (settings: ResolvedSettings) => HostCapabilities;

interface HarnessGlobal {
  comical_bridge?: LoadedBridge | null;
  /** networkJSON is an optional GatedNetworkOptions object (rate-limit overrides, etc). */
  comical_init?: (code: string, settingsJSON?: string, networkJSON?: string) => string | null;
  comical_call?: (method: string, argsJSON?: string) => Promise<string>;
}

export function installComicalHarness(makeHost: MakeHost): void {
  const g = globalThis as unknown as HarnessGlobal;
  const evaluator = new NativeContextEvaluator();
  let bridge: LoadedBridge | null = null;

  g.comical_init = (code, settingsJSON, networkJSON) => {
    const settings = (settingsJSON ? JSON.parse(settingsJSON) : {}) as Record<string, SettingValue>;
    const network = networkJSON ? JSON.parse(networkJSON) : undefined;
    // The per-method call timeout schedules a setTimeout; on Android's quickjs-kt the JS event loop
    // won't return from `evaluate` until that (uncancelled) timer coroutine drains, so EVERY method
    // stalls for the full timeout. Hosts on such engines set `__comical_disable_call_timeout` — the
    // network layer (OkHttp/URLSession) still bounds request duration. JSC (iOS) keeps the timeout.
    const disableCallTimeout =
      (globalThis as unknown as { __comical_disable_call_timeout?: boolean }).__comical_disable_call_timeout === true;
    bridge = loadBridge({
      code,
      capabilities: makeHost(settings),
      evaluator,
      network,
      ...(disableCallTimeout ? { limits: { callTimeoutMs: 0 } } : {}),
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
}
