/**
 * One-shot migration of this host's pre-collections `entries.json`.
 *
 * The library dissolved into collections, so a tracked series is now a `CollectionSeriesItem` in
 * `collection-items/`. Every other document a series owns is keyed by `entryKey` in its own file —
 * `progress/`, `details/`, `chapters-cache/`, `tracker-links.json`, `groups.json` — so the
 * dissolution orphaned them rather than deleting them, and rebuilding the series items reattaches
 * everything. `entries.json` is the only casualty, which is why this exists at all in a project
 * that otherwise does no data migration.
 *
 * The host's job is only to FIND the legacy document; `Library.importLegacyEntries` owns the
 * domain logic, so every platform migrates identically.
 *
 * Delete this module (and the schema behind it) once the migration has run everywhere.
 */
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Library } from "@comical/library";

export interface LegacyEntriesMigration {
  imported: number;
  skipped: number;
}

/**
 * Import `{dir}/entries.json` if it is still there, then rename it to `entries.migrated.json`.
 *
 * Renaming rather than deleting: the import is the only thing standing between the user and a lost
 * library, so the source stays on disk until they are satisfied it worked. Returns undefined when
 * there is nothing to migrate, which is the steady state.
 */
export async function migrateLegacyEntries(dir: string, library: Library): Promise<LegacyEntriesMigration | undefined> {
  const path = join(dir, "entries.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined; // already migrated, or a fresh install
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined; // unreadable; leave it in place rather than renaming evidence away
  }
  // The old document was `{ [entryKey]: LibraryEntry }`; tolerate a bare array too.
  const rows = Array.isArray(parsed) ? parsed : Object.values(parsed as Record<string, unknown>);
  if (rows.length === 0) return undefined;

  const { imported, skipped } = await library.importLegacyEntries(rows);
  await rename(path, join(dir, "entries.migrated.json")).catch(() => {});
  return { imported, skipped };
}
