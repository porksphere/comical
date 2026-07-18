/**
 * The `BundleEvaluator` interface: the one platform-specific seam inside the loader.
 *
 * A bridge bundle is pre-compiled CJS. Evaluating it safely requires a JS execution context
 * that withholds dangerous host globals — how that context is created differs per platform:
 *   - Bun/Node:  `node:vm` createContext (NodeVmEvaluator, below)
 *   - Browser:   new Function + explicit global shadowing
 *   - iOS:       JavaScriptCore JSContext (M3)
 *   - Android:   QuickJS runtime (M3)
 *
 * `loadBridge` accepts an optional `evaluator`; when omitted it uses the registered default
 * (`NodeVmEvaluator`, wired by the core barrel). Swapping the evaluator is the only change needed
 * to port the loader to a new engine.
 *
 * This module is pure types (no `node:vm`), so non-Node targets can import it freely.
 * `NodeVmEvaluator` itself is exported from `./sandbox.ts` (and re-exported by the core barrel).
 */
import type { LogCapability } from "@comical/contract";

export interface EvaluatorResult {
  exports: unknown;
}

export interface BundleEvaluator {
  evaluate(code: string, log: LogCapability): EvaluatorResult;
}
