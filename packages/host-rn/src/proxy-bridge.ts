/**
 * Builds the proxy bridge the router drives. `info` + `getSettings()` are served from cached install
 * metadata (no round-trip); every content method is a thin marshaller that JSON-encodes its args,
 * calls into the native engine (`callBridge`), and parses the result. Only the methods the bridge
 * implements are attached, so the router's `if (!bridge.getX)` capability checks stay honest.
 *
 * The result is typed as `LoadedBridge` (what `BridgeProvider.get` returns) via a cast: the object is
 * a dynamic method bag, so it can't be statically shown to satisfy every optional `Bridge` method,
 * but the router only ever gates on presence then calls — exactly what this supports.
 */
import type { BridgeInfo, SettingDescriptor } from "@comical/contract";
import type { LoadedBridge } from "@comical/core/loader";
import type { NativeBridgeRuntime } from "./types.ts";

export function buildProxyBridge(
  id: string,
  info: BridgeInfo,
  settings: SettingDescriptor[],
  methods: string[],
  native: NativeBridgeRuntime,
): LoadedBridge {
  const bridge: Record<string, unknown> = {
    info,
    getSettings: () => settings,
  };
  for (const method of methods) {
    // `info` and `getSettings` are served synchronously from cached install metadata (the info object
    // and the descriptor array captured at load). A settings-bearing bridge implements `getSettings`,
    // so it appears in `methods` — without this guard the marshaller below would overwrite the sync
    // accessor with an async one that resolves to a Promise. The router reads `bridge.getSettings?.()`
    // synchronously and immediately `.filter()`s it, so a Promise there throws "undefined is not a
    // function". Never marshal these two.
    if (method === "getSettings" || method === "info") continue;
    bridge[method] = async (...args: unknown[]): Promise<unknown> => {
      const raw = await native.callBridge(id, method, JSON.stringify(args));
      // `callBridge` honors a `Promise<string>` contract of valid JSON — a void method serializes to
      // "null" (see host-native `comical_call`). An empty/absent result is void. The literal string
      // "undefined" is ONLY defensively tolerated for an older native harness that mis-serialized a
      // void return (pre-fix) — never produced now. Everything else is parsed, INCLUDING "null",
      // which must round-trip to a real `null` (e.g. getLibrary's "no library store") — so it is not
      // special-cased here.
      if (raw == null || raw === "" || raw === "undefined") return undefined;
      return JSON.parse(raw) as unknown;
    };
  }
  return bridge as unknown as LoadedBridge;
}
