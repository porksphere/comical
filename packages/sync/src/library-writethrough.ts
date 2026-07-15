/**
 * Write-through `LibraryStore` wrapper: delegates every call to the real store and, on each
 * mutation, mirrors the change into a `Replica` (stamping an HLC and queueing it for the next push).
 * This is how steady-state edits are captured — as they happen — instead of by re-hydrating (which
 * would re-stamp unchanged rows and could clobber remote edits).
 *
 * Drop it in where a `LibraryStore` is constructed: the app wraps its AsyncStorage store (startup.ts),
 * and the hub wraps its file store (server.ts), passing the same `Replica` to whatever drives sync.
 * Reads pass straight through; only writes are mirrored. Activity is deliberately NOT mirrored — it's
 * derived locally, not synced.
 *
 * `onChange` (optional) fires after each mirrored mutation — used to persist the replica promptly, so
 * a local edit isn't lost if the process dies before the next sync round.
 */
import { entryKey, type ActivityItem, type BridgePrefs, type ChapterProgress, type HistoryItem, type KnownChapter, type LibraryEntry, type LibraryList, type LibraryStore, type SeriesGroup, type TrackerLink } from '@comical/library';
import type { Replica } from './replica.ts';
import { compositeId } from './tables.ts';
import { toProgressFields } from './library-map.ts';

export function wrapLibraryStore(inner: LibraryStore, replica: Replica, onChange?: () => void): LibraryStore {
  const keyOf = (e: LibraryEntry) => entryKey(e.bridgeId, e.seriesId);
  const mark = () => onChange?.();
  return {
    // ── Entries ────────────────────────────────────────────────────────────
    listEntries: () => inner.listEntries(),
    getEntry: (key) => inner.getEntry(key),
    async putEntry(entry: LibraryEntry) {
      await inner.putEntry(entry);
      replica.putRegister('entries', keyOf(entry), entry);
      mark();
    },
    async deleteEntry(key: string) {
      await inner.deleteEntry(key);
      replica.deleteRegister('entries', key); // tombstone drives the cascade on every device
      mark();
    },

    // ── Known chapters ─────────────────────────────────────────────────────
    listChapters: (key) => inner.listChapters(key),
    async putChapters(key: string, chapters: KnownChapter[]) {
      // `putChapters` is a whole-list replace, but the sync records are per chapter — so diff, and
      // emit ONLY what changed. That is the entire point of the chapters table: a refresh that finds
      // three new chapters in a 2000-chapter series pushes three records, not two thousand.
      const before = await inner.listChapters(key);
      await inner.putChapters(key, chapters);

      const now = new Map(chapters.map((c) => [c.id, c]));
      for (const c of chapters) {
        const prev = before.find((p) => p.id === c.id);
        // A KnownChapter is immutable for a given id, so an unchanged one needs no new stamp.
        if (prev && prev.number === c.number && prev.languageCode === c.languageCode) continue;
        replica.putRegister('chapters', compositeId.chapter(key, c.id), c);
      }
      // Delisted upstream: tombstone it, or every other device resurrects it on the next merge.
      for (const p of before) {
        if (!now.has(p.id)) replica.deleteRegister('chapters', compositeId.chapter(key, p.id));
      }
      mark();
    },
    // Chapters cascade with their entry (the entry tombstone drives it) — mirror nothing extra.
    deleteChaptersForEntry: (key) => inner.deleteChaptersForEntry(key),

    // ── Progress ───────────────────────────────────────────────────────────
    listProgress: (key) => inner.listProgress(key),
    async putProgress(key: string, progress: ChapterProgress) {
      await inner.putProgress(key, progress);
      replica.putProgress(compositeId.progress(key, progress.chapterId), toProgressFields(progress));
      mark();
    },
    // Progress cascades with its entry (no per-chapter tombstone) — mirror nothing extra.
    deleteProgressForEntry: (key) => inner.deleteProgressForEntry(key),

    // ── Lists ──────────────────────────────────────────────────────────────
    listLists: () => inner.listLists(),
    async putList(list: LibraryList) {
      await inner.putList(list);
      replica.putRegister('lists', list.id, list);
      mark();
    },
    async deleteList(id: string) {
      await inner.deleteList(id);
      replica.deleteRegister('lists', id);
      mark();
    },

    // ── Groups ───────────────────────────────────────────────────────────────
    listGroups: () => inner.listGroups(),
    async putGroup(group: SeriesGroup) {
      await inner.putGroup(group);
      replica.putRegister('groups', group.id, group);
      mark();
    },
    async deleteGroup(id: string) {
      await inner.deleteGroup(id);
      replica.deleteRegister('groups', id);
      mark();
    },

    // ── Tracker links ────────────────────────────────────────────────────────
    listTrackerLinks: (key) => inner.listTrackerLinks(key),
    async putTrackerLink(key: string, link: TrackerLink) {
      await inner.putTrackerLink(key, link);
      replica.putRegister('trackerLinks', compositeId.trackerLink(key, link.trackerId), link);
      mark();
    },
    async deleteTrackerLink(key: string, trackerId: string) {
      await inner.deleteTrackerLink(key, trackerId);
      replica.deleteRegister('trackerLinks', compositeId.trackerLink(key, trackerId));
      mark();
    },

    // ── Reading log ────────────────────────────────────────────────────────
    listReadingLog: () => inner.listReadingLog(),
    async upsertReadingLog(item: HistoryItem) {
      await inner.upsertReadingLog(item);
      replica.putRegister('readingLog', entryKey(item.bridgeId, item.seriesId), item);
      mark();
    },
    async deleteReadingLog(bridgeId: string, seriesId: string) {
      await inner.deleteReadingLog(bridgeId, seriesId);
      replica.deleteRegister('readingLog', entryKey(bridgeId, seriesId));
      mark();
    },

    // ── Bridge prefs ─────────────────────────────────────────────────────────
    getBridgePrefs: (bridgeId) => inner.getBridgePrefs(bridgeId),
    async setBridgePrefs(bridgeId: string, prefs: BridgePrefs) {
      await inner.setBridgePrefs(bridgeId, prefs);
      replica.putRegister('bridgePrefs', bridgeId, prefs);
      mark();
    },

    // ── Activity (NOT synced — derived locally) ────────────────────────────────
    listActivity: () => inner.listActivity(),
    putActivity: (item: ActivityItem) => inner.putActivity(item),
    deleteActivityForEntry: (key) => inner.deleteActivityForEntry(key),
    clearActivity: () => inner.clearActivity(),
  };
}
