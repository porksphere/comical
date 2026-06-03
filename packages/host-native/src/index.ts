/**
 * `@comical/host-native` — the shared JS runtime for the native (JSC/QuickJS) hosts.
 *
 * The `entry-jsc` / `entry-quickjs` modules are the build entrypoints (bundled into the app assets);
 * this barrel exposes the pieces for testing and reuse.
 */
export * from "./native-context-evaluator.ts";
export * from "./native-log.ts";
export * from "./runtime.ts";
export * from "./adapter-callback.ts";
export * from "./adapter-async.ts";
