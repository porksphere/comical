/**
 * A set of merged sync records addressed by `(table, id)` — the rendezvous state, modelled once.
 *
 * This is the shape every backend converges on: push merges records in with the CRDT join, pull
 * returns everything stamped after the caller's cursor. The in-memory reference backend, the
 * host-server file store, and any future blob adapter differ only in *where the map is kept*, so
 * they all delegate the actual merge and cursor arithmetic here. Sharing it is the point: if the hub
 * merged even slightly differently from the devices, they would silently diverge.
 */
import { comparePacked } from "./hlc.ts";
import { mergeEnvelope } from "./crdt.ts";
import type { PullResult, SyncRecord } from "./wire.ts";

/** NUL separator: it cannot occur in a table id or a record id, so the join is unambiguous. */
const SEP = String.fromCharCode(0);
const keyOf = (r: SyncRecord): string => `${r.table}${SEP}${r.id}`;

export class RecordSet {
  private readonly records: Map<string, SyncRecord>;

  constructor(initial: Iterable<SyncRecord> = []) {
    this.records = new Map();
    for (const r of initial) this.records.set(keyOf(r), r);
  }

  /** Merge records in. Commutative, associative and idempotent, so retries and replays are safe. */
  merge(incoming: Iterable<SyncRecord>): void {
    for (const r of incoming) {
      const k = keyOf(r);
      const prev = this.records.get(k);
      this.records.set(k, prev ? { ...r, env: mergeEnvelope(prev.env, r.env) } : r);
    }
  }

  /**
   * Everything stamped strictly after `cursor` (null = from the beginning), plus the cursor to
   * resume from. The returned cursor is the high-water mark over *all* records, not just the
   * returned ones, and never moves backwards past the caller's own cursor.
   */
  since(cursor: string | null): PullResult {
    const records: SyncRecord[] = [];
    let max = cursor;
    for (const r of this.records.values()) {
      if (cursor === null || comparePacked(r.env.hlc, cursor) > 0) records.push(r);
      if (max === null || comparePacked(r.env.hlc, max) > 0) max = r.env.hlc;
    }
    return { records, cursor: max };
  }

  all(): SyncRecord[] {
    return [...this.records.values()];
  }

  get size(): number {
    return this.records.size;
  }
}
