/**
 * The allow-list of ambient globals injected into a bridge sandbox, shared by every evaluator
 * (NodeVmEvaluator, host-web FunctionEvaluator, the native JSC/QuickJS harness). All are pure /
 * standalone (no I/O) except `console`, which is routed to the bridge's log capability. Standard
 * ECMAScript globals (Object, Array, JSON, Math, Promise, Map, Set, …) come from the realm itself.
 *
 * This module is intentionally free of any platform/Node dependency so it can be bundled for the
 * browser and native engines.
 */
import type { LogCapability } from "@comical/contract";

export function buildBridgeGlobals(log: LogCapability): Record<string, unknown> {
  const sandboxConsole = {
    log: (...a: unknown[]) => log.info(...a),
    info: (...a: unknown[]) => log.info(...a),
    debug: (...a: unknown[]) => log.debug(...a),
    warn: (...a: unknown[]) => log.warn(...a),
    error: (...a: unknown[]) => log.error(...a),
  };
  return {
    console: sandboxConsole,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    atob,
    btoa,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    structuredClone,
  };
}
