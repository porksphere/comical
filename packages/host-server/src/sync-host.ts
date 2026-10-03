/**
 * A server that is a sync hub AND a device. It holds the rendezvous other devices push to, and its
 * own library syncs against that rendezvous in-process like any other device — so a phone's change
 * reaches this library (and every browser reading it) the same way it reaches another phone.
 *
 *   {dir}/segments/{device}.jsonl   → the hub's log (`FileSegmentStore`)
 *   {dir}/state.json                → this server's own engine state
 *   {dir}/devices.json              → who has synced with it, and when last
 *
 * Everything is set up synchronously, since `createServer` is: the hub finishes loading behind a
 * promise every call waits on, and the engine state is read with a blocking read.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LibraryStore } from "@comical/library";
import {
  adoptLibrary,
  adoptRegistry,
  composeSyncStores,
  LIBRARY_TABLES,
  librarySyncStore,
  REGISTRY_TABLES,
  registrySyncStore,
  SyncEngine,
  SyncHub,
  wrapLibraryStore,
  wrapRegistryProvider,
  type PullRequest,
  type RegistryLists,
  type RegistryMutations,
  type Segment,
  type SyncBackend,
  type SyncStateSnapshot,
} from "@comical/sync";
import { FileSegmentStore } from "./sync-segment-store.ts";

/** A device that has synced with this hub. Each pull it makes brings `name` and `lastSeenAt` up to date. */
export interface SyncDevice {
  id: string;
  name: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface SyncHost<R extends RegistryMutations = RegistryMutations> {
  /** The store to build the server's `Library` over; writes through it are recorded. */
  store: LibraryStore;
  /** The registry to hand the router; installs and adds through it are recorded. */
  registry: R;
  /** What `/sync` serves. A push through it also brings this server's own library up to date. */
  backend: SyncBackend;
  engine: SyncEngine;
  /** Every device that has synced through `backend`, most recent first. This server itself is not one. */
  devices(): SyncDevice[];
  /** Resolves once this server's library has caught up with the hub. Mostly for tests. */
  ready: Promise<void>;
  /** Sync now, rather than after the usual debounce. */
  flush(): Promise<void>;
  /**
   * Drop the pending round and schedule no more — for shutdown, so a write that lands inside the
   * debounce window doesn't start a round against a store that is closing. A round already underway
   * finishes; an unsent change is simply pushed by the next run's first round.
   */
  stop(): void;
}

export interface SyncHostOptions<R extends RegistryMutations> {
  dir: string;
  store: LibraryStore;
  /**
   * The server's registry manager: a phone's install is performed here too, and an install here
   * reaches the phones. Its network failures are retried on later rounds.
   */
  registry: R;
  /** What that manager holds, read from its manifest. */
  lists: RegistryLists;
  /** How long a burst of local writes or pushes is gathered before this server syncs. */
  debounceMs?: number;
  /**
   * Called after a round changed this server's own library or registry from another device's
   * records — the moment anything showing them is out of date.
   */
  onApplied?: () => void;
  /** Called when `devices()` has a new answer: a device first seen, renamed, or back for more. */
  onDevices?: (devices: SyncDevice[]) => void;
  now?: () => number;
  log?: Pick<Console, "error">;
}

export function createSyncHost<R extends RegistryMutations>(opts: SyncHostOptions<R>): SyncHost<R> {
  mkdirSync(opts.dir, { recursive: true });
  const statePath = join(opts.dir, "state.json");
  const log = opts.log ?? console;
  const hubReady = SyncHub.open(new FileSegmentStore(join(opts.dir, "segments")));
  const hub: SyncBackend = {
    push: async (s: Segment) => (await hubReady).push(s),
    pull: async (request: PullRequest) => (await hubReady).pull(request),
  };
  const roster = openRoster(join(opts.dir, "devices.json"), opts.now ?? Date.now, log);

  const state = readState(statePath, log);
  const registry = { ...opts.lists, ...bind(opts.registry) };
  const registryStore = registrySyncStore(registry, { log });
  const engine = new SyncEngine({
    store: composeSyncStores([
      [LIBRARY_TABLES, librarySyncStore(opts.store)],
      [REGISTRY_TABLES, registryStore],
    ]),
    backend: hub,
    // Only ever said to itself: this engine's pulls go to `hub` directly, past the roster.
    name: "hub",
    ...(state ? { state } : { device: `hub-${crypto.randomUUID()}` }),
    newDeviceId: () => `hub-${crypto.randomUUID()}`,
    persist: async (s) => writeJson(statePath, s),
    onTouch: () => schedule(),
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const run = (): Promise<void> =>
    engine
      .sync()
      .then(async (stats) => {
        await registryStore.retry();
        if (stats.applied > 0) opts.onApplied?.();
      })
      .catch((err: unknown) => log.error("sync: round failed", err));
  function schedule(): void {
    if (timer) clearTimeout(timer);
    if (stopped) return;
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
        .then(() => adoptRegistry(opts.lists, engine))
        .then(run);

  return {
    store: wrapLibraryStore(opts.store, engine),
    registry: wrapRegistryProvider(opts.registry, opts.lists, engine),
    backend: {
      push: async (s) => {
        await hub.push(s);
        schedule();
      },
      // Noted before the hub answers: a device that reaches it has synced, whatever it then pulls.
      pull: (request) => {
        if (roster.seen(request)) opts.onDevices?.(roster.list());
        return hub.pull(request);
      },
    },
    engine,
    devices: () => roster.list(),
    ready,
    flush: async () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      await ready;
      await run();
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

// The manager's mutations, callable off their instance.
function bind(reg: RegistryMutations): RegistryMutations {
  return {
    add: (url, o) => reg.add(url, o),
    remove: (url) => reg.remove(url),
    install: (url, id) => reg.install(url, id),
    uninstall: (id) => reg.uninstall(id),
    installTracker: (url, id) => reg.installTracker(url, id),
    uninstallTracker: (id) => reg.uninstallTracker(id),
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
function writeJson(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
}

type Roster = {
  /** Note a device's pull. True when the answer to `list()` changed by it. */
  seen(request: Pick<PullRequest, "device" | "name">): boolean;
  list(): SyncDevice[];
};

type RosterFile = Record<string, Omit<SyncDevice, "id">>;

/**
 * Kept in the file whole on every change — it is a few lines per device, and a device pulls once a
 * round, not once a record. A roster that can't be read starts empty; the devices are back in it
 * the next time each syncs.
 */
function openRoster(path: string, now: () => number, log: Pick<Console, "error">): Roster {
  let devices: RosterFile = {};
  if (existsSync(path)) {
    try {
      devices = JSON.parse(readFileSync(path, "utf8")) as RosterFile;
    } catch (err) {
      log.error("sync: device roster unreadable, starting empty", err);
    }
  }
  return {
    seen({ device, name }) {
      const at = now();
      const known = devices[device];
      if (known && known.name === name && known.lastSeenAt === at) return false;
      devices[device] = { name, firstSeenAt: known?.firstSeenAt ?? at, lastSeenAt: at };
      writeJson(path, devices);
      return true;
    },
    list: () =>
      Object.entries(devices)
        .map(([id, d]) => ({ id, ...d }))
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt),
  };
}
