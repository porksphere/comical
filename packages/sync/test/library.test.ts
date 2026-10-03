import { describe, expect, test } from "bun:test";
import { entryKey, InMemoryLibraryStore, Library, type CollectionSeriesItem } from "@comical/library";
import { adoptLibrary, librarySyncStore, MemoryBackend, SyncEngine, wrapLibraryStore, type SyncBackend } from "../src/index.ts";

let wall = 1_700_000_000_000;
const now = () => (wall += 10);
const KEY = entryKey("bridge-a", "s1");

function device(backend: SyncBackend, name: string, inner = new InMemoryLibraryStore()) {
  const engine = new SyncEngine({ store: librarySyncStore(inner, now), backend, device: name, name: () => name, newDeviceId: () => `${name}-2`, now });
  const store = wrapLibraryStore(inner, engine);
  return { inner, engine, store, library: new Library(store, { now }) };
}

async function collect(lib: Library, collectionIds: string[] = []) {
  return lib.collectSeries({ bridgeId: "bridge-a", seriesId: "s1" }, { seriesTitle: "One", collectionIds });
}

const series = async (d: ReturnType<typeof device>) =>
  (await d.inner.getCollectionItem("series:bridge-a:s1")) as CollectionSeriesItem | undefined;

describe("library sync", () => {
  test("a collection and its series reach the other device", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    const c = await a.library.createCollection("Reading");
    await collect(a.library, [c.id]);
    await a.engine.sync();
    await b.engine.sync();
    expect((await b.library.getCollections()).map((x) => x.name)).toEqual(["Reading"]);
    expect((await series(b))?.collectionIds).toEqual([c.id]);
  });

  test("reading on one device doesn't undo a collection edit made on another", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    const c1 = await a.library.createCollection("One");
    await collect(a.library, [c1.id]);
    await a.engine.sync();
    await b.engine.sync();

    const c2 = await b.library.createCollection("Two");
    await b.library.setItemCollections("series:bridge-a:s1", [c1.id, c2.id]);
    await a.library.setProgress(KEY, "ch1", 3, 20, "Chapter 1");
    await b.engine.sync();
    await a.engine.sync();
    await b.engine.sync();

    for (const d of [a, b]) {
      const item = await series(d);
      expect(item?.collectionIds).toEqual([c1.id, c2.id]);
      expect(item?.lastReadChapterId).toBe("ch1");
      expect((await d.library.getProgress(KEY))[0]).toMatchObject({ chapterId: "ch1", lastPage: 3 });
    }
  });

  test("a device's own chapter baseline survives a remote edit to the item", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    const c = await a.library.createCollection("One");
    await collect(a.library, [c.id]);
    await a.engine.sync();
    await b.engine.sync();

    await b.library.syncChapters(KEY, [{ id: "ch1", name: "Chapter 1", number: 1 } as never]);
    const baseline = (await series(b))?.knownChapters;
    expect(baseline?.length).toBe(1);
    expect(b.engine.hasUnsent()).toBe(false);

    await a.library.renameCollection(c.id, "Renamed");
    const c2 = await a.library.createCollection("Two");
    await a.library.setItemCollections("series:bridge-a:s1", [c.id, c2.id]);
    await a.engine.sync();
    await b.engine.sync();
    expect((await series(b))?.collectionIds).toEqual([c.id, c2.id]);
    expect((await series(b))?.knownChapters).toEqual(baseline!);
  });

  test("marking a chapter unread syncs over an earlier read", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await collect(a.library, [(await a.library.createCollection("One")).id]);
    await a.library.markRead(KEY, "ch1", true);
    await a.engine.sync();
    await b.engine.sync();
    expect((await b.library.getProgress(KEY))[0]?.read).toBe(true);

    await b.library.markRead(KEY, "ch1", false);
    await b.engine.sync();
    await a.engine.sync();
    expect((await a.library.getProgress(KEY))[0]?.read).toBe(false);
  });

  test("removing a series removes it everywhere, with its local satellites", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await collect(a.library, [(await a.library.createCollection("One")).id]);
    await a.engine.sync();
    await b.engine.sync();
    await b.inner.putSeriesDetail(KEY, { cachedAt: 1 } as never);

    await a.library.removeSeries(KEY);
    await a.engine.sync();
    await b.engine.sync();
    expect(await series(b)).toBeUndefined();
    expect(await b.inner.getSeriesDetail(KEY)).toBeUndefined();
  });

  test("an existing library adopted after a first pull keeps what the others hold", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const c = await a.library.createCollection("From a");
    await collect(a.library, [c.id]);
    await a.engine.sync();

    const inner = new InMemoryLibraryStore();
    await inner.putCollections([{ id: c.id, name: "Stale", order: 0 }, { id: "local", name: "Only on b", order: 1 }]);
    const b = device(hub, "b", inner);
    await b.engine.sync();
    await adoptLibrary(inner, b.engine);
    await b.engine.sync();
    await a.engine.sync();

    for (const d of [a, b]) {
      expect((await d.library.getCollections()).map((x) => x.name).sort()).toEqual(["From a", "Only on b"]);
    }
  });

  test("a first sync doesn't delete what this device already held", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    // The other device once had the same series and collection, and removed both.
    const gone = await a.library.createCollection("Shelved");
    await collect(a.library, [gone.id]);
    await a.engine.sync();
    await a.library.removeSeries(KEY);
    await a.library.deleteCollection(gone.id);
    await a.engine.sync();

    // This one had them all along, before it ever synced.
    const inner = new InMemoryLibraryStore();
    const before = new Library(inner, { now });
    await inner.putCollections([{ id: gone.id, name: "Shelved", order: 0 }]);
    await collect(before, [gone.id]);

    const b = device(hub, "b", inner);
    await b.engine.sync();
    expect(await series(b)).toBeDefined();
    await adoptLibrary(inner, b.engine);
    await b.engine.sync();
    await a.engine.sync();

    // Kept here, and back on the device that had dropped it — its delete never knew of this copy.
    for (const d of [a, b]) {
      expect((await d.library.getCollections()).map((x) => x.name)).toEqual(["Shelved"]);
      expect((await series(d))?.collectionIds).toEqual([gone.id]);
    }
  });

  test("a series removed elsewhere after the first sync is removed here too", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    await collect(a.library, [(await a.library.createCollection("One")).id]);
    await a.engine.sync();

    const inner = new InMemoryLibraryStore();
    await collect(new Library(inner, { now }));
    const b = device(hub, "b", inner);
    await b.engine.sync();
    await adoptLibrary(inner, b.engine);
    await b.engine.sync();

    // Both devices now hold the one record; removing it is a decision about this copy as well.
    await a.engine.sync();
    await a.library.removeSeries(KEY);
    await a.engine.sync();
    await b.engine.sync();
    expect(await series(b)).toBeUndefined();
  });

  test("a delete still removes a copy that arrived by sync", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const inner = new InMemoryLibraryStore();
    const b = device(hub, "b", inner);
    const c = await a.library.createCollection("One");
    await collect(a.library, [c.id]);
    await a.engine.sync();
    await b.engine.sync();
    await adoptLibrary(inner, b.engine);

    await a.library.removeSeries(KEY);
    await a.library.deleteCollection(c.id);
    await a.engine.sync();
    await b.engine.sync();

    expect(await series(b)).toBeUndefined();
    expect(await b.library.getCollections()).toEqual([]);
  });

  test("adopting carries read state that has no library item or history row to find it by", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");

    // Held before sync was ever on: a series read but never collected, on a bridge with history
    // off (so no reading-log row either), and that bridge's preferences.
    const inner = new InMemoryLibraryStore();
    const before = new Library(inner, { now });
    await before.setBridgePrefs("quiet", { historyDisabled: true });
    await before.setProgress(entryKey("quiet", "unlisted"), "ch1", 4, 20);
    await before.recordRead({ bridgeId: "bridge-a", seriesId: "passing", title: "Passing", lastReadAt: now() });
    await before.setProgress(entryKey("bridge-a", "passing"), "ch9", 1, 20);

    const b = device(hub, "b", inner);
    await b.engine.sync();
    await adoptLibrary(inner, b.engine);
    await b.engine.sync();
    await a.engine.sync();

    expect((await a.library.getProgress(entryKey("quiet", "unlisted")))[0]).toMatchObject({ chapterId: "ch1", lastPage: 4 });
    expect((await a.library.getProgress(entryKey("bridge-a", "passing")))[0]).toMatchObject({ chapterId: "ch9", lastPage: 1 });
    expect(await a.library.getBridgePrefs("quiet")).toMatchObject({ historyDisabled: true });
    expect((await a.inner.listReadingLog()).map((h) => h.seriesId)).toEqual(["passing"]);
  });

  test("a write that only moves device-local fields sends nothing", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    await collect(a.library, [(await a.library.createCollection("One")).id]);
    await a.engine.sync();
    await a.library.syncChapters(KEY, [{ id: "ch1", name: "Chapter 1", number: 1 } as never]);
    expect(a.engine.hasUnsent()).toBe(false);
  });

  describe("activity", () => {
    const chapter = (n: number) => ({ id: `ch${n}`, name: `Chapter ${n}`, number: n });
    const chapters = (n: number) => Array.from({ length: n }, (_, i) => chapter(i + 1));
    const feed = async (d: ReturnType<typeof device>) => (await d.library.getActivity()).map((x) => x.chapterId);

    /** Both devices hold the series, each with its own one-chapter baseline. */
    async function paired() {
      const hub = new MemoryBackend();
      const a = device(hub, "a");
      const b = device(hub, "b");
      await collect(a.library);
      await a.engine.sync();
      await b.engine.sync();
      for (const d of [a, b]) await d.library.syncChapters(KEY, chapters(1));
      return { hub, a, b };
    }

    test("a new chapter one device noticed is in the other's feed, as it was first recorded", async () => {
      const { a, b } = await paired();
      const noticed = await a.library.syncChapters(KEY, chapters(2));
      expect(noticed.fresh.map((x) => x.id)).toEqual(["ch2"]);
      const recorded = (await a.inner.listActivity())[0];
      await a.engine.sync();
      await b.engine.sync();
      expect(await b.inner.listActivity()).toEqual([recorded!]);

      // b's own check finds the chapter new against its baseline, and has nothing to announce.
      const again = await b.library.syncChapters(KEY, chapters(2));
      expect(again.added.map((x) => x.id)).toEqual(["ch2"]);
      expect(again.fresh).toEqual([]);
      expect(await b.inner.listActivity()).toEqual([recorded!]);
      expect(b.engine.hasUnsent()).toBe(false);
    });

    test("two devices noticing the same chapter settle on the first record of it", async () => {
      const { a, b } = await paired();
      await a.library.syncChapters(KEY, chapters(2));
      await b.library.syncChapters(KEY, chapters(2));
      const first = (await a.inner.listActivity())[0]!;
      expect((await b.inner.listActivity())[0]!.detectedAt).toBeGreaterThan(first.detectedAt);
      await b.engine.sync();
      await a.engine.sync();
      await b.engine.sync();
      for (const d of [a, b]) expect(await d.inner.listActivity()).toEqual([first]);
    });

    test("a row swiped away on one device goes from the other, and its check there stays quiet", async () => {
      const { a, b } = await paired();
      await a.library.syncChapters(KEY, chapters(2));
      await a.engine.sync();
      await b.engine.sync();
      await a.library.clearActivityForEntry("bridge-a", "s1");
      await a.engine.sync();
      await b.engine.sync();
      expect(await feed(b)).toEqual([]);

      expect((await b.library.syncChapters(KEY, chapters(2))).fresh).toEqual([]);
      expect(await feed(b)).toEqual([]);
    });

    test("a chapter dismissed elsewhere before this device ever noticed it is never announced here", async () => {
      const { a, b } = await paired();
      await a.library.syncChapters(KEY, chapters(2));
      await a.library.clearActivity();
      await a.engine.sync();
      await b.engine.sync();
      expect((await b.library.syncChapters(KEY, chapters(2))).fresh).toEqual([]);
      expect(await feed(b)).toEqual([]);
    });

    test("clearing the feed clears it everywhere, and leaves later chapters alone", async () => {
      const { a, b } = await paired();
      await a.library.syncChapters(KEY, chapters(3));
      await a.engine.sync();
      await b.engine.sync();
      expect((await feed(b)).sort()).toEqual(["ch2", "ch3"]);

      await b.library.clearActivity();
      await a.library.syncChapters(KEY, chapters(4));
      await b.engine.sync();
      await a.engine.sync();
      await b.engine.sync();
      for (const d of [a, b]) expect(await feed(d)).toEqual(["ch4"]);
    });

    test("the cap is each device's own: pruning sends nothing and nothing undoes it", async () => {
      const { a, b } = await paired();
      await a.library.syncChapters(KEY, chapters(2));
      await a.library.syncChapters(KEY, chapters(3));
      await a.engine.sync();
      await b.engine.sync();

      expect(await a.library.pruneActivity(1)).toBe(1);
      expect(a.engine.hasUnsent()).toBe(false);
      await a.engine.sync();
      await b.engine.sync();
      await a.engine.sync();
      expect(await feed(a)).toEqual(["ch3"]);
      expect(await feed(b)).toEqual(["ch3", "ch2"]);
      // Nor does a's own check put the pruned row back.
      expect((await a.library.syncChapters(KEY, chapters(3))).fresh).toEqual([]);
      expect(await feed(a)).toEqual(["ch3"]);
    });

    test("removing a series takes its feed rows with it on every device", async () => {
      const { a, b } = await paired();
      await a.library.syncChapters(KEY, chapters(2));
      await a.engine.sync();
      await b.engine.sync();
      await b.library.removeSeries(KEY);
      await b.engine.sync();
      await a.engine.sync();
      for (const d of [a, b]) expect(await d.inner.listActivity()).toEqual([]);
    });

    test("feeds from before pairing are joined, less what either side had dismissed", async () => {
      const { hub, a } = await paired();
      await a.library.syncChapters(KEY, chapters(3));
      await a.library.clearActivityForEntry("bridge-a", "s1");
      await a.library.syncChapters(KEY, chapters(4));
      await a.engine.sync();

      // c held the series and a feed of its own before sync was ever on.
      const inner = new InMemoryLibraryStore();
      const solo = new Library(inner, { now });
      await solo.collectSeries({ bridgeId: "bridge-a", seriesId: "s1" }, { seriesTitle: "One" });
      await solo.syncChapters(KEY, chapters(1));
      await solo.syncChapters(KEY, [...chapters(3), chapter(5)]);
      const c = device(hub, "c", inner);
      await c.engine.sync();
      await adoptLibrary(inner, c.engine);
      await c.engine.sync();
      await a.engine.sync();

      for (const d of [a, c]) expect((await feed(d)).sort()).toEqual(["ch4", "ch5"]);
    });

    test("a device already syncing adopts the feed it had when the table began to sync", async () => {
      const { a, b } = await paired();
      await a.inner.putActivity({ bridgeId: "bridge-a", seriesId: "s1", chapterId: "ch2", title: "One", detectedAt: 5 });
      await a.engine.sync();
      expect(a.engine.hasUnsent()).toBe(false);

      await adoptLibrary(a.inner, a.engine, ["activity"]);
      await a.engine.sync();
      await b.engine.sync();
      expect(await feed(b)).toEqual(["ch2"]);
    });

    test("a row for a series this library doesn't hold, or one that doesn't validate, is dropped", async () => {
      const inner = new InMemoryLibraryStore();
      const store = librarySyncStore(inner);
      const row = { bridgeId: "bridge-a", seriesId: "s1", chapterId: "ch2", title: "One", detectedAt: 5 };
      await store.write("activity", "bridge-a:s1:ch2", row);
      expect(await inner.listActivity()).toEqual([]);

      await new Library(inner, { now }).collectSeries({ bridgeId: "bridge-a", seriesId: "s1" }, { seriesTitle: "One" });
      await store.write("activity", "bridge-a:s1:ch2", { ...row, detectedAt: "then" });
      await store.write("activity", "bridge-a:s1:other", row);
      expect(await inner.listActivity()).toEqual([]);

      await store.write("activity", "bridge-a:s1:ch2", row);
      expect(await store.read("activity", "bridge-a:s1:ch2")).toEqual(row);
      await store.write("activity", "bridge-a:s1:ch2", undefined);
      expect(await inner.listActivity()).toEqual([]);
    });
  });

  test("a remote record that doesn't validate is dropped, not applied", async () => {
    const inner = new InMemoryLibraryStore();
    const store = librarySyncStore(inner);
    await store.write("collections", "c", { id: "c", name: "" });
    await store.write("groups", "g", { id: "other" });
    expect(await inner.listCollections()).toEqual([]);
    expect(await inner.listGroups()).toEqual([]);
  });
});
