/**
 * `@comical/registry/node` — everything in `@comical/registry` plus the Node-bound half: the
 * on-disk installed manifest (`ManifestStore`) and the manager that installs/updates/uninstalls
 * bundles into a cache directory (`RegistryManager`). Kept off the root barrel so a browser/Hermes
 * consumer importing `@comical/registry` never pulls `node:fs`; a Node consumer imports this one
 * path and gets both.
 */
export * from "./index.ts";
export * from "./manifest.ts";
export * from "./manager.ts";
