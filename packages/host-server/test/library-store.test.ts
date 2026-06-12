/**
 * FileLibraryStore persistence + the one-time "categories → lists" entry migration: a legacy
 * `entries.json` (carrying `categoryIds`, no `listIds`) is healed on first read and rewritten.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FileLibraryStore } from "../src/library-store.ts";

const DIR = join(import.meta.dir, ".tmp-library-store");
const LIB = join(DIR, "library");

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(LIB, { recursive: true });
});
afterEach(() => rmSync(DIR, { recursive: true, force: true }));

describe("FileLibraryStore legacy migration", () => {
  test("entries with categoryIds and no listIds are healed and persisted on first read", async () => {
    // Seed a pre-rename file by hand: the field is `categoryIds`, `listIds` is absent.
    const legacy = {
      "demo:s1": {
        bridgeId: "demo", seriesId: "s1", title: "Legacy One",
        categoryIds: ["old-cat-id"], addedAt: 1, updatedAt: 1,
      },
    };
    writeFileSync(join(LIB, "entries.json"), JSON.stringify(legacy), "utf8");

    const store = new FileLibraryStore(LIB);
    const [entry] = await store.listEntries();

    // In memory: listIds defaulted to [] (membership dropped), categoryIds gone.
    expect(entry!.listIds).toEqual([]);
    expect("categoryIds" in entry!).toBe(false);

    // On disk: the file was rewritten so the migration runs exactly once.
    const onDisk = JSON.parse(readFileSync(join(LIB, "entries.json"), "utf8")) as Record<string, Record<string, unknown>>;
    expect(onDisk["demo:s1"]!.listIds).toEqual([]);
    expect("categoryIds" in onDisk["demo:s1"]!).toBe(false);
  });

  test("a clean entry (already has listIds) is left untouched, no rewrite needed", async () => {
    const clean = {
      "demo:s1": { bridgeId: "demo", seriesId: "s1", title: "Clean", listIds: ["keep"], addedAt: 1, updatedAt: 1 },
    };
    const raw = JSON.stringify(clean);
    writeFileSync(join(LIB, "entries.json"), raw, "utf8");

    const store = new FileLibraryStore(LIB);
    const [entry] = await store.listEntries();
    expect(entry!.listIds).toEqual(["keep"]);
    // Untouched: no migration flush reformatted the file.
    expect(readFileSync(join(LIB, "entries.json"), "utf8")).toBe(raw);
  });
});
