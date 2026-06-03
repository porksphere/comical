/**
 * `@comical/core` — the portable runtime. No platform APIs: it loads bridges, sandboxes them,
 * gates their capabilities, and validates their output. Hosts supply the actual capabilities.
 */
export * from "./errors.ts";
export * from "./loader.ts";
export * from "./validation.ts";
export * from "./settings.ts";
export * from "./net/rate-limiter.ts";
export * from "./net/cache.ts";
export * from "./net/gated-network.ts";
export * from "./evaluator.ts";
export * from "./globals.ts";
export { evaluateBundle, NodeVmEvaluator } from "./sandbox.ts";
export { withTimeout, errorMessage } from "./util.ts";

// Importing the core barrel is the Node/Bun entry: register node:vm as the default evaluator so
// existing callers (host-bun, host-server, CLI, tests) keep zero-config bridge loading. Non-Node
// hosts import `@comical/core/loader` instead and pass their own evaluator — never pulling node:vm.
import { setDefaultEvaluator } from "./loader.ts";
import { NodeVmEvaluator } from "./sandbox.ts";
setDefaultEvaluator((evalTimeoutMs) => new NodeVmEvaluator(evalTimeoutMs));
