/**
 * A Replica is one device's local CRDT state: a map of `table -> id -> Envelope`, plus the device
 * clock and an outbox of records changed by *local* writes since the last successful push. Merging a
 * remote record never touches the outbox, so replicated changes don't ping-pong back out.
 *
 * This is a pure, in-memory data structure with no storage or transport dependency — the concrete
 * LibraryStore/host-server wiring projects records in and out of it via StoreBridge
 * (store-bridge.ts). Kept dependency-free so it runs identically on JSC, QuickJS, under Bun, and in
 * tests.
 *
 * The merge it runs (`mergeEnvelope`) is the shared one from this package, which the hub runs too —
 * that's the whole reason a dumb server can be trusted to converge with every device.
 */
import { Clock } from './hlc.ts';
import { TABLE_STRATEGY, type TableId } from './tables.ts';
import { isLive, mergeEnvelope, type Envelope, type Progress } from './crdt.ts';

/** The unit exchanged with a backend: an addressed, stamped envelope. Defined by the wire contract. */
export type { SyncRecord } from './wire.ts';
import type { SyncRecord } from './wire.ts';

// NUL separates table from id in an outbox key: a table id is `[A-Za-z]+`, so it can never contain
// this byte, making the split unambiguous. `String.fromCharCode(0)` keeps the source free of a
// literal NUL while producing the exact same runtime separator the app persisted its outbox with.
const NUL = String.fromCharCode(0);
const outboxKey = (table: TableId, id: string): string => `${table}${NUL}${id}`;

export class Replica {
  private readonly data = new Map<TableId, Map<string, Envelope>>();
  /** (table,id) of records mutated locally since the last drained push. */
  private readonly dirty = new Set<string>();

  constructor(private readonly clock: Clock) {}

  private table(t: TableId): Map<string, Envelope> {
    let m = this.data.get(t);
    if (!m) this.data.set(t, (m = new Map()));
    return m;
  }

  private assertStrategy(table: TableId, kind: Envelope['kind']): void {
    const want = TABLE_STRATEGY[table];
    const got = kind === 'register' ? 'register' : kind === 'set' ? 'set' : 'progress';
    if (want !== got) throw new Error(`sync: table '${table}' expects ${want}, got ${got}`);
  }

  private writeLocal(table: TableId, id: string, env: Envelope): void {
    this.table(table).set(id, env);
    this.dirty.add(outboxKey(table, id));
  }

  // ── local writes (stamp a fresh HLC) ────────────────────────────────────────
  putRegister(table: TableId, id: string, value: unknown): void {
    this.assertStrategy(table, 'register');
    this.writeLocal(table, id, { kind: 'register', hlc: this.clock.send(), value, deleted: false });
  }
  deleteRegister(table: TableId, id: string): void {
    this.assertStrategy(table, 'register');
    this.writeLocal(table, id, { kind: 'register', hlc: this.clock.send(), value: null, deleted: true });
  }
  putSet(table: TableId, id: string, present: boolean, meta?: Record<string, unknown>): void {
    this.assertStrategy(table, 'set');
    this.writeLocal(table, id, { kind: 'set', hlc: this.clock.send(), present, meta });
  }
  putProgress(id: string, p: Omit<Progress, 'kind' | 'hlc'>): void {
    const table: TableId = 'progress';
    const incoming: Progress = { kind: 'progress', hlc: this.clock.send(), ...p };
    const prev = this.table(table).get(id);
    // local writes go through the same monotonic join — re-opening an earlier page never rewinds.
    this.writeLocal(table, id, prev ? mergeEnvelope(prev, incoming) : incoming);
  }

  // ── merge (from a backend / another replica) ────────────────────────────────
  merge(records: Iterable<SyncRecord>): void {
    for (const { table, id, env } of records) {
      this.clock.recv(env.hlc);
      const m = this.table(table);
      const prev = m.get(id);
      m.set(id, prev ? mergeEnvelope(prev, env) : env);
    }
  }

  // ── reads ───────────────────────────────────────────────────────────────────
  get(table: TableId, id: string): Envelope | undefined {
    return this.data.get(table)?.get(id);
  }
  /** Live values for a register/set table (tombstones and removed elements filtered out). */
  liveIds(table: TableId): string[] {
    const m = this.data.get(table);
    if (!m) return [];
    return [...m.entries()].filter(([, e]) => isLive(e)).map(([id]) => id);
  }
  registerValue<T>(table: TableId, id: string): T | undefined {
    const e = this.data.get(table)?.get(id);
    return e && e.kind === 'register' && !e.deleted ? (e.value as T) : undefined;
  }
  progress(id: string): Progress | undefined {
    const e = this.data.get('progress')?.get(id);
    return e?.kind === 'progress' ? e : undefined;
  }
  /** The metadata carried on a live set element (e.g. a registry's name), if present. */
  setMeta<T>(table: TableId, id: string): T | undefined {
    const e = this.data.get(table)?.get(id);
    return e && e.kind === 'set' && e.present ? (e.meta as T | undefined) : undefined;
  }

  // ── outbox (push side) ──────────────────────────────────────────────────────
  /** Records changed by local writes since the last `clearOutbox()`. */
  outbox(): SyncRecord[] {
    const out: SyncRecord[] = [];
    for (const key of this.dirty) {
      const sep = key.indexOf(NUL);
      const table = key.slice(0, sep) as TableId;
      const id = key.slice(sep + 1);
      const env = this.data.get(table)?.get(id);
      if (env) out.push({ table, id, env });
    }
    return out;
  }
  clearOutbox(): void {
    this.dirty.clear();
  }

  /** Full state — used by tests and by a snapshot-style backend; a delta backend uses `outbox()`. */
  all(): SyncRecord[] {
    const out: SyncRecord[] = [];
    for (const [table, m] of this.data) for (const [id, env] of m) out.push({ table, id, env });
    return out;
  }

  // ── persistence (survive app restart with the outbox intact) ─────────────────
  /** Serialise the full replica state + outbox for durable storage. */
  exportState(): { records: SyncRecord[]; dirty: string[] } {
    return { records: this.all(), dirty: [...this.dirty] };
  }
  /**
   * Restore persisted state. Does NOT stamp new HLCs or touch the clock — envelopes keep their
   * original stamps, and the still-pending outbox is preserved so unsynced local edits aren't lost.
   */
  importState(state: { records: SyncRecord[]; dirty: string[] }): void {
    for (const { table, id, env } of state.records) this.table(table).set(id, env);
    for (const k of state.dirty) this.dirty.add(k);
  }
}
