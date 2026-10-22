/**
 * The full embedded runtime: bridges + trackers + the on-device library, runtime, and download
 * engine. This entry supplies the product modules to `install-core.ts`; an embedder that wants only
 * bridges imports `@comical/host-rn/bridges` instead and never bundles them.
 */
import { createRouterPageResolver, DownloadEngine, Downloads } from "@comical/downloads";
import { Library } from "@comical/library";
import { ComicalRuntime, migrateInstalledBridges, withIdMigration } from "@comical/runtime";
import { installEmbeddedTransportWith, type EmbeddedRuntimeConfig } from "./install-core.ts";

export { getEmbeddedDownloadEngine, uninstallEmbeddedTransport } from "./install-core.ts";
export type { EmbeddedModules, EmbeddedRuntimeConfig } from "./install-core.ts";

/**
 * Install the embedded transport via the supplied `setTransport`, with every optional module
 * available (`libraryStore`, `downloadsStore`, `downloadsEngine`, `covers` all honored).
 * @returns true if installed, false if the native runtime is unavailable (stayed remote).
 */
export function installEmbeddedTransport(config: EmbeddedRuntimeConfig): boolean {
  return installEmbeddedTransportWith(config, {
    Library,
    ComicalRuntime,
    withIdMigration,
    migrateInstalledBridges,
    Downloads,
    DownloadEngine,
    createRouterPageResolver,
  });
}
