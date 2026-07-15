/**
 * The backend-agnostic sync transport seam. Every rendezvous — the host-server hub (Tier 1), a
 * user-owned blob (Tier 2), or a LAN peer (Tier 3) — implements this one interface; the engine and
 * replica never know which. A backend is a dumb store of merged records addressed by a cursor: push
 * appends/merges records, pull returns everything newer than the caller's cursor. Because envelopes
 * merge idempotently, retries and duplicate deliveries are safe — that's what makes
 * "unreachable now, reachable later" work (see docs/CROSS-DEVICE-SYNC.md).
 */
import { RecordSet } from './record-set.ts';
import type { PullResult, SyncRecord } from './wire.ts';

export type { PullResult, SyncRecord };

export interface SyncBackend {
  /** Merge these records into the backend's state. Idempotent. */
  push(records: SyncRecord[]): Promise<void>;
  /** Everything with an HLC strictly greater than `cursor` (null = from the beginning). */
  pull(cursor: string | null): Promise<PullResult>;
}

/**
 * In-memory reference backend — the rendezvous modelled as a single merged set of records. Used by
 * tests; a blob backend serialises the same set to an object store, and the hub persists it per
 * account. All three delegate to `RecordSet`, so none of them can drift from the others.
 */
export class MemoryBackend implements SyncBackend {
  private readonly records = new RecordSet();

  async push(records: SyncRecord[]): Promise<void> {
    this.records.merge(records);
  }

  async pull(cursor: string | null): Promise<PullResult> {
    return this.records.since(cursor);
  }
}
