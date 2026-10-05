/**
 * A registry index, remembered briefly.
 *
 * One screen asks for the same index several times over — the bridge list, the tracker list and the
 * update check all read it — and the memo is what makes that one fetch. It has to EXPIRE, though:
 * the processes holding it are a desktop shell left open for days, a server, a phone app that is
 * backgrounded rather than quit. Kept for the process's lifetime (which it was), "check for updates"
 * re-read the index from the day the app started, and a version published since was invisible until
 * a restart.
 *
 * Node-free, so the on-device provider shares it with `RegistryManager`.
 */
import type { RegistryIndex } from "./schema.ts";

/** Long enough to cover the burst of reads one screen makes; short enough that asking again is asking. */
export const INDEX_MEMO_MS = 10_000;

export class IndexMemo {
  private readonly entries = new Map<string, { index: RegistryIndex; at: number }>();

  /** The index, if it was read recently enough to stand in for a fetch. */
  fresh(url: string): RegistryIndex | undefined {
    const entry = this.entries.get(url);
    return entry && Date.now() - entry.at < INDEX_MEMO_MS ? entry.index : undefined;
  }

  /** The last index read, however old — what a caller falls back on when the fetch fails. */
  last(url: string): RegistryIndex | undefined {
    return this.entries.get(url)?.index;
  }

  set(url: string, index: RegistryIndex): void {
    this.entries.set(url, { index, at: Date.now() });
  }

  delete(url: string): void {
    this.entries.delete(url);
  }
}
