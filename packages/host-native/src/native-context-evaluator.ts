/**
 * NativeContextEvaluator: the native BundleEvaluator.
 *
 * Unlike NodeVmEvaluator (node:vm) and FunctionEvaluator (new Function), this evaluator runs the
 * bundle in a genuinely separate JS context with its own fresh global object — real realm isolation.
 * Context creation is engine-specific, so it delegates to a native-provided global,
 * `__comical_native_eval(code)`, which the platform host (iOS JSContext child / Android QuickJS
 * context) implements: it creates the child context, injects the curated globals (see
 * `buildBridgeGlobals` in @comical/core/globals for the canonical allow-list), evaluates the CJS
 * bundle there via the engine's host API, and returns the bundle's `module.exports`.
 *
 * Because the bundle lives in its own context, a bridge's `eval`/`Function` can only reach that
 * context's curated globals — never the app's. On QuickJS the host additionally omits the `eval`
 * intrinsic, removing `eval`/`Function`-construct from bridges entirely.
 */
import type { LogCapability } from "@comical/contract";
import type { BundleEvaluator, EvaluatorResult } from "@comical/core/evaluator";

interface NativeEvalGlobal {
  /** Injected by the native host. Evaluates `code` in a fresh isolated context, returns its exports. */
  __comical_native_eval?: (code: string) => unknown;
}

export class NativeContextEvaluator implements BundleEvaluator {
  // `log` is unused here: console routing for the child context is wired natively (console →
  // _native_log), alongside the rest of the curated globals.
  evaluate(code: string, _log: LogCapability): EvaluatorResult {
    const nativeEval = (globalThis as unknown as NativeEvalGlobal).__comical_native_eval;
    if (typeof nativeEval !== "function") {
      throw new Error(
        "__comical_native_eval is not available — the native host must inject it before loading a bridge.",
      );
    }
    return { exports: nativeEval(code) };
  }
}
