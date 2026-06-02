/**
 * NodeVmEvaluator: evaluates a bridge bundle in a fresh `node:vm` context.
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
import type { BundleEvaluator, EvaluatorResult } from "./evaluator.ts";
import { buildBridgeGlobals } from "./globals.ts";

export { buildBridgeGlobals };

/** A CJS module object the bundle writes its exports onto. */
interface ModuleShim {
  exports: Record<string, unknown>;
}

/**
 * Bun/Node evaluator: uses `node:vm` createContext for genuine cross-realm isolation.
 * The fresh context has no `require`, `process`, `fetch`, `Bun`, or filesystem access —
 * only the `buildBridgeGlobals` allow-list is injected.
 */
export class NodeVmEvaluator implements BundleEvaluator {
  constructor(private readonly evalTimeoutMs: number = 5000) {}

  evaluate(code: string, log: LogCapability): EvaluatorResult {
    const moduleShim: ModuleShim = { exports: {} };
    const sandbox: Record<string, unknown> = {
      module: moduleShim,
      exports: moduleShim.exports,
      ...buildBridgeGlobals(log),
    };
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox, {
      name: "comical-bridge",
      codeGeneration: { strings: false, wasm: false },
    });

    try {
      vm.runInContext(code, sandbox, {
        timeout: this.evalTimeoutMs,
        filename: "bridge.bundle.cjs",
      });
    } catch (cause) {
      throw new BridgeLoadError(
        `bridge bundle failed to evaluate: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    return { exports: moduleShim.exports };
  }
}

/** Legacy function-style export kept for any direct callers. */
export function evaluateBundle(
  code: string,
  log: LogCapability,
  evalTimeoutMs: number,
): EvaluatorResult {
  return new NodeVmEvaluator(evalTimeoutMs).evaluate(code, log);
}
