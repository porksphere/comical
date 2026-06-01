/**
 * FunctionEvaluator: browser-side BundleEvaluator.
 *
 * Unlike `node:vm`, browsers have no cross-realm context API. We use the `Function` constructor
 * to create an isolated function scope and explicitly inject only the curated global allow-list
 * as named parameters. Critically, we also pass `undefined` for browser globals that could
 * otherwise leak through to the bridge (fetch, XMLHttpRequest, WebSocket, etc.), ensuring the
 * bridge can only reach the network via `host.network.request`.
 *
 * Isolation level: **function scope**, not cross-realm. The bridge cannot accidentally use
 * ambient globals because they are shadowed by `undefined` in its scope. A determined attacker
 * with `eval` access could escape — eval is not disabled here (no cross-realm context to set
 * codeGeneration on), which is a known limitation vs NodeVmEvaluator. In practice bridge bundles
 * are reviewed/checksummed before loading, which is the appropriate trust boundary for the web.
 * The Worker-based evaluator (future hardening) provides cross-realm isolation in the browser.
 */
import type { LogCapability } from "@comical/contract";
import type { BundleEvaluator, EvaluatorResult } from "@comical/core";
import { buildBridgeGlobals } from "@comical/core";
import { BridgeLoadError } from "@comical/core";

/** Browser globals to shadow (pass undefined) so the bridge can't reach them directly. */
const SHADOWED_GLOBALS = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "navigator",
  "location",
  "history",
  "document",
  "window",
  "indexedDB",
  "localStorage",
  "sessionStorage",
  "caches",
  "crypto",
  "performance",
  "Bun",
  "process",
  "require",
  "__dirname",
  "__filename",
] as const;

export class FunctionEvaluator implements BundleEvaluator {
  evaluate(code: string, log: LogCapability): EvaluatorResult {
    const allowed = buildBridgeGlobals(log);
    const allowedKeys = Object.keys(allowed);
    const allowedValues = Object.values(allowed);

    // Combine allowed globals (defined) + shadowed globals (undefined) as parameters.
    const allParams = [...allowedKeys, ...SHADOWED_GLOBALS, "module", "exports"];
    const allArgs: unknown[] = [
      ...allowedValues,
      // Pass undefined for each shadowed global to shadow them in the function scope.
      ...SHADOWED_GLOBALS.map(() => undefined),
    ];

    const moduleShim = { exports: {} as Record<string, unknown> };
    allArgs.push(moduleShim, moduleShim.exports);

    let fn: (...args: unknown[]) => void;
    try {
      // eslint-disable-next-line no-new-func
      fn = new Function(...allParams, code) as (...args: unknown[]) => void;
    } catch (cause) {
      throw new BridgeLoadError(
        `bridge bundle syntax error: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    try {
      fn(...allArgs);
    } catch (cause) {
      throw new BridgeLoadError(
        `bridge bundle failed to evaluate: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    return { exports: moduleShim.exports };
  }
}
