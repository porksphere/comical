/**
 * The sync engine: one round is "push my outbox, pull everything since my cursor, merge, advance the
 * cursor." Transport-agnostic — it drives any SyncBackend. Because envelopes merge idempotently and
 * the outbox holds only locally-originated changes, a device offline for a week just pushes its week
 * of changes and pulls everyone else's on reconnect; nothing has to be online at the same time.
 */
import type { Replica } from './replica.ts';
import type { SyncBackend } from './backend.ts';

/** Persisted per-device pull cursor. In the app: an AsyncStorage-backed impl; in tests: in-memory. */
export interface CursorStore {
  get(): Promise<string | null>;
  set(cursor: string): Promise<void>;
}

export class MemoryCursor implements CursorStore {
  private cursor: string | null = null;
  async get(): Promise<string | null> {
    return this.cursor;
  }
  async set(cursor: string): Promise<void> {
    this.cursor = cursor;
  }
}

export type SyncStats = { pushed: number; pulled: number };

export class SyncEngine {
  constructor(
    private readonly replica: Replica,
    private readonly backend: SyncBackend,
    private readonly cursor: CursorStore,
  ) {}

  /**
   * Run one sync round. Push happens first and the outbox is cleared only after the push resolves,
   * so a failed push leaves local changes queued for the next attempt (no data loss). The pull then
   * echoes our own just-pushed records back; re-merging them is idempotent — a known, harmless cost
   * that a delta backend can trim later by excluding the caller's own node.
   */
  async sync(): Promise<SyncStats> {
    const outgoing = this.replica.outbox();
    if (outgoing.length > 0) {
      await this.backend.push(outgoing);
      this.replica.clearOutbox();
    }

    const cursor = await this.cursor.get();
    const { records, cursor: next } = await this.backend.pull(cursor);
    this.replica.merge(records);
    if (next && next !== cursor) await this.cursor.set(next);

    return { pushed: outgoing.length, pulled: records.length };
  }
}
