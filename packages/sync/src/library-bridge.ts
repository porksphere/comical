/**
 * StoreBridge over `@comical/library`'s `LibraryStore` — the concrete mapping between the real
 * library model and sync envelopes. Works against any `LibraryStore` (native AsyncStorage store,
 * server file store, or the in-memory reference), since it only uses the interface.
 *
 * Table mapping (see docs/CROSS-DEVICE-SYNC.md):
 *   entries, chapters, lists, groups, trackerLinks, readingLog, bridgePrefs → register (LWW + tombstone)
 *   progress                                                                 → monotonic (furthest-read wins)
 *   activity                                                                 → NOT synced (derived locally)
 *
 * Three decisions the real model forces, made explicit here:
 *
 * 1. **The library entry is synced whole, as one LWW register — including its resume cache**
 *    (`lastReadChapterId/Name/At`). Those cache fields are a denormalization of the authoritative,
 *    monotonically-merged `progress` table. Under LWW a concurrent non-read edit (e.g. favouriting on
 *    another device) can momentarily win the whole entry and carry a slightly stale cache — but the
 *    actual read position is never lost, because it lives in `progress`, and the cache self-heals the
 *    next time the `Library` service recomputes resume state from progress. Field-level CRDTs for the
 *    entry (per-field registers, list membership as an OR-set) are a later refinement, not needed now.
 *
 *    That the entry travels whole is only affordable because it is now SMALL. Chapter lists used to
 *    live on it, which made a long series a 73KB register — and since the resume cache above is
 *    touched on every page turn, every page turn pushed all 73KB. Hence:
 *
 * 2. **Chapters are their own table, one register per chapter.** A `KnownChapter` never changes for
 *    a given (entry, chapter), so LWW is trivially correct and the records go quiet after the first
 *    sync; a newly published chapter costs ~100 bytes instead of a whole-list rewrite. They are
 *    deleted explicitly (a delisted chapter must be tombstoned, or every device resurrects it) and
 *    cascade with their entry, like progress.
 *
 * 3. **`ChapterProgress.updatedAt` is reconstructed from the envelope's HLC physical time** on the
 *    way back into the store. The monotonic merge already picked the furthest read; `updatedAt` is
 *    only a display timestamp, so deriving it from the winning stamp keeps it consistent with the
 *    merged position without needing a separate synced field.
 */
import { entryKey, type BridgePrefs, type HistoryItem, type KnownChapter, type LibraryEntry, type LibraryList, type LibraryStore, type SeriesGroup, type TrackerLink } from '@comical/library';
import type { Replica } from './replica.ts';
import { compositeId, splitCompositeId } from './tables.ts';
import type { StoreBridge } from './store-bridge.ts';
import { fromProgress, toProgressFields } from './library-map.ts';

/** Order-insensitive: the replica iterates chapters in record order, the store keeps source order. */
function sameChapters(a: KnownChapter[], b: KnownChapter[]): boolean {
  if (a.length !== b.length) return false;
  const key = (c: KnownChapter) => `${c.id}|${c.number ?? ''}|${c.languageCode ?? ''}`;
  const seen = new Set(a.map(key));
  return b.every((c) => seen.has(key(c)));
}

export class LibraryStoreBridge implements StoreBridge {
  constructor(private readonly store: LibraryStore) {}

