/**
 * The seam between the sync core and a concrete store. An implementation knows the real store's
 * shapes; the core stays generic. Two directions:
 *
 *   - hydrate(replica) — read the whole store and project it into the replica as local writes, so a
 *     first sync uploads existing data. (One-time bootstrap; steady-state change capture is a
 *     separate, finer concern — see library-bridge.ts.)
 *   - apply(replica)   — reconcile the replica's merged live state back into the store: upsert live
 *     records, delete tombstoned/absent ones. Idempotent.
 *
 * `library-bridge.ts` implements this over `@comical/library`'s `LibraryStore`. Registries, installed
 * bridges, and per-bridge settings live in *other* stores (host-rn `stores.ts`, `settings-store.ts`)
 * and get their own small bridges later.
 */
import type { Replica } from './replica.ts';

export interface StoreBridge {
  hydrate(replica: Replica): Promise<void>;
  apply(replica: Replica): Promise<void>;
}
