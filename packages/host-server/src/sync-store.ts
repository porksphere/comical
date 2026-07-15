/**
 * The sync hub's persistence: one JSON file of merged records per account, under `{dataDir}/sync`.
 *
 * The merge itself is not implemented here — it is `@comical/sync`'s `RecordSet`, the same join the
 * devices run. This file only decides where the bytes live. Two things it does take care of:
 *
 *   - **A per-account write lock.** Two devices pushing at once would otherwise read the same state,
 *     merge their own records into it, and race to write — the loser's writes vanish. Serialising
 *     per account keeps every push a read-merge-write against the latest state.
 *   - **An atomic write** (tmp file + rename). A push rewrites the account's whole file; a crash
 *     mid-write would otherwise leave truncated JSON, and the account would fail to load — i.e. the
 *     user's entire synced library, gone. Rename is atomic on both POSIX and Windows.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isValidAccountId, RecordSet, type PullResult, type SyncRecord } from "@comical/sync";
import type { SyncProvider } from "./sync-provider.ts";

export class FileSyncStore implements SyncProvider {
  private readonly dir: string;
  private readonly cache = new Map<string, RecordSet>();
  /** Tail of the write chain per account — the next push awaits it before touching the file. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  private path(account: string): string {
    // The router validates this too, but the store is a public API and this value becomes a path.
    if (!isValidAccountId(account)) throw new Error(`sync: invalid account id`);
    return join(this.dir, `${account}.json`);
  }

  private async load(account: string): Promise<RecordSet> {
    const cached = this.cache.get(account);
    if (cached) return cached;
    // Resolve the path OUTSIDE the try: that catch is there to tolerate a missing file, and it would
    // happily swallow the invalid-account-id rejection too, turning a refusal into an empty account.
    const path = this.path(account);
    let records: SyncRecord[] = [];
    try {
      records = JSON.parse(await readFile(path, "utf8")) as SyncRecord[];
    } catch {
      /* no file yet — a new account starts empty */
    }
    const set = new RecordSet(records);
    this.cache.set(account, set);
    return set;
  }

  /** Serialise work per account, so concurrent pushes can't clobber each other's merge. */
  private withLock<T>(account: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(account) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Swallow rejections on the *chain* only: a failed push must not poison the next one. The
    // caller still sees the real rejection through `next`.
    this.locks.set(account, next.catch(() => {}));
    return next;
  }

  async push(account: string, records: SyncRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.withLock(account, async () => {
      const set = await this.load(account);
      set.merge(records);
      await this.flush(account, set);
    });
  }

  async pull(account: string, cursor: string | null): Promise<PullResult> {
    const set = await this.load(account);
    return set.since(cursor);
  }

  private async flush(account: string, set: RecordSet): Promise<void> {
    const path = this.path(account);
    const tmp = `${path}.tmp`;
    await mkdir(this.dir, { recursive: true });
    await writeFile(tmp, JSON.stringify(set.all()), "utf8");
    await rename(tmp, path);
  }
}
