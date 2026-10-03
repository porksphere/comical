/**
 * The seam between the engine and whatever it is syncing. The engine keeps only stamps; the values
 * stay in the real store and are read at push time, so a library is held once per device rather
 * than once in the store and again in a replica.
 *
 * Values by strategy:
 *   - register — the record, or undefined when absent
 *   - set      — the element's metadata (`{}` for none), or undefined when not a member
 *   - progress — a `ProgressValue`, or undefined when the chapter has none
 */
import type { TableId } from "./tables.ts";

export type ProgressValue = {
  read: boolean;
  lastPage: number;
  pageCount: number;
  number?: number | undefined;
  languageCode?: string | undefined;
};

export interface SyncStore {
  read(table: TableId, id: string): Promise<unknown>;
  /** Apply a merged remote value; undefined removes the record. */
  write(table: TableId, id: string, value: unknown): Promise<void>;
}

/** One store over several: each table goes to the store that declared it. */
export function composeSyncStores(parts: ReadonlyArray<readonly [readonly TableId[], SyncStore]>): SyncStore {
  const byTable = new Map<TableId, SyncStore>();
  for (const [tables, store] of parts) for (const t of tables) byTable.set(t, store);
  const pick = (table: TableId): SyncStore => {
    const store = byTable.get(table);
    if (!store) throw new Error(`sync: no store for table ${table}`);
    return store;
  };
  return {
    read: (table, id) => pick(table).read(table, id),
    write: (table, id, value) => pick(table).write(table, id, value),
  };
}

/** A canonical serialization, so "did this write change what syncs" is a string compare. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}
