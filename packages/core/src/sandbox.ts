/**
 * Builds the isolated execution context for a bridge bundle.
 *
 * The bundle is emitted as self-contained CJS (`bun build --format=cjs`), so the only host
 * objects it needs are `module`/`exports` plus a curated set of benign, pure globals. A fresh
 * `node:vm` context already withholds `require`, `process`, `fetch`, `Bun`, and the filesystem —
 * we simply never add them back. Network/storage reach the bridge ONLY via the host capabilities
 * passed to its factory, never through ambient globals.
 */
import vm from "node:vm";
import type { LogCapability } from "@comical/contract";
import { BridgeLoadError } from "./errors.ts";

export interface SandboxResult {
  /** Whatever the bundle assigned to `module.exports`. */
  exports: unknown;
}

/** A CJS module object the bundle writes its exports onto. */
interface ModuleShim {
  exports: Record<string, unknown>;
}

/**
 * The allow-list of ambient globals exposed to bridge code. All are pure/standalone (no I/O)
 * except `console`, which is routed to the bridge's log capability. Standard ECMAScript globals
 * (Object, Array, JSON, Math, Promise, Map, Set, Date, RegExp, …) come from the vm realm itself.
 */
function buildGlobals(log: LogCapability): Record<string, unknown> {
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

/**
 * Evaluate `code` in a fresh sandbox and return its `module.exports`.
 * @throws {BridgeLoadError} if evaluation fails or exceeds `evalTimeoutMs`.
 */
export function evaluateBundle(
  code: string,
  log: LogCapability,
  evalTimeoutMs: number,
): SandboxResult {
  const moduleShim: ModuleShim = { exports: {} };
  const sandbox: Record<string, unknown> = {
    module: moduleShim,
    exports: moduleShim.exports,
    ...buildGlobals(log),
  };
  // Self-reference so bundles that touch `globalThis` see the sandbox, not the host realm.
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox, {
    name: "comical-bridge",
    codeGeneration: { strings: false, wasm: false },
  });

  try {
    vm.runInContext(code, sandbox, {
      timeout: evalTimeoutMs,
      filename: "bridge.bundle.cjs",
    });
  } catch (cause) {
    throw new BridgeLoadError(
      `bridge bundle failed to evaluate: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  return { exports: moduleShim.exports };
}
