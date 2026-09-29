/**
 * A server that is a sync hub AND a device. It holds the rendezvous other devices push to, and its
 * own library syncs against that rendezvous in-process like any other device — so a phone's change
 * reaches this library (and every browser reading it) the same way it reaches another phone.
 *
 *   {dir}/segments/{device}.jsonl   → the hub's log (`FileSegmentStore`)
 *   {dir}/state.json                → this server's own engine state
 *
 * Everything is set up synchronously, since `createServer` is: the hub finishes loading behind a
 * promise every call waits on, and the engine state is read with a blocking read.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LibraryStore } from "@comical/library";
import {
  adoptLibrary,
  librarySyncStore,
  SyncEngine,
  SyncHub,
  wrapLibraryStore,
  type Segment,
  type SyncBackend,
  type SyncStateSnapshot,
  type VersionVector,
} from "@comical/sync";
import { FileSegmentStore } from "./sync-segment-store.ts";

export interface SyncHost {
  /** The store to build the server's `Library` over; writes through it are recorded. */
  store: LibraryStore;
  /** What `/sync` serves. A push through it also brings this server's own library up to date. */
  backend: SyncBackend;
  engine: SyncEngine;
  /** Resolves once this server's library has caught up with the hub. Mostly for tests. */
  ready: Promise<void>;
  /** Sync now, rather than after the usual debounce. */
  flush(): Promise<void>;
}

export interface SyncHostOptions {
  dir: string;
  store: LibraryStore;
  /** How long a burst of local writes or pushes is gathered before this server syncs. */
  debounceMs?: number;
  log?: Pick<Console, "error">;
}

export function createSyncHost(opts: SyncHostOptions): SyncHost {
  mkdirSync(opts.dir, { recursive: true });
  const statePath = join(opts.dir, "state.json");
  const log = opts.log ?? console;
  const hubReady = SyncHub.open(new FileSegmentStore(join(opts.dir, "segments")));
  const hub: SyncBackend = {
    push: async (s: Segment) => (await hubReady).push(s),
    pull: async (have: VersionVector, limit?: number) => (await hubReady).pull(have, limit),
  };

  const state = readState(statePath, log);
  const engine = new SyncEngine({
    store: librarySyncStore(opts.store),
    backend: hub,
    ...(state ? { state } : { device: `hub-${crypto.randomUUID()}` }),
    newDeviceId: () => `hub-${crypto.randomUUID()}`,
    persist: async (s) => writeState(statePath, s),
    onTouch: () => schedule(),
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (): Promise<void> =>
    engine.sync().then(
      () => undefined,
      (err: unknown) => log.error("sync: round failed", err),
    );
  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, opts.debounceMs ?? 250);
  }

  // A fresh hub starts from what this server already has; after that its library only changes
  // through the wrapped store or by applying what the hub holds.
  const ready = state
    ? run()
    : run()
        .then(() => adoptLibrary(opts.store, engine))
        .then(run);

  return {
    store: wrapLibraryStore(opts.store, engine),
    backend: {
      push: async (s) => {
        await hub.push(s);
        schedule();
      },
      pull: (have, limit) => hub.pull(have, limit),
    },
    engine,
    ready,
    flush: async () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      await ready;
      await run();
    },
  };
}

// Unreadable state starts over as a new device, which is safe: it pulls the whole log before it
// adopts anything, so nothing it holds outranks what the hub already has.
function readState(path: string, log: Pick<Console, "error">): SyncStateSnapshot | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SyncStateSnapshot;
  } catch (err) {
    log.error("sync: engine state unreadable, starting as a new device", err);
    return undefined;
  }
}

// Written aside and renamed over, so a crash leaves the old state or the new one, never half of each.
function writeState(path: string, state: SyncStateSnapshot): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(state));
  renameSync(`${path}.tmp`, path);
}
