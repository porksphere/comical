/**
 * Holds the on-device bridge engine — a native module wrapping `ComicalBridgeContext` (JSC on iOS,
 * QuickJS on Android). This package stays free of `expo`/RN imports, so the runtime is *injected*:
 * the app resolves its native module (e.g. Expo's `requireOptionalNativeModule('ComicalRuntime')`)
 * and calls `setNativeBridgeRuntime`. Absent on web and until the native module is built, the runtime
 * is null and the app stays on the remote transport.
 */
import type { NativeBridgeRuntime, NativeTrackerRuntime } from "./types.ts";

let runtime: NativeBridgeRuntime | null = null;
let trackerRuntime: NativeTrackerRuntime | null = null;

/** Register (or clear, with `null`) the native bridge runtime. Call once at app launch on native. */
export function setNativeBridgeRuntime(rt: NativeBridgeRuntime | null): void {
  runtime = rt;
}

export function getNativeBridgeRuntime(): NativeBridgeRuntime | null {
  return runtime;
}

/** True when bridges can run on-device (a native runtime has been registered). */
export function isEmbeddedRuntimeAvailable(): boolean {
  return runtime !== null;
}

/** Register (or clear, with `null`) the native tracker runtime. Separate from the bridge runtime —
 *  an older native build may ship bridge support without tracker support (see ComicalTrackerContext,
 *  a purely-additive native addition), so absence here just leaves `EmbeddedTrackerProvider` unused. */
export function setNativeTrackerRuntime(rt: NativeTrackerRuntime | null): void {
  trackerRuntime = rt;
}

export function getNativeTrackerRuntime(): NativeTrackerRuntime | null {
  return trackerRuntime;
}
