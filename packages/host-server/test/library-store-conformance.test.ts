/**
 * FileLibraryStore against sync's shared store conformance suite. Each case gets a library of its
 * own: a store caches what it has loaded, so two cases over one directory would share records.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, test } from "bun:test";
import { libraryStoreConformance } from "@comical/sync/conformance";
import { FileLibraryStore } from "../src/library-store.ts";

const DIR = join(import.meta.dir, ".tmp-library-store-conformance");
let n = 0;

rmSync(DIR, { recursive: true, force: true });
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("FileLibraryStore conformance", () => {
  const make = () => {
    const dir = join(DIR, String(n++));
    mkdirSync(dir, { recursive: true });
    return new FileLibraryStore(dir);
  };
  for (const c of libraryStoreConformance(make)) test(c.name, c.run);
});
