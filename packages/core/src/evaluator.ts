/**
 * The `BundleEvaluator` interface: the one platform-specific seam inside the loader.
 *
 * A bridge bundle is pre-compiled CJS. Evaluating it safely requires a JS execution context
 * that withholds dangerous host globals — how that context is created differs per platform:
 *   - Bun/Node:  `node:vm` createContext (NodeVmEvaluator, below)
 *   - Browser:   new Function + explicit global shadowing (FunctionEvaluator in host-web)
 *   - iOS:       JavaScriptCore JSContext (M3)
 *   - Android:   QuickJS runtime (M3)
 *
 * `loadBridge` accepts an optional `evaluator`; when omitted it defaults to `NodeVmEvaluator`.
 * Swapping the evaluator is the only change needed to port the loader to a new engine.
 */
import type { LogCapability } from "@comical/contract";

export interface EvaluatorResult {
  exports: unknown;
}

export interface BundleEvaluator {
  evaluate(code: string, log: LogCapability): EvaluatorResult;
}

/**
 * Bun/Node evaluator: uses `node:vm` createContext for genuine cross-realm isolation.
 * `require`, `process`, `fetch`, `Bun`, and the filesystem are absent from the fresh realm;
 * only the curated global allow-list is injected.
 */
export { NodeVmEvaluator } from "./sandbox.ts";
