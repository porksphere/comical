/**
 * Migration of a pre-collections `entries.json` on disk.
 *
 * The library dissolved into collections, so a series is now a `CollectionSeriesItem`. Everything
 * else it owns is keyed by `entryKey` in its own file and survived the dissolution orphaned — this
 * is what reattaches it, and it is the project's one sanctioned data migration.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Library } from "@comical/library";
import { FileLibraryStore } from "../src/library-store.ts";
import { migrateLegacyEntries } from "../src/legacy-entries.ts";

const DATA_DIR = join(import.meta.dir, ".tmp-legacy-entries");

function makeDir(): string {
  const dir = join(DATA_DIR, `run-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const ENTRY = {
  bridgeId: "demo",
  seriesId: "s1",
  title: "Series One",
  thumbnailUrl: "https://cdn.example/c.png",
  addedAt: 500,
  updatedAt: 600,
  knownChapters: [{ id: "c1", number: 1 }],
  externalIds: { anilist: 7 },
};

afterEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

describe("migrateLegacyEntries", () => {
  test("rebuilds the library from entries.json and reattaches its orphaned progress", async () => {
    const dir = makeDir();
    const store = new FileLibraryStore(dir);
    const lib = new Library(store);
    // Progress persisted before the dissolution: its own file, keyed by entryKey, untouched.
    await store.putProgress("demo:s1", { chapterId: "c1", read: true, number: 1, updatedAt: 1 });
    writeFileSync(join(dir, "entries.json"), JSON.stringify({ "demo:s1": ENTRY }));

    expect(await migrateLegacyEntries(dir, lib)).toEqual({ imported: 1, skipped: 0 });

    const view = (await lib.getLibrary()).find((v) => v.seriesId === "s1");
    expect(view?.seriesTitle).toBe("Series One");
    expect(view?.unreadCount).toBe(0); // the read state found its series again
    expect(view?.externalIds).toEqual({ anilist: 7 });
  });

  test("renames the source rather than deleting it, and is a no-op on the second run", async () => {
    const dir = makeDir();
    const lib = new Library(new FileLibraryStore(dir));
    writeFileSync(join(dir, "entries.json"), JSON.stringify({ "demo:s1": ENTRY }));

    await migrateLegacyEntries(dir, lib);
    expect(existsSync(join(dir, "entries.json"))).toBe(false);
    // Kept on disk: the import is all that stands between the user and a lost library.
    expect(existsSync(join(dir, "entries.migrated.json"))).toBe(true);

    expect(await migrateLegacyEntries(dir, lib)).toBeUndefined();
    expect(await lib.getLibrary()).toHaveLength(1);
  });

  test("no entries.json (fresh install or already migrated) is undefined, not an error", async () => {
    const dir = makeDir();
    expect(await migrateLegacyEntries(dir, new Library(new FileLibraryStore(dir)))).toBeUndefined();
  });

  test("an unreadable document is left in place rather than renamed away", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "entries.json"), "{ not json");

    expect(await migrateLegacyEntries(dir, new Library(new FileLibraryStore(dir)))).toBeUndefined();
    expect(existsSync(join(dir, "entries.json"))).toBe(true);
  });

  test("accepts a bare array too, and survives partially-corrupt rows", async () => {
    const dir = makeDir();
    const lib = new Library(new FileLibraryStore(dir));
    writeFileSync(join(dir, "entries.json"), JSON.stringify([ENTRY, { bridgeId: "demo" }]));

    expect(await migrateLegacyEntries(dir, lib)).toEqual({ imported: 1, skipped: 1 });
    expect(await lib.getLibrary()).toHaveLength(1);
  });
});
