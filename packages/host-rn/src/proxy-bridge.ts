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
    bridge[method] = async (...args: unknown[]): Promise<unknown> => {
      const raw = await native.callBridge(id, method, JSON.stringify(args));
      return raw === undefined || raw === "" ? undefined : (JSON.parse(raw) as unknown);
    };
  }
  return bridge as unknown as LoadedBridge;
}
