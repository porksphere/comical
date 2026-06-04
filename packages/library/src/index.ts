/**
 * `@comical/library` — optional, local, cross-bridge reading library and progress tracking.
 * Platform-agnostic: the model, a `LibraryStore` seam, the `Library` domain service, and a portable
 * in-memory store. Durable stores (filesystem/IndexedDB/SQLite) implement `LibraryStore` per platform.
 */
export * from "./models.ts";
export * from "./store.ts";
export * from "./memory-store.ts";
export * from "./library.ts";
