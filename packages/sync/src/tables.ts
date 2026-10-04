/**
 * The sync allow-list. Anything not named here does not sync, so a new store never starts syncing by
 * accident — it has to be opted in, with a merge strategy.
 *
 * A bridge's settings hold its logins beside its preferences, and a change log is a copy of
 * everything it has ever carried. So `bridgeSettings` carries one record per setting, and only the
 * settings `./settings.ts` lets through: a login never becomes a record. Tracker settings are all
 * login, and have no table.
 */
export type Strategy = "register" | "set" | "progress" | "event";

/** Declaration order is apply order within a segment: referents before what refers to them. */
export const TABLE_STRATEGY = {
  registries: "set",
  installed: "set",
  installedTrackers: "set",
  bridgeSettings: "register",
  bridgePrefs: "register",
  groups: "register",
  collections: "register",
  collectionItems: "register",
  seriesResume: "register",
  progress: "progress",
  readingLog: "register",
  trackerLinks: "register",
  activity: "event",
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
  bridgeSetting: (bridgeId: string, key: string): string => `${bridgeId}${SEP}${key}`,
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
