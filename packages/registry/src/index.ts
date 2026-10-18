/**
 * `@comical/registry` — the Node-free registry layer: index schema + validation, URL resolution,
 * SHA-256/Ed25519 verification, the fetcher, move/conflict/compat rules. Safe to import from a
 * browser bundle, Hermes, or Electron's renderer.
 *
 * The file-backed `ManifestStore` + `RegistryManager` (which need `node:fs`) are deliberately NOT
 * re-exported here — import them from `@comical/registry/node`.
 */
export * from "./schema.ts";
export * from "./url.ts";
export * from "./verify.ts";
export * from "./moves.ts";
export * from "./compat.ts";
export * from "./conflicts.ts";
export * from "./fetcher.ts";
export * from "./missing.ts";
export type * from "./available.ts";
