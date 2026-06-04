/**
 * `@comical/contract` — the stable boundary between bridges, the core runtime, and hosts.
 *
 * Everything here is backend-agnostic and platform-agnostic: pure types, zod schemas, and the
 * contract version. No I/O, no platform APIs.
 */
export * from "./version.ts";
export * from "./models.ts";
export * from "./capabilities.ts";
export * from "./bridge.ts";
export * from "./tracker.ts";
