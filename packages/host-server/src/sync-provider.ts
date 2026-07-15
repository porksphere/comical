/**
 * The cross-device sync surface the router depends on — extracted as a Node-free interface so
 * `router.ts` can be consumed without dragging in `sync-store.ts` (which imports `node:fs`). The
 * server's `FileSyncStore` satisfies this structurally. Mirrors `TrackerProvider`; a host without a
 * sync hub omits `RouterOptions.sync`.
 *
 * A hub is deliberately dumb: it merges what it is pushed and hands back what a device hasn't seen.
 * It holds no session, no per-device state, and makes no decisions — every device (and the hub)
 * computes the same merge independently via `@comical/sync`, which is what lets the whole thing
 * tolerate retries, duplicate delivery, and arbitrary offline gaps.
 */
import type { PullResult, SyncRecord } from "@comical/sync";

export interface SyncProvider {
  /** Merge records into an account's state. Idempotent — a client that retries pushes duplicates. */
  push(account: string, records: SyncRecord[]): Promise<void>;
  /** Everything in the account stamped after `cursor` (null = from the beginning). */
  pull(account: string, cursor: string | null): Promise<PullResult>;
}
