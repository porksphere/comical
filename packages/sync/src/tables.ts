/**
 * The sync allow-list. Anything not named here does not sync, so a new store never starts syncing by
 * accident — it has to be opted in, with a merge strategy.
 *
 * Bridge SETTINGS are deliberately absent: they hold logins and cookies, and a change log is a copy
 * of everything it has ever carried.
 */
export type Strategy = "register" | "set" | "progress";

export const TABLE_STRATEGY = {
  collections: "register",
  collectionItems: "register",
  progress: "progress",
  readingLog: "register",
  trackerLinks: "register",
  groups: "register",
  bridgePrefs: "register",
  registries: "set",
  installed: "set",
} as const satisfies Record<string, Strategy>;

export type TableId = keyof typeof TABLE_STRATEGY;

export const ALL_TABLES = Object.keys(TABLE_STRATEGY) as TableId[];

export function isTableId(v: string): v is TableId {
  return Object.hasOwn(TABLE_STRATEGY, v);
}

// Entry keys already contain `:` (`bridgeId:seriesId`) and ids are free-form, so pairs are joined
// on NUL, which none of them can contain.
const SEP = String.fromCharCode(0);

export const compositeId = {
  progress: (entryKey: string, chapterId: string): string => `${entryKey}${SEP}${chapterId}`,
  trackerLink: (entryKey: string, trackerId: string): string => `${entryKey}${SEP}${trackerId}`,
};

export function splitCompositeId(id: string): [string, string] {
  const i = id.indexOf(SEP);
  return i === -1 ? [id, ""] : [id.slice(0, i), id.slice(i + 1)];
}

export const recordKey = (table: TableId, id: string): string => `${table}${SEP}${id}`;

export function splitRecordKey(key: string): { table: TableId; id: string } {
  const i = key.indexOf(SEP);
  return { table: key.slice(0, i) as TableId, id: key.slice(i + 1) };
}
