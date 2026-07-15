/**
 * `@comical/downloads` — optional, durable, offline-readable downloads of chapters and their pages.
 * Platform-agnostic: the manifest model, a `DownloadsStore` seam, the `Downloads` domain service, and
 * a portable in-memory store. The image bytes themselves are a platform concern — a host fetches and
 * stores them and feeds `(file, bytes)` back through `recordPage`; durable stores (filesystem,
 * AsyncStorage, SQLite) implement `DownloadsStore` per platform.
 */
export * from "./models.ts";
export * from "./store.ts";
export * from "./memory-store.ts";
export * from "./downloads.ts";
