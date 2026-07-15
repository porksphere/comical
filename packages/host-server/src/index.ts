/**
 * `@comical/host-server` — the primary browser/app host.
 *
 * Runs on a host machine (desktop, NAS, home server) and exposes the bridge runtime as a REST
 * API. Browser and mobile clients call it directly — they never load bridge bundles or execute
 * bridge code; all fetching, parsing, and rate-limiting happens server-side.
 */
export { BridgeManager } from "./bridge-manager.ts";
export { FileLibraryStore } from "./library-store.ts";
export { createRouter, type RouterOptions } from "./router.ts";
export { SettingsStore } from "./settings-store.ts";
export { createServer, type ServerOptions } from "./server.ts";
export { FileSyncStore } from "./sync-store.ts";
export type { SyncProvider } from "./sync-provider.ts";
export { FileAccountStore, isValidUsername } from "./account-store.ts";
export type { AccountInfo, AccountProvider, LoginResult, SessionInfo } from "./account-provider.ts";
