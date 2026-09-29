/**
 * The rendezvous: every device's segments, kept per device. A reader asks for what is past its
 * version vector, so a device that was offline for a week is found by its own sequence numbers, not
 * by when its changes were stamped — the stamps are a week old and would sort behind everything
 * other readers have already passed.
 */
import type { PullResult, Segment, VersionVector } from "./wire.ts";

/**
 * A push reused a sequence number for different content — the device's state was restored from a
 * backup, or copied to a second install. Its numbering can't continue; it has to carry on under a
 * new device id (see `SyncEngine`).
 */
export class SeqConflictError extends Error {
  constructor(
    readonly device: string,
    readonly seq: number,
    readonly head: number,
  ) {
    super(`sync: device ${device} reused seq ${seq} (log is at ${head})`);
    this.name = "SeqConflictError";
  }
}

/** A push skipped ahead. Nothing past a gap could ever be read, so it is refused. */
export class SeqGapError extends Error {
  constructor(
    readonly device: string,
    readonly seq: number,
    readonly head: number,
  ) {
    super(`sync: device ${device} pushed seq ${seq} but the log is at ${head}`);
    this.name = "SeqGapError";
  }
}

export const DEFAULT_PULL_LIMIT = 2000;

export class ChangeLog {
  private readonly logs = new Map<string, Segment[]>();

  constructor(initial: Iterable<Segment> = []) {
    for (const s of initial) this.append(s);
  }

  head(device: string): number {
    return this.logs.get(device)?.length ?? 0;
  }

  heads(): VersionVector {
    const out: VersionVector = {};
    for (const [device, segs] of this.logs) out[device] = segs.length;
    return out;
  }

  /**
   * Returns false for a re-push of a segment already held — the device never heard back the first
   * time — so retries are free.
   */
  append(segment: Segment): boolean {
    let segs = this.logs.get(segment.device);
    const head = segs?.length ?? 0;
    if (segment.seq <= head) {
      const held = segs![segment.seq - 1]!;
      if (JSON.stringify(held.records) !== JSON.stringify(segment.records)) {
        throw new SeqConflictError(segment.device, segment.seq, head);
      }
      return false;
    }
    if (segment.seq !== head + 1) throw new SeqGapError(segment.device, segment.seq, head);
    if (!segs) this.logs.set(segment.device, (segs = []));
    segs.push(segment);
    return true;
  }

  /**
   * Segments past `have`, oldest first within each device. `limit` caps records, not segments, and
   * always admits at least one segment so an oversized one can't wedge a reader.
   */
  pull(have: VersionVector, limit = DEFAULT_PULL_LIMIT): PullResult {
    const segments: Segment[] = [];
    let records = 0;
    for (const [device, segs] of this.logs) {
      for (let i = have[device] ?? 0; i < segs.length; i++) {
        const seg = segs[i]!;
        if (segments.length > 0 && records + seg.records.length > limit) return { segments, more: true };
        segments.push(seg);
        records += seg.records.length;
      }
    }
    return { segments, more: false };
  }

  all(): Segment[] {
    return [...this.logs.values()].flat();
  }
}
