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
