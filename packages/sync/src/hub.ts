/**
 * The rendezvous a desktop runs: a `ChangeLog` made durable. It is a `SyncBackend` itself, so the
 * desktop's own engine syncs against it in-process while phones reach the same object over HTTP.
 */
import type { SyncBackend } from "./backend.ts";
import { ChangeLog, SeqGapError } from "./log.ts";
import { MAX_PULL_LIMIT, type PullResult, type Segment, type VersionVector } from "./wire.ts";

/** Where a hub keeps its segments. Append-only: a held segment is never rewritten. */
export interface SegmentStore {
  /** Every held segment, each device's in seq order. */
  load(): Promise<Segment[]>;
  /** Called only for a segment that extends its device's log by exactly one. */
  append(segment: Segment): Promise<void>;
}

export class MemorySegmentStore implements SegmentStore {
  readonly segments: Segment[] = [];
  async load(): Promise<Segment[]> {
    return structuredClone(this.segments);
  }
  async append(segment: Segment): Promise<void> {
    this.segments.push(structuredClone(segment));
  }
}

export class SyncHub implements SyncBackend {
  private lock: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly log: ChangeLog,
    private readonly store: SegmentStore,
  ) {}

  static async open(store: SegmentStore): Promise<SyncHub> {
    return new SyncHub(new ChangeLog(await store.load()), store);
  }

  heads(): VersionVector {
    return this.log.heads();
  }

  /**
   * Checked against the log before it is stored and applied after, so a segment the store failed
   * to keep is never served. Serialised, since two pushes from one device must not both pass the
   * check for the same seq.
   */
  push(segment: Segment): Promise<void> {
    const run = this.lock.then(async () => {
      const head = this.log.head(segment.device);
      if (segment.seq <= head) {
        this.log.append(segment);
        return;
      }
      if (segment.seq !== head + 1) throw new SeqGapError(segment.device, segment.seq, head);
      const copy = structuredClone(segment);
      await this.store.append(copy);
      this.log.append(copy);
    });
    this.lock = run.catch(() => undefined);
    return run;
  }

  async pull(have: VersionVector, limit = MAX_PULL_LIMIT): Promise<PullResult> {
    return structuredClone(this.log.pull(have, Math.min(limit, MAX_PULL_LIMIT)));
  }
}
