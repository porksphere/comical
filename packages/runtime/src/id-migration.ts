/**
 * Id migrations: when a bridge update changes the ids it gives its series or chapters, move this
 * device's records onto the new ids before anything else talks to the bridge.
 *
 * `withIdMigration` wraps a host's bridge provider. The first `get` of a bridge at a version this
 * device hasn't migrated for asks the bridge (`Bridge.migrateIds`) to translate every id the library
 * and downloads hold for it, applies the answer, and records the version (the "mark"). Until then
 * every `get` of that bridge waits, so no request reaches the bridge with an id it no longer knows.
 * A bridge without `migrateIds` just has its mark set. The mark is device-local: synced records
 * arrive already moved, but each device still has its own caches and downloads to move.
 *
 * A run that doesn't finish — offline, the bridge threw, a chapter was mid-download — leaves the
 * mark alone and lets the bridge load anyway; it runs again on the bridge's next invalidate/refresh
 * or the next start. Applying the same answer twice is harmless, so a retry just finishes the job.
 */
import type { IdMigrationRequest, LogCapability } from "@comical/contract";
import type { LoadedBridge } from "@comical/core/loader";
import type { IdRemap, Library } from "@comical/library";

/** Downloads, as the migration sees them: what it holds for a bridge, and moving it. */
export interface IdMigrationDownloads {
  idReferences(bridgeId: string): Promise<Map<string, Set<string>>>;
  /** `deferred`: something stayed on its old id and the run must repeat. */
  remapIds(bridgeId: string, remap: IdRemap): Promise<{ deferred: boolean }>;
}

export interface IdMigrationOptions {
  /** Resolved on each run: hosts build the library after the provider it wraps. */
  library: () => Library | undefined;
  downloads?: () => IdMigrationDownloads | undefined;
  log?: LogCapability;
  /** A bridge's records moved — anything caching them by id should drop what it holds. */
  onMigrated?: (bridgeId: string) => void;
  /** Series per `migrateIds` call. Default 25. */
  batchSize?: number;
}

interface Settled {
  version: string;
  generation: number;
}

/**
 * `provider`, with `get` held back until the bridge's ids are migrated. Every other member passes
 * straight through; `invalidate` and `refresh` also forget a run that didn't finish, so it retries.
 */
export function withIdMigration<P extends { get(id: string): Promise<LoadedBridge> }>(provider: P, opts: IdMigrationOptions): P {
  const settled = new Map<string, Settled>();
  const running = new Map<string, Promise<void>>();
  const batchSize = Math.max(1, opts.batchSize ?? 25);

  const ensure = async (bridge: LoadedBridge): Promise<void> => {
    const library = opts.library();
    if (!library) return;
    const { id, version } = bridge.info;
    const done = settled.get(id);
    if (done && done.version === version && done.generation === library.idMigrationGeneration) return;
    let run = running.get(id);
    if (!run) {
      const generation = library.idMigrationGeneration;
      run = migrate(bridge, library)
        .catch((e) => opts.log?.warn(`id migration for ${id} failed: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => {
          settled.set(id, { version, generation });
          running.delete(id);
        });
      running.set(id, run);
    }
    await run;
  };

  const migrate = async (bridge: LoadedBridge, library: Library): Promise<void> => {
    const { id, version } = bridge.info;
    const mark = await library.idMigrationMark(id);
    if (mark === version) return;
    if (!bridge.migrateIds) {
      await library.setIdMigrationMark(id, version);
      return;
    }
    const downloads = opts.downloads?.();
    const refs = await library.idReferences(id);
    for (const [s, chapters] of (await downloads?.idReferences(id)) ?? []) {
      const into = refs.get(s);
      if (into) for (const c of chapters) into.add(c);
      else refs.set(s, new Set(chapters));
    }
    if (refs.size === 0) {
      await library.setIdMigrationMark(id, version);
      return;
    }

    const series = new Map<string, string>();
    const chapters = new Map<string, Map<string, string>>();
    let complete = true;
    const all = [...refs];
    for (let i = 0; i < all.length; i += batchSize) {
      const batch = all.slice(i, i + batchSize);
      const req: IdMigrationRequest = {
        fromVersion: mark ?? null,
        series: batch.map(([sid, cids]) => ({ id: sid, chapterIds: [...cids] })),
      };
      const asked = new Set(batch.map(([sid]) => sid));
      const res = await bridge.migrateIds(req);
      if (res.failed?.length) complete = false;
      for (const s of res.series) {
        // Only what was asked about: an answer can't move records the device didn't name.
        if (!asked.has(s.id)) continue;
        if (s.newId && s.newId !== s.id) series.set(s.id, s.newId);
        const moved = (s.chapters ?? []).filter((c) => c.newId !== c.id);
        if (moved.length > 0) chapters.set(s.id, new Map(moved.map((c) => [c.id, c.newId])));
      }
    }

    const remap: IdRemap = { series, chapters };
    if (series.size > 0 || chapters.size > 0) {
      await library.remapIds(id, remap);
      if (downloads && (await downloads.remapIds(id, remap)).deferred) complete = false;
      opts.log?.info(`id migration for ${id}: moved ${series.size} series, chapters of ${chapters.size}`);
      opts.onMigrated?.(id);
    }
    // Last, so an interrupted run is never mistaken for a finished one.
    if (complete) await library.setIdMigrationMark(id, version);
  };

  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === "get") {
        return async (id: string) => {
          const bridge = await target.get(id);
          await ensure(bridge);
          return bridge;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (prop === "invalidate" && typeof value === "function") {
        return (id: string, ...rest: unknown[]) => {
          settled.delete(id);
          return value.call(receiver, id, ...rest);
        };
      }
      if (prop === "refresh" && typeof value === "function") {
        return (...args: unknown[]) => {
          settled.clear();
          return value.apply(receiver, args);
        };
      }
      return typeof value === "function" ? value.bind(receiver) : value;
    },
  });
}

/**
 * Migrate, now, every installed bridge that has ids to migrate and records here — rather than when
 * the user next opens one. `provider` should be the `withIdMigration` one: loading a bridge is what
 * runs it. Errors are logged and skipped.
 */
export async function migrateInstalledBridges(
  provider: { list(): Promise<Array<{ info: { id: string; version: string; migratesIds?: boolean | undefined } }>>; get(id: string): Promise<unknown> },
  library: Library,
  log?: LogCapability,
): Promise<void> {
  const referenced = new Set(await library.referencedBridgeIds());
  for (const { info } of await provider.list()) {
    if (!info.migratesIds || !referenced.has(info.id)) continue;
    if ((await library.idMigrationMark(info.id)) === info.version) continue;
    try {
      await provider.get(info.id);
    } catch (e) {
      log?.warn(`id migration for ${info.id}: could not load: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
