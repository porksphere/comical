/**
 * Wraps the native `_native_log(level, msg)` callback into core's LogCapability.
 * Shared by both platform adapters.
 */
import type { LogCapability } from "@comical/contract";

export function makeNativeLog(nativeLog: (level: string, msg: string) => void): LogCapability {
  const at = (level: string) => (...args: unknown[]) => nativeLog(level, args.map(String).join(" "));
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
