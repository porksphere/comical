/**
 * One device's side of sync. A round is: push my unsent changes as my next numbered segment, then
 * pull every other device's segments past my version vector and merge them into the store.
 *
 * Crash safety rests on two orderings. A segment is persisted as `pending` BEFORE it is pushed, so a
 * push that landed but was never acknowledged is re-sent byte-identical and the backend drops it as
 * a duplicate. And the vector advances only AFTER a pulled page has been written to the store, so a
 * crash mid-apply re-pulls that page, which the merge makes harmless.
 */
import { Clock, comparePacked } from "./hlc.ts";
import { envelopeChanges, isLive, mergeEnvelope, type Envelope, type Progress } from "./crdt.ts";
import { SeqConflictError } from "./log.ts";
import type { SyncBackend } from "./backend.ts";
import type { ProgressValue, SyncStore } from "./store.ts";
import { ALL_TABLES, recordKey, splitRecordKey, TABLE_STRATEGY, type TableId } from "./tables.ts";
import type { Segment, SyncRecord, VersionVector } from "./wire.ts";

export type Stamp = { hlc: string; reset?: string };

export type SyncStateSnapshot = {
  version: 1;
  device: string;
  clock: string;
  nextSeq: number;
  vector: VersionVector;
  stamps: Record<string, Stamp>;
  dirty: string[];
  pending: Segment | null;
  /** Records protected from deletion until the pull in progress completes (see `applyRecord`). */
  held?: string[];
};

export type SyncStats = { pushed: number; pulled: number; applied: number };

export type SyncEngineOptions = {
  store: SyncStore;
  backend: SyncBackend;
  /** Required on first run; ignored when `state` is given. */
  device?: string;
  /** What this device calls itself to whoever looks at the hub. Not state: it may be renamed. */
  name: string;
  state?: SyncStateSnapshot;
  /** A fresh device id, for when this one's numbering can't continue (see `SeqConflictError`). */
  newDeviceId: () => string;
  /** Awaited at the points crash safety depends on. */
  persist?: (state: SyncStateSnapshot) => Promise<void>;
  /** Fires after a local change is recorded; the host decides how soon to persist. */
  onTouch?: () => void;
  now?: () => number;
  segmentSize?: number;
  pullLimit?: number;
};

const DEFAULT_SEGMENT_SIZE = 500;

export class SyncEngine {
  private device: string;
  private clock: Clock;
  private nextSeq: number;
  private readonly vector: VersionVector;
  private readonly stamps: Map<string, Stamp>;
  private readonly dirty: Set<string>;
  private readonly held: Set<string>;
  private pending: Segment | null;
  private lock: Promise<unknown> = Promise.resolve();
  private running: Promise<SyncStats> | null = null;

  constructor(private readonly opts: SyncEngineOptions) {
    const s = opts.state;
    const device = s?.device ?? opts.device;
    if (!device) throw new Error("sync: a device id is required on first run");
    this.device = device;
    this.clock = new Clock(device, opts.now, s?.clock);
    this.nextSeq = s?.nextSeq ?? 1;
    this.vector = { ...s?.vector };
    this.stamps = new Map(Object.entries(s?.stamps ?? {}));
    this.dirty = new Set(s?.dirty);
    this.held = new Set(s?.held);
    this.pending = s?.pending ?? null;
  }

  get deviceId(): string {
    return this.device;
  }

  /**
   * Serialise against applying remote changes. A local write should run its store write and its
   * `touch` inside this, or a remote value landing between the two gets stamped as ours.
   */
  exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /**
   * Record a local change to `(table, id)`; its current value is read from the store at push time.
   * `rewind` marks a deliberate step back in progress (marking a chapter unread), which the forward-
   * only merge would otherwise undo on the next sync.
   */
  touch(table: TableId, id: string, opts: { rewind?: boolean } = {}): void {
    const key = recordKey(table, id);
    const hlc = this.clock.send();
    const reset = opts.rewind ? hlc : this.stamps.get(key)?.reset;
    this.stamps.set(key, reset ? { hlc, reset } : { hlc });
    this.dirty.add(key);
    this.opts.onTouch?.();
  }