  /** Distinct bridge ids referenced by the library (LibraryStore has no way to enumerate prefs). */
  private async bridgeIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const e of await this.store.listEntries()) ids.add(e.bridgeId);
    for (const h of await this.store.listReadingLog()) ids.add(h.bridgeId);
    return [...ids];
  }

  async hydrate(replica: Replica): Promise<void> {
    const entries = await this.store.listEntries();
    for (const e of entries) {
      const key = entryKey(e.bridgeId, e.seriesId);
      replica.putRegister('entries', key, e);
      for (const c of await this.store.listChapters(key)) {
        replica.putRegister('chapters', compositeId.chapter(key, c.id), c);
      }
      for (const p of await this.store.listProgress(key)) {
        replica.putProgress(compositeId.progress(key, p.chapterId), toProgressFields(p));
      }
      for (const link of await this.store.listTrackerLinks(key)) {
        replica.putRegister('trackerLinks', compositeId.trackerLink(key, link.trackerId), link);
      }
    }
    for (const l of await this.store.listLists()) replica.putRegister('lists', l.id, l);
    for (const g of await this.store.listGroups()) replica.putRegister('groups', g.id, g);
    for (const h of await this.store.listReadingLog()) {
      replica.putRegister('readingLog', entryKey(h.bridgeId, h.seriesId), h);
    }
    for (const bridgeId of await this.bridgeIds()) {
      const prefs = await this.store.getBridgePrefs(bridgeId);
      if (prefs) replica.putRegister('bridgePrefs', bridgeId, prefs);
    }
  }

  async apply(replica: Replica): Promise<void> {
    await this.applyEntries(replica);
    await this.applyChapters(replica);
    await this.applyProgress(replica);
    await this.applyRegisterList<LibraryList>(replica, 'lists', await this.store.listLists(), (l) => l.id, (l) => this.store.putList(l), (id) => this.store.deleteList(id));
    await this.applyRegisterList<SeriesGroup>(replica, 'groups', await this.store.listGroups(), (g) => g.id, (g) => this.store.putGroup(g), (id) => this.store.deleteGroup(id));
    await this.applyTrackerLinks(replica);
    await this.applyReadingLog(replica);
    await this.applyBridgePrefs(replica);
  }

  // ── entries (with cascade on delete, mirroring what the Library service does) ────────────────
  private async applyEntries(replica: Replica): Promise<void> {
    const live = new Set(replica.liveIds('entries'));
    for (const id of live) {
      const e = replica.registerValue<LibraryEntry>('entries', id);
      if (e) await this.store.putEntry(e);
    }
    for (const e of await this.store.listEntries()) {
      const key = entryKey(e.bridgeId, e.seriesId);
      if (!live.has(key)) {
        await this.store.deleteEntry(key);
        await this.store.deleteChaptersForEntry(key);
        await this.store.deleteProgressForEntry(key);
        await this.store.deleteActivityForEntry(key);
      }
    }
  }

  // ── chapters (per-chapter registers, re-collected into the store's per-series list) ───────────
  private async applyChapters(replica: Replica): Promise<void> {
    const liveEntries = new Set(replica.liveIds('entries'));

    // Only rebuild the list for entries the replica actually holds chapter records for — counting
    // TOMBSTONED ones, which is why this walks `all()` rather than `liveIds`. Two things fall out:
    // an entry whose chapters were all delisted correctly ends up with an empty list, and an entry
    // the replica knows nothing about keeps whatever is on disk (a device that hasn't hydrated its
    // chapters yet must not wipe them). Entries deleted elsewhere are skipped, like progress below,
    // so the cascade in applyEntries isn't undone.
    const known = new Set<string>();
    for (const r of replica.all()) {
      if (r.table !== 'chapters') continue;
      const [key] = splitCompositeId(r.id);
      if (liveEntries.has(key)) known.add(key);
    }

    const byEntry = new Map<string, KnownChapter[]>();
    for (const key of known) byEntry.set(key, []);
    for (const id of replica.liveIds('chapters')) {
      const [key] = splitCompositeId(id);
      const list = byEntry.get(key);
      if (!list) continue;
      const c = replica.registerValue<KnownChapter>('chapters', id);
      if (c) list.push(c);
    }

    // apply() runs every sync round; only write when the list actually differs, or a device with a
    // 2000-chapter series would rewrite it on every round for nothing.
    for (const [key, chapters] of byEntry) {
      if (!sameChapters(await this.store.listChapters(key), chapters)) {
        await this.store.putChapters(key, chapters);
      }
    }
  }

  // ── progress (monotonic; never individually deleted — cascades with its entry) ───────────────
  private async applyProgress(replica: Replica): Promise<void> {
    // Only materialise progress for entries still in the library. Progress has no tombstone of its
    // own; it cascades with its entry, so an entry removed elsewhere must not have its (still-live)
    // progress envelope re-written back into the store here — otherwise the cascade delete undoes.
    const liveEntries = new Set(replica.liveIds('entries'));
    for (const id of replica.liveIds('progress')) {
      const [key, chapterId] = splitCompositeId(id);
      if (!liveEntries.has(key)) continue;
      const env = replica.progress(id);
      if (env) await this.store.putProgress(key, fromProgress(chapterId, env));
    }
  }

  private async applyTrackerLinks(replica: Replica): Promise<void> {
    const live = new Set(replica.liveIds('trackerLinks'));
    for (const id of live) {
      const link = replica.registerValue<TrackerLink>('trackerLinks', id);
      if (link) {
        const [key] = splitCompositeId(id);
        await this.store.putTrackerLink(key, link);
      }
    }
    // Delete tombstoned links that still exist in the store.
    for (const e of await this.store.listEntries()) {
      const key = entryKey(e.bridgeId, e.seriesId);
      for (const link of await this.store.listTrackerLinks(key)) {
        if (!live.has(compositeId.trackerLink(key, link.trackerId))) {
          await this.store.deleteTrackerLink(key, link.trackerId);
        }
      }
    }
  }

  private async applyReadingLog(replica: Replica): Promise<void> {
    const live = new Set(replica.liveIds('readingLog'));
    for (const id of live) {
      const item = replica.registerValue<HistoryItem>('readingLog', id);
      if (item) await this.store.upsertReadingLog(item);
    }
    for (const h of await this.store.listReadingLog()) {
      if (!live.has(entryKey(h.bridgeId, h.seriesId))) await this.store.deleteReadingLog(h.bridgeId, h.seriesId);
    }
  }

  // BridgePrefs have no delete in LibraryStore — upsert live values only.
  private async applyBridgePrefs(replica: Replica): Promise<void> {
    for (const id of replica.liveIds('bridgePrefs')) {
      const prefs = replica.registerValue<BridgePrefs>('bridgePrefs', id);
      if (prefs) await this.store.setBridgePrefs(id, prefs);
    }
  }

  /** Shared upsert-live / delete-tombstoned reconcile for a plain register table. */
  private async applyRegisterList<T>(
    replica: Replica,
    table: 'lists' | 'groups',
    current: T[],
    idOf: (v: T) => string,
    put: (v: T) => Promise<void>,
    del: (id: string) => Promise<void>,
  ): Promise<void> {
    const live = new Set(replica.liveIds(table));
    for (const id of live) {
      const v = replica.registerValue<T>(table, id);
      if (v) await put(v);
    }
    for (const v of current) {
      if (!live.has(idOf(v))) await del(idOf(v));
    }
  }
}
