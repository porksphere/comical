/**
 * `@comical/downloads` — optional, durable, offline-readable downloads of chapters and their pages.
 * Platform-agnostic: the manifest model, a `DownloadsStore` seam, the `Downloads` domain service, a
 * portable in-memory store, and the `DownloadEngine` drain loop. The platform touches live behind two
 * injected seams — a `BlobStore` (where page bytes land) and a `PageFetcher` (how a `sourceUrl`
 * becomes bytes) — so the same engine runs on a server host (filesystem + in-process router
 * resolution) and on device (expo-file-system + the reader's asset resolver). Durable manifest stores
 * (filesystem, AsyncStorage, SQLite) implement `DownloadsStore` per platform.
 */
export * from "./models.ts";
export * from "./store.ts";
export * from "./memory-store.ts";
export * from "./downloads.ts";
export * from "./paths.ts";
export * from "./blob-store.ts";
export * from "./engine.ts";
export * from "./page-resolver.ts";
