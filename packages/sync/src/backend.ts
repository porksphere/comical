/**
 * The one seam every rendezvous implements — a desktop hub over HTTP, a Drive or WebDAV folder of
 * per-device files. The engine never knows which.
 */
import { ChangeLog } from "./log.ts";
import type { PullRequest, PullResult, Segment } from "./wire.ts";

export interface SyncBackend {
  /**
   * Store one of the caller's segments. Idempotent for a segment already held; throws
   * `SeqConflictError` when that seq is held with different content.
   */
  push(segment: Segment): Promise<void>;
  /** Other devices' segments past `have`; `more` means call again with the advanced vector. */
  pull(request: PullRequest): Promise<PullResult>;
}

export class MemoryBackend implements SyncBackend {
  readonly log = new ChangeLog();

  async push(segment: Segment): Promise<void> {
    this.log.append(structuredClone(segment));
  }

  async pull({ have, limit }: PullRequest): Promise<PullResult> {
    return structuredClone(this.log.pull(have, limit));
  }
}
