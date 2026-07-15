/**
 * The sync hub, made a first-class sync *node* rather than a passive record relay.
 *
 * It holds one `Replica` — the merged CRDT state of the shared library — and keeps it and the
 * server-side `/library` store converged in BOTH directions, so a web client (which browses
 * `/library`) and a native device (which syncs via `/sync`) see one library:
 *
 *   - **native → web:** on `push`, incoming records are merged into the replica, then projected onto
 *     the real library via `LibraryStoreBridge.apply` — so the web sees what native added.
 *   - **web → native:** the library store handed to the `Library` service is `wrapLibrary()`, a
 *     write-through that mirrors every web edit into the replica as a fresh record — so the next
 *     `pull` hands it to native.
 *
 * The projection writes to the RAW store (not the wrapped one), so applied records are never
 * re-captured — no feedback loop. This assumes the accounts model's single shared library ⇄ single
 * account: there is one replica for the one library, and `push`/`pull`'s account argument is ignored
 * (every session maps to the same account). Per-account libraries are a later change.
 *
 * Replaces `FileSyncStore`: same durable, atomic, per-account-lock persistence, but the file now holds
 * the node identity plus the merged records, and every push also converges the library.
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { LibraryStore } from "@comical/library";
import {
  Clock,
  LibraryStoreBridge,
  RecordSet,
  Replica,
  wrapLibraryStore,
  type PullResult,
  type SyncRecord,
} from "@comical/sync";
import type { SyncProvider } from "./sync-provider.ts";

interface HubFile {
  /** This hub's HLC node identity — stable across restarts so its stamps stay ordered. */
  nodeId: string;
  records: SyncRecord[];
}

const newNodeId = (): string => randomBytes(16).toString("base64url");

export class SyncHub implements SyncProvider {
  private readonly file: string;
  private readonly nodeId: string;
  private readonly replica: Replica;
  private readonly bridge: LibraryStoreBridge;
  /** Records read synchronously at construction, merged into the replica on first async use. */
  private readonly persisted: SyncRecord[];
  private lock: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private persistScheduled = false;

  constructor(private readonly dir: string, private readonly rawStore: LibraryStore) {
    this.file = join(dir, "hub.json");
    // Read the node id (and any persisted records) synchronously so the Clock exists before the first
    // library write can be captured. A one-time startup read; everything after is async + locked.
    let nodeId: string;
    let persisted: SyncRecord[] = [];
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Partial<HubFile>;
      nodeId = data.nodeId ?? newNodeId();
      persisted = data.records ?? [];
    } catch {
      nodeId = newNodeId();
    }
    this.nodeId = nodeId;
    this.persisted = persisted;
    this.replica = new Replica(new Clock(nodeId, Date.now));
    this.bridge = new LibraryStoreBridge(rawStore);
  }

  /**
   * The library store to hand the `Library` service: a write-through over the real store that mirrors
   * every web edit into the replica (web → native). Call once, at construction.
   */
  wrapLibrary(): LibraryStore {
    return wrapLibraryStore(this.rawStore, this.replica, () => this.schedulePersist());
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => {});
    return next;
  }

  /** First async use: merge persisted records, or bootstrap the replica from an existing library. */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.persisted.length > 0) {
      this.replica.merge(this.persisted);
    } else {
      // Fresh hub file. Recover records from the pre-hub `FileSyncStore` layout (per-account arrays)
      // if any are present, and seed from whatever the server library already holds, so neither an
      // existing device-synced library nor an existing web-built one is stranded. Then project the
      // merged state onto the library and persist as the new hub file.
      await this.importLegacy();
      await this.bridge.hydrate(this.replica);
      await this.bridge.apply(this.replica);
      await this.flush();
    }
    this.loaded = true;
  }

  /**
   * One-time migration: the old `FileSyncStore` wrote one JSON array of records per account under this
   * same dir. Merge any such files into the replica (idempotent). `hub.json` is an object, not an
   * array, so it's skipped by shape; the legacy files are left in place, superseded.
   */
  private async importLegacy(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name === "hub.json") continue;
      try {
        const data = JSON.parse(await readFile(join(this.dir, name), "utf8"));
        if (Array.isArray(data)) this.replica.merge(data as SyncRecord[]);
      } catch {
        /* skip anything unreadable or not a legacy record array */
      }
    }
  }

  async push(_account: string, records: SyncRecord[]): Promise<void> {
    await this.withLock(async () => {
      await this.ensureLoaded();
      this.replica.merge(records);
      // Converge the server library so a web client browsing /library sees native's changes.
      await this.bridge.apply(this.replica);
      await this.flush();
    });
  }

  async pull(_account: string, cursor: string | null): Promise<PullResult> {
    return this.withLock(async () => {
      await this.ensureLoaded();
      // Reuse RecordSet's cursor arithmetic; the replica already holds the merged state (native pushes
      // + captured web writes).
      return new RecordSet(this.replica.all()).since(cursor);
    });
  }

  /** Debounced persist for the write-through path — a burst of web edits flushes once. */
  private schedulePersist(): void {
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    void this.withLock(async () => {
      this.persistScheduled = false;
      await this.flush();
    }).catch(() => {});
  }

  private async flush(): Promise<void> {
    const tmp = `${this.file}.tmp`;
    const payload: HubFile = { nodeId: this.nodeId, records: this.replica.all() };
    await mkdir(this.dir, { recursive: true });
    await writeFile(tmp, JSON.stringify(payload), "utf8");
    await rename(tmp, this.file);
  }
}