  /**
   * `touch`, but only for a record sync has never seen. Hydrating a store that already has data
   * AFTER a first pull makes what the other devices hold win, and adds only what they lack — rather
   * than a fresh stamp on every local copy beating everything they have.
   */
  adopt(table: TableId, id: string): void {
    if (!this.stamps.has(recordKey(table, id))) this.touch(table, id);
  }

  hasUnsent(): boolean {
    return this.dirty.size > 0 || this.pending !== null;
  }

  snapshot(): SyncStateSnapshot {
    return {
      version: 1,
      device: this.device,
      clock: this.clock.current(),
      nextSeq: this.nextSeq,
      vector: { ...this.vector },
      stamps: Object.fromEntries(this.stamps),
      dirty: [...this.dirty],
      pending: this.pending,
      ...(this.held.size > 0 && { held: [...this.held] }),
    };
  }

  /** Concurrent callers share the round already in flight. */
  sync(): Promise<SyncStats> {
    this.running ??= this.round().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  // Pull first. The merge doesn't care which way round — every record is settled on its own stamp
  // when applied — but nothing of this device's leaves until the hub has answered, which over a
  // sealed channel is the hub proving itself; and a write that would have lost is never sent.
  private async round(): Promise<SyncStats> {
    const stats: SyncStats = { pushed: 0, pulled: 0, applied: 0 };
    for (;;) {
      const { segments, more } = await this.opts.backend.pull({
        device: this.device,
        name: this.opts.name,
        have: { ...this.vector },
        ...(this.opts.pullLimit !== undefined && { limit: this.opts.pullLimit }),
      });
      if (segments.length > 0) {
        stats.applied += await this.exclusive(() => this.applySegments(segments));
        await this.persist();
      }
      stats.pulled += segments.reduce((n, s) => n + s.records.length, 0);
      if (!more || segments.length === 0) break;
    }
    for (;;) {
      const seg = this.pending ?? (await this.exclusive(() => this.buildSegment()));
      if (!seg) break;
      stats.pushed += await this.pushPending(seg);
    }
    if (this.held.size > 0) {
      this.held.clear();
      await this.persist();
    }
    return stats;
  }

  private async buildSegment(): Promise<Segment | null> {
    if (this.dirty.size === 0) return null;
    const size = this.opts.segmentSize ?? DEFAULT_SEGMENT_SIZE;
    const records: SyncRecord[] = [];
    // Table order, so a record lands after what it refers to — an item after its collection, a
    // series' resume point after the series.
    for (const key of [...this.dirty].sort(byTableOrder)) {
      if (records.length >= size) break;
      this.dirty.delete(key);
      const stamp = this.stamps.get(key);
      if (!stamp) continue;
      const { table, id } = splitRecordKey(key);
      records.push({ table, id, env: toEnvelope(table, await this.opts.store.read(table, id), stamp) });
    }
    this.pending = { device: this.device, seq: this.nextSeq++, records };
    await this.persist();
    return this.pending;
  }

  private async pushPending(seg: Segment): Promise<number> {
    try {
      await this.opts.backend.push(seg);
    } catch (err) {
      if (!(err instanceof SeqConflictError) || err.device !== this.device) throw err;
      return this.pushPending(await this.continueAsNewDevice(seg));
    }
    this.pending = null;
    this.vector[seg.device] = seg.seq;
    await this.persist();
    return seg.records.length;
  }

  /**
   * This state is older than the log it pushes to — restored from a backup, or cloned onto a second
   * install. The old id's later segments are real history this copy never saw, so they stay in the
   * vector to be pulled; this copy's own changes continue under a fresh id from seq 1.
   */
  private async continueAsNewDevice(seg: Segment): Promise<Segment> {
    this.vector[this.device] = seg.seq - 1;
    this.device = this.opts.newDeviceId();
    this.clock = new Clock(this.device, this.opts.now, this.clock.current());
    this.nextSeq = 2;
    this.pending = { device: this.device, seq: 1, records: seg.records };
    await this.persist();
    return this.pending;
  }

  private async applySegments(segments: Segment[]): Promise<number> {
    let applied = 0;
    for (const seg of segments) {
      for (const rec of seg.records) if (await this.applyRecord(rec)) applied++;
      this.vector[seg.device] = Math.max(this.vector[seg.device] ?? 0, seg.seq);
    }
    return applied;
  }

  private async applyRecord({ table, id, env }: SyncRecord): Promise<boolean> {
    this.clock.recv(env.hlc);
    const key = recordKey(table, id);
    const stamp = this.stamps.get(key);
    const store = this.opts.store;

    if (env.kind !== "progress") {
      if (stamp && comparePacked(stamp.hlc, env.hlc) >= 0) return false;
      // A delete can only be about a copy sync has seen. An unstamped one was here before this
      // device first synced, so a delete in the history being pulled was of some other device's
      // copy, made without knowing of this one: it is refused, and this copy goes back out as a
      // new write. The record is held for the rest of the pull, not just this once — the log
      // replays the record's whole life, and its creation arrives (and stamps it) before its
      // deletion does.
      if (!stamp && (await store.read(table, id)) !== undefined) this.held.add(key);
      if (this.held.has(key) && !isLive(env)) {
        this.touch(table, id);
        return false;
      }
      await store.write(table, id, fromEnvelope(env));
      this.stamps.set(key, { hlc: env.hlc });
      // Ours lost, so there is nothing of ours left to send.
      this.dirty.delete(key);
      return true;
    }

    const localValue = await store.read(table, id);
    const local =
      localValue === undefined && !stamp ? undefined : (toEnvelope(table, localValue, stamp ?? { hlc: env.hlc }) as Progress);
    const merged = (local ? mergeEnvelope(local, env) : env) as Progress;
    this.stamps.set(key, merged.reset ? { hlc: merged.hlc, reset: merged.reset } : { hlc: merged.hlc });
    if (!envelopeChanges(local, env)) return false;
    await store.write(table, id, fromEnvelope(merged));
    return true;
  }

  private async persist(): Promise<void> {
    await this.opts.persist?.(this.snapshot());
  }
}

const TABLE_ORDER = new Map<string, number>(ALL_TABLES.map((t, i) => [t, i]));
const byTableOrder = (a: string, b: string): number =>
  TABLE_ORDER.get(splitRecordKey(a).table)! - TABLE_ORDER.get(splitRecordKey(b).table)!;

function toEnvelope(table: TableId, value: unknown, stamp: Stamp): Envelope {
  switch (TABLE_STRATEGY[table]) {
    case "register":
      return value === undefined
        ? { kind: "register", hlc: stamp.hlc, value: null, deleted: true }
        : { kind: "register", hlc: stamp.hlc, value, deleted: false };
    case "set":
      return value === undefined
        ? { kind: "set", hlc: stamp.hlc, present: false }
        : { kind: "set", hlc: stamp.hlc, present: true, meta: value as Record<string, unknown> };
    case "progress": {
      const p = value as ProgressValue | undefined;
      return {
        kind: "progress",
        hlc: stamp.hlc,
        ...(stamp.reset && { reset: stamp.reset }),
        read: p?.read ?? false,
        lastPage: p?.lastPage ?? 0,
        pageCount: p?.pageCount ?? 0,
        ...(p?.number !== undefined && { number: p.number }),
        ...(p?.languageCode !== undefined && { languageCode: p.languageCode }),
      };
    }
  }
}

function fromEnvelope(env: Envelope): unknown {
  switch (env.kind) {
    case "register":
      return env.deleted ? undefined : env.value;
    case "set":
      return env.present ? (env.meta ?? {}) : undefined;
    case "progress": {
      const value: ProgressValue = { read: env.read, lastPage: env.lastPage, pageCount: env.pageCount };
      if (env.number !== undefined) value.number = env.number;
      if (env.languageCode !== undefined) value.languageCode = env.languageCode;
      return value;
    }
  }
}
