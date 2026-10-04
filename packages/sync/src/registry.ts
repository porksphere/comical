/**
 * Sync over what a device has installed: its saved registries, and the bridges and trackers it
 * installed from them. The record is the INTENT, not the install — "this registry, with this
 * signature policy" and "this bridge, from this registry" — so a device receiving one performs its
 * own add or install (fetching the index, downloading and verifying the bundle) and keeps its own
 * versions and paths. A bridge's settings are their own table (`./settings.ts`).
 *
 * An install is a network operation that can fail while the sync round itself succeeded, and a
 * throw from `write` would hold every record behind it in the same pull — a dead registry must not
 * stop the library from syncing. So a failed intent is kept and retried through `retry()`, which
 * the host calls on its next round, and given up after a few attempts.
 */
import { z } from "zod";
import type { SyncEngine } from "./engine.ts";
import { stableJson, type SyncStore } from "./store.ts";
import { ALL_TABLES, type TableId } from "./tables.ts";

export const REGISTRY_TABLES = ["registries", "installed", "installedTrackers"] as const satisfies readonly TableId[];

/** The mutations both `RegistryManager` (server) and `EmbeddedRegistryProvider` (app) implement. */
export interface RegistryMutations {
  add(rawUrl: string, opts?: { requireSignature?: boolean }): Promise<unknown>;
  remove(rawUrl: string): Promise<void>;
  install(registryUrl: string, bridgeId: string): Promise<unknown>;
  uninstall(bridgeId: string): Promise<void>;
  installTracker(registryUrl: string, trackerId: string): Promise<unknown>;
  uninstallTracker(trackerId: string): Promise<void>;
}

/** What a device holds, read from its own manifest — no network. */
export interface RegistryLists {
  registries(): Promise<ReadonlyArray<{ url: string; requireSignature?: boolean | undefined }>>;
  installed(): Promise<ReadonlyArray<{ id: string; registryUrl: string | null }>>;
  installedTrackers(): Promise<ReadonlyArray<{ id: string; registryUrl: string | null }>>;
}

export type SyncedRegistry = RegistryMutations & RegistryLists;

export interface RegistrySyncStore extends SyncStore {
  /** Re-attempt the intents whose install or add failed. Call once per sync round. */
  retry(): Promise<void>;
  /** How many intents are waiting on a retry. */
  pending(): number;
}

export interface RegistrySyncOptions {
  log?: Pick<Console, "error">;
  /** Attempts before an intent is dropped. */
  maxAttempts?: number;
}

const registryMeta = z.object({ requireSignature: z.boolean().optional() });
const installedMeta = z.object({ registryUrl: z.string().min(1) });

const MAX_ATTEMPTS = 5;

/** What syncs for a record: the intent, with the device's own versions and paths left out. */
function projection(lists: RegistryLists): (table: TableId, id: string) => Promise<unknown> {
  return async (table, id) => {
    switch (table) {
      case "registries": {
        const r = (await lists.registries()).find((x) => x.url === id);
        return r && { requireSignature: r.requireSignature ?? false };
      }
      case "installed":
      case "installedTrackers": {
        // A locally built bridge has no registry, so no other device could install it.
        const b = (await (table === "installed" ? lists.installed() : lists.installedTrackers())).find((x) => x.id === id);
        return b?.registryUrl ? { registryUrl: b.registryUrl } : undefined;
      }
      default:
        return undefined;
    }
  };
}

