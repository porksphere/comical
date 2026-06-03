/**
 * `@comical/host-bun` — the desktop/CLI host adapter. Provides real platform capabilities (Bun
 * `fetch`, filesystem storage) that the core gates and injects into a bridge. Session/cookie state
 * lives in core's gated network; this host only reports `Set-Cookie`.
 */
export * from "./host.ts";
export * from "./network.ts";
export * from "./storage.ts";
