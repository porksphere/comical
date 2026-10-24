import { describe, expect, test } from "bun:test";
import { InMemoryLibraryStore, type CollectionItem, type LibraryStore } from "@comical/library";
import { libraryStoreConformance } from "../src/conformance.ts";

describe("InMemoryLibraryStore conformance", () => {
  for (const c of libraryStoreConformance(() => new InMemoryLibraryStore())) test(c.name, c.run);
});

/**
 * How `FileLibraryStore` kept its collection items: a cache that hands out, and keeps, the very
 * objects it is given. The suite has to fail it — on isolation, and on the recordings it cost.
 */
function byReference(): LibraryStore {
  const inner = new InMemoryLibraryStore();
  const cache = new Map<string, CollectionItem>();
  return Object.assign(Object.create(inner) as LibraryStore, {
    getCollectionItem: async (id: string) => cache.get(id) ?? (await inner.getCollectionItem(id)),
    putCollectionItems: async (items: CollectionItem[]) => {
      for (const item of items) cache.set(item.id, item);
      await inner.putCollectionItems(items);
    },
  });
}

describe("a store that shares its records", () => {
  const cases = new Map(libraryStoreConformance(byReference).map((c) => [c.name, c]));
  const fails = (name: string) =>
    test(`fails ${name}`, async () => {
      await expect(cases.get(name)!.run()).rejects.toThrow();
    });

  fails("isolation: collection items");
  // The bug as the desktop had it: a page turn on a collected series moved its resume point
  // locally and never recorded it.
  fails("recording: read a page of a collected series");
  fails("recording: refresh the series snapshot");
  fails("recording: record the series gone");

  test("still passes what it doesn't break", async () => {
    await cases.get("isolation: progress")!.run();
    await cases.get("recording: create a collection")!.run();
  });
});