/** The engine reads from and applies into this; build it over the REAL provider, never the wrapped one. */
export function registrySyncStore(reg: SyncedRegistry, opts: RegistrySyncOptions = {}): RegistrySyncStore {
  const log = opts.log ?? console;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const waiting = new Map<string, { table: TableId; attempts: number; run: () => Promise<void> }>();

  const read = projection(reg);

  // Idempotent against what the device already holds, so a retry (or a re-applied segment) never
  // reinstalls; a value that fails to parse is dropped rather than wedging on it.
  function intent(table: TableId, id: string, value: unknown): (() => Promise<void>) | undefined {
    switch (table) {
      case "registries": {
        if (value === undefined) return async () => void (await reg.remove(id));
        const meta = registryMeta.safeParse(value);
        if (!meta.success) return undefined;
        return async () => {
          if (stableJson(await read(table, id)) === stableJson({ requireSignature: meta.data.requireSignature ?? false })) return;
          await reg.add(id, { requireSignature: meta.data.requireSignature ?? false });
        };
      }
      case "installed":
      case "installedTrackers": {
        const bridge = table === "installed";
        if (value === undefined) return async () => void (await (bridge ? reg.uninstall(id) : reg.uninstallTracker(id)));
        const meta = installedMeta.safeParse(value);
        if (!meta.success) return undefined;
        return async () => {
          if (stableJson(await read(table, id)) === stableJson(meta.data)) return;
          await (bridge ? reg.install(meta.data.registryUrl, id) : reg.installTracker(meta.data.registryUrl, id));
        };
      }
      default:
        return undefined;
    }
  }

  async function attempt(key: string, table: TableId, attempts: number, run: () => Promise<void>): Promise<void> {
    try {
      await run();
      waiting.delete(key);
    } catch (err) {
      if (attempts + 1 >= maxAttempts) {
        waiting.delete(key);
        log.error(`sync: giving up on ${key} after ${attempts + 1} attempts`, err);
        return;
      }
      waiting.set(key, { table, attempts: attempts + 1, run });
    }
  }

  return {
    read,
    async write(table, id, value) {
      const run = intent(table, id, value);
      if (!run) {
        log.error(`sync: dropping ${table} record ${id}: unrecognized value`, value);
        return;
      }
      await attempt(`${table}:${id}`, table, 0, run);
    },
    async retry() {
      // Registries before what was installed from them: the install may have failed only because
      // the add had.
      const order = new Map(ALL_TABLES.map((t, i) => [t, i]));
      const entries = [...waiting.entries()].sort(([, a], [, b]) => order.get(a.table)! - order.get(b.table)!);
      for (const [key, { table, attempts, run }] of entries) await attempt(key, table, attempts, run);
    },
    pending: () => waiting.size,
  };
}

const RECORDED = new Set([
  "add",
  "remove",
  "install",
  "update",
  "uninstall",
  "installTracker",
  "updateTracker",
  "uninstallTracker",
  "confirmMove",
  "dismissMove",
  "confirmAdoption",
]);

/**
 * The provider to hand the router: every mutation goes through to `provider` and whatever it
 * changed in the lists is recorded with the engine. A move confirmation rebinds every install from
 * the old registry, so what changed is found by comparing the lists rather than by knowing each
 * method — and an update, which changes nothing that syncs, records nothing.
 */
export function wrapRegistryProvider<P extends RegistryMutations>(provider: P, lists: RegistryLists, engine: SyncEngine): P {
  const read = projection(lists);

  async function snapshot(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const r of await lists.registries()) out.set(`registries:${r.url}`, stableJson(await read("registries", r.url)));
    for (const b of await lists.installed()) out.set(`installed:${b.id}`, stableJson(await read("installed", b.id)));
    for (const t of await lists.installedTrackers()) {
      out.set(`installedTrackers:${t.id}`, stableJson(await read("installedTrackers", t.id)));
    }
    return out;
  }

  function recorded<T>(write: () => Promise<T>): Promise<T> {
    return engine.exclusive(async () => {
      const before = await snapshot();
      const result = await write();
      const after = await snapshot();
      for (const key of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(key) === after.get(key)) continue;
        const i = key.indexOf(":");
        engine.touch(key.slice(0, i) as TableId, key.slice(i + 1));
      }
      return result;
    });
  }

  return new Proxy(provider, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (!RECORDED.has(String(prop))) return (...args: unknown[]) => fn.apply(target, args);
      return (...args: unknown[]) => recorded(() => Promise.resolve(fn.apply(target, args)));
    },
  });
}

/** Stamp what this device already holds, for a fresh pairing; run after the first pull. */
export async function adoptRegistry(
  lists: RegistryLists,
  engine: SyncEngine,
  tables: readonly TableId[] = REGISTRY_TABLES,
): Promise<void> {
  await engine.exclusive(async () => {
    if (tables.includes("registries")) for (const r of await lists.registries()) engine.adopt("registries", r.url);
    if (tables.includes("installed")) {
      for (const b of await lists.installed()) if (b.registryUrl) engine.adopt("installed", b.id);
    }
    if (tables.includes("installedTrackers")) {
      for (const t of await lists.installedTrackers()) if (t.registryUrl) engine.adopt("installedTrackers", t.id);
    }
  });
}
