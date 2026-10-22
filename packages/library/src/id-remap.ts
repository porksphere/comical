/**
 * Moving one bridge's records onto new ids, for a bridge update that changed the ids it gives its
 * series or chapters. Everything keyed by an id moves together: collected items, progress, the
 * reading log, activity, tracker links, groups, and the offline detail/chapter caches.
 *
 * Every step writes the new record before it removes the old one, so an interrupted run leaves a
 * duplicate rather than a gap, and running it again finishes the job. Where the new id already has
 * a record of its own (the user re-collected the series under its new id before the migration
 * ran), the two are merged: nothing the user did is dropped.
 */
import {
  activityKey,
  collectionItemId,
  entryKey,
  parseEntryKey,
  type ChapterProgress,
  type CollectionItem,
  type CollectionSeriesItem,
  type HistoryItem,
  type KnownChapter,
} from "./models.ts";
import type { LibraryStore } from "./store.ts";

/** Old → new ids for one bridge. `chapters` is keyed by the OLD series id. An id with no entry keeps it. */
export interface IdRemap {
  series: ReadonlyMap<string, string>;
  chapters: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** The chapter id a chapterless series' records carry. A placeholder, never one of the bridge's ids. */
const DIRECT_CHAPTER_ID = "__direct__";

/**
 * Every series of `bridgeId` the library holds anything under, with the chapter ids it holds for
 * each — what a bridge is asked to translate. Groups and progress count: a series can be in either
 * with no collected item.
 */
export async function libraryIdReferences(store: LibraryStore, bridgeId: string): Promise<Map<string, Set<string>>> {
  const refs = new Map<string, Set<string>>();
  const note = (seriesId: string, chapterId?: string) => {
    let chapters = refs.get(seriesId);
    if (!chapters) refs.set(seriesId, (chapters = new Set()));
    if (chapterId !== undefined && chapterId !== DIRECT_CHAPTER_ID) chapters.add(chapterId);
  };

  for (const item of await store.listCollectionItems({ bridgeId })) {
    if (item.type === "series") {
      note(item.seriesId, item.lastReadChapterId);
      for (const k of item.knownChapters ?? []) note(item.seriesId, k.id);
    } else {
      note(item.seriesId, item.chapterId);
    }
  }
  for (const h of await store.listReadingLog()) {
    if (h.bridgeId === bridgeId) note(h.seriesId, h.lastReadChapterId);
  }
  for (const a of await store.listActivity()) {
    if (a.bridgeId === bridgeId) note(a.seriesId, a.kind === "removed" ? undefined : a.chapterId);
  }
  for (const g of await store.listGroups()) {
    for (const key of g.memberKeys) {
      const ref = parseEntryKey(key);
      if (ref.bridgeId === bridgeId) note(ref.seriesId);
    }
  }
  for (const key of await store.listProgressKeys()) {
    const ref = parseEntryKey(key);
    if (ref.bridgeId !== bridgeId) continue;
    const progress = await store.listProgress(key);
    if (progress.length === 0) continue;
    for (const p of progress) note(ref.seriesId, p.chapterId);
  }
  for (const seriesId of refs.keys()) {
    for (const c of (await store.getCachedChapters(entryKey(bridgeId, seriesId)))?.chapters ?? []) note(seriesId, c.id);
  }
  return refs;
}

/** Apply `remap` to every record of `bridgeId`. Idempotent: a record already on its new id is left alone. */
export async function remapLibraryIds(store: LibraryStore, bridgeId: string, remap: IdRemap): Promise<void> {
  const seriesTo = (s: string) => remap.series.get(s) ?? s;
  const chapterTo = (s: string, c: string) => remap.chapters.get(s)?.get(c) ?? c;
  const touched = new Set([...remap.series.keys(), ...remap.chapters.keys()]);
  if (touched.size === 0) return;

  for (const s of touched) {
    const ns = seriesTo(s);
    const ch = (c: string) => chapterTo(s, c);
    const key = entryKey(bridgeId, s);
    const nkey = entryKey(bridgeId, ns);
    await moveItems(store, bridgeId, s, ns, ch);
    await moveProgress(store, key, nkey, ch);
    if (nkey !== key) {
      await moveDetail(store, key, nkey, ns);
      await moveTrackerLinks(store, key, nkey);
    }
    await moveCachedChapters(store, key, nkey, ch);
  }

  for (const h of await store.listReadingLog()) {
    if (h.bridgeId !== bridgeId || !touched.has(h.seriesId)) continue;
    const moved: HistoryItem = { ...h, seriesId: seriesTo(h.seriesId) };
    if (h.lastReadChapterId !== undefined) moved.lastReadChapterId = chapterTo(h.seriesId, h.lastReadChapterId);
    if (moved.seriesId === h.seriesId && moved.lastReadChapterId === h.lastReadChapterId) continue;
    const there = moved.seriesId === h.seriesId
      ? undefined
      : (await store.listReadingLog()).find((x) => x.bridgeId === bridgeId && x.seriesId === moved.seriesId);
    if (!there || there.lastReadAt < moved.lastReadAt) await store.upsertReadingLog(moved);
    if (moved.seriesId !== h.seriesId) await store.deleteReadingLog(bridgeId, h.seriesId);
  }

  const dropped: string[] = [];
  for (const a of await store.listActivity()) {
    if (a.bridgeId !== bridgeId || !touched.has(a.seriesId)) continue;
    const moved = {
      ...a,
      seriesId: seriesTo(a.seriesId),
      // A removal event's chapterId names the removal, not a chapter.
      chapterId: a.kind === "removed" ? a.chapterId : chapterTo(a.seriesId, a.chapterId),
    };
    if (moved.seriesId === a.seriesId && moved.chapterId === a.chapterId) continue;
    await store.putActivity(moved);
    dropped.push(activityKey(bridgeId, a.seriesId, a.chapterId));
  }
  // Dropped, not removed: removing would tell every other device the user cleared these events,
  // when each of them is about to move its own copy instead.
  if (dropped.length > 0) await store.dropActivity(dropped);

  const keyTo = (k: string) => {
    const ref = parseEntryKey(k);
    return ref.bridgeId === bridgeId ? entryKey(bridgeId, seriesTo(ref.seriesId)) : k;
  };
  for (const g of await store.listGroups()) {
    const memberKeys = [...new Set(g.memberKeys.map(keyTo))];
    const primaryKey = keyTo(g.primaryKey);
    if (primaryKey === g.primaryKey && memberKeys.length === g.memberKeys.length && memberKeys.every((k, i) => k === g.memberKeys[i])) continue;
    if (memberKeys.length >= 2) {
      await store.putGroup({ ...g, primaryKey, memberKeys });
      continue;
    }
    // Two members turned out to be one series: a group of one isn't a group.
    await store.deleteGroup(g.id);
    for (const k of memberKeys) {
      const ref = parseEntryKey(k);
      const item = await store.getCollectionItem(collectionItemId({ type: "series", ...ref }));
      if (item?.type === "series" && item.seriesGroupId === g.id) {
        const ungrouped = { ...item };
        delete ungrouped.seriesGroupId;
        await store.putCollectionItems([ungrouped]);
      }
    }
  }
}

async function moveItems(store: LibraryStore, bridgeId: string, s: string, ns: string, ch: (c: string) => string): Promise<void> {
  const items = await store.listCollectionItems({ bridgeId, seriesId: s });
  const next = new Map<string, CollectionItem>();
  const replaced: string[] = [];
  for (const item of items) {
    const moved = moveItem(item, bridgeId, ns, ch);
    if (moved.id === item.id && JSON.stringify(moved) === JSON.stringify(item)) continue;
    if (moved.id !== item.id) replaced.push(item.id);
    const there = next.get(moved.id) ?? (moved.id !== item.id ? await store.getCollectionItem(moved.id) : undefined);
    next.set(moved.id, there && there.type === moved.type ? mergeMoved(there, moved) : moved);
  }
  if (next.size > 0) await store.putCollectionItems([...next.values()]);
  const gone = replaced.filter((id) => !next.has(id));
  if (gone.length > 0) await store.deleteCollectionItems(gone);
}

function moveItem(item: CollectionItem, bridgeId: string, ns: string, ch: (c: string) => string): CollectionItem {
  if (item.type === "series") {
    const moved: CollectionSeriesItem = {
      ...item,
      seriesId: ns,
      id: collectionItemId({ type: "series", bridgeId, seriesId: ns }),
      knownChapters: dedupeKnown((item.knownChapters ?? []).map((k) => ({ ...k, id: ch(k.id) }))),
    };
    if (item.lastReadChapterId !== undefined) moved.lastReadChapterId = ch(item.lastReadChapterId);
    // The fingerprint was taken over the old ids; without it the next check does a full fetch.
    if (moved.knownChapters.some((k, i) => k.id !== item.knownChapters?.[i]?.id)) delete moved.revision;
    return moved;
  }
  const chapterId = ch(item.chapterId);
  if (item.type === "chapter") {
    return { ...item, seriesId: ns, chapterId, id: collectionItemId({ type: "chapter", bridgeId, seriesId: ns, chapterId }) };
  }
  return {
    ...item,
    seriesId: ns,
    chapterId,
    id: collectionItemId({ type: "page", bridgeId, seriesId: ns, chapterId, pageIndex: item.pageIndex }),
  };
}

function dedupeKnown(known: KnownChapter[]): KnownChapter[] {
  const seen = new Set<string>();
  return known.filter((k) => !seen.has(k.id) && !!seen.add(k.id));
}

/**
 * `there` is already on the new id; `moved` just arrived from the old one. The earlier collect date
 * and every collection membership survive; for a series, the more recent read wins and the chapter
 * baselines join.
 */
function mergeMoved(there: CollectionItem, moved: CollectionItem): CollectionItem {
  const merged = {
    ...moved,
    ...there,
    collectedAt: Math.min(there.collectedAt, moved.collectedAt),
    collectionIds: [...new Set([...there.collectionIds, ...moved.collectionIds])],
  } as CollectionItem;
  if (there.stale === true && moved.stale === true) merged.stale = true;
  else delete merged.stale;
  if (merged.type !== "series" || there.type !== "series" || moved.type !== "series") return merged;

  const later = (moved.lastReadAt ?? 0) > (there.lastReadAt ?? 0) ? moved : there;
  for (const field of ["lastReadChapterId", "lastReadChapterName", "lastReadAt"] as const) {
    if (later[field] === undefined) delete merged[field];
    else (merged as Record<string, unknown>)[field] = later[field];
  }
  merged.knownChapters = dedupeKnown([...(there.knownChapters ?? []), ...(moved.knownChapters ?? [])]);
  delete merged.revision;
  if (merged.seriesGroupId === undefined && moved.seriesGroupId !== undefined) merged.seriesGroupId = moved.seriesGroupId;
  return merged;
}

async function moveProgress(store: LibraryStore, key: string, nkey: string, ch: (c: string) => string): Promise<void> {
  const progress = await store.listProgress(key);
  if (progress.length === 0) return;
  const there = new Map((nkey === key ? [] : await store.listProgress(nkey)).map((p) => [p.chapterId, p]));
  const landed = new Set<string>();
  const left: string[] = [];
  for (const p of progress) {
    const chapterId = ch(p.chapterId);
    if (nkey === key && chapterId === p.chapterId) continue;
    const existing = there.get(chapterId) ?? (nkey === key ? progress.find((x) => x.chapterId === chapterId) : undefined);
    const moved = existing ? mergeProgress(existing, { ...p, chapterId }) : { ...p, chapterId };
    if (!existing || JSON.stringify(moved) !== JSON.stringify(existing)) await store.putProgress(nkey, moved);
    there.set(chapterId, moved);
    landed.add(chapterId);
    left.push(p.chapterId);
  }
  if (nkey !== key) await store.deleteProgressForEntry(key);
  else {
    const gone = left.filter((id) => !landed.has(id));
    if (gone.length > 0) await store.deleteProgress(key, gone);
  }
}

/**
 * Two records of one chapter, merged forward only: read if either is, the furthest page. Never the
 * newer one outright — sync has no progress deletes, so a device that already moved this chapter
 * leaves the old id behind here as a fresh unread row, and taking that would un-read the chapter.
 */
function mergeProgress(a: ChapterProgress, b: ChapterProgress): ChapterProgress {
  const [older, newer] = a.updatedAt <= b.updatedAt ? [a, b] : [b, a];
  const merged: ChapterProgress = { ...older, ...newer, read: a.read || b.read, updatedAt: newer.updatedAt };
  const lastPage = Math.max(a.lastPage ?? 0, b.lastPage ?? 0);
  const pageCount = Math.max(a.pageCount ?? 0, b.pageCount ?? 0);
  if (a.lastPage !== undefined || b.lastPage !== undefined) merged.lastPage = lastPage;
  if (a.pageCount !== undefined || b.pageCount !== undefined) merged.pageCount = pageCount;
  return merged;
}

async function moveDetail(store: LibraryStore, key: string, nkey: string, ns: string): Promise<void> {
  const detail = await store.getSeriesDetail(key);
  if (!detail) return;
  const there = await store.getSeriesDetail(nkey);
  if (!there || there.cachedAt < detail.cachedAt) {
    await store.putSeriesDetail(nkey, { ...detail, info: { ...detail.info, id: ns } });
  }
  await store.deleteSeriesDetail(key);
}

async function moveCachedChapters(store: LibraryStore, key: string, nkey: string, ch: (c: string) => string): Promise<void> {
  const doc = await store.getCachedChapters(key);
  if (!doc) return;
  const chapters = doc.chapters.map((c) => ({ ...c, id: ch(c.id) }));
  const changed = chapters.some((c, i) => c.id !== doc.chapters[i]!.id);
  if (nkey === key && !changed) return;
  const there = nkey === key ? undefined : await store.getCachedChapters(nkey);
  if (!there || there.cachedAt < doc.cachedAt) await store.putCachedChapters(nkey, { ...doc, chapters });
  if (nkey !== key) await store.deleteCachedChapters(key);
}

async function moveTrackerLinks(store: LibraryStore, key: string, nkey: string): Promise<void> {
  const links = await store.listTrackerLinks(key);
  if (links.length === 0) return;
  const there = new Set((await store.listTrackerLinks(nkey)).map((l) => l.trackerId));
  for (const link of links) {
    if (!there.has(link.trackerId)) await store.putTrackerLink(nkey, link);
  }
  for (const link of links) await store.deleteTrackerLink(key, link.trackerId);
}
