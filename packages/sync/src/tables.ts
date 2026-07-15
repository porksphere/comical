/**
 * The sync allow-list, as data. Every syncable slice of the store is named here with its merge
 * strategy; anything NOT in this table does not sync. Encoding it explicitly (rather than
 * "sync everything except …") means a newly added store key never silently starts syncing — you
 * have to opt it in here, and the compiler flags a strategy you forgot to assign.
 *
 * The table ids and their backing stores (the app's local stores, and the hub's file store) are
 * documented in comical-app's docs/CROSS-DEVICE-SYNC.md.
 */
export type Strategy = "register" | "set" | "progress";

export type TableId =
  | "entries" // library membership + metadata
  | "chapters" // the known chapter list, ONE RECORD PER CHAPTER (see below)
  | "lists" // user lists
  | "groups" // series groups
  | "trackerLinks" // series ↔ tracker links
  | "readingLog" // history (last read per series)
  | "bridgePrefs" // per-bridge library prefs
  | "bridgeSettings" // per-bridge settings
  | "registries" // added registry URLs
  | "installed" // installed bridge records
  | "progress"; // per-chapter read position

export const TABLE_STRATEGY: Record<TableId, Strategy> = {
  entries: "register",
  // Per-chapter, not per-series: a `KnownChapter` is immutable for a given (entry, chapter), so a
  // plain register converges trivially and goes silent after the first sync. The point is the
  // granularity. As a field on the entry register, a chapter list had to travel whole — a long
  // series is 73KB of it — every time ANY part of the entry changed, including the resume cache
  // that a page turn touches. One record per chapter makes a new chapter cost ~100 bytes.
  chapters: "register",
  lists: "register",
  groups: "register",
  trackerLinks: "register",
  readingLog: "register",
  bridgePrefs: "register",
  bridgeSettings: "register",
  registries: "set",
  installed: "set",
  progress: "progress",
};

export const ALL_TABLES = Object.keys(TABLE_STRATEGY) as TableId[];

/** Whether an arbitrary string names a syncable table (the hub's boundary check). */
export function isTableId(v: string): v is TableId {
  return Object.hasOwn(TABLE_STRATEGY, v);
}

/**
 * DEVICE-LOCAL keys that must never sync — they describe *this install*, not the user's identity.
 * Syncing them would actively break things (e.g. pushing one device's "run bridges here" preference,
 * or its server URL, onto another). Kept as the concrete client storage keys so this list can be
 * asserted against the real stores.
 */
export const DEVICE_LOCAL_KEYS: readonly string[] = [
  "comical:embeddedEnabled", // "run bridges on this device" — meaningless cross-device
  "comical:readerSettings", // reader display prefs — per-screen, decided local-only
  "comical:syncConfig", // this device's own sync pairing/config — never sync the sync settings themselves
  // + server URL override, mock/demo toggles, hideNsfw — enumerate here as they gain persisted keys.
];

/**
 * Composite record ids for the tables whose natural key is a pair. Entry keys already contain `:`
 * (`bridgeId:seriesId`), so the separator is NUL — it cannot appear in any of these ids, making the
 * split unambiguous even if a series/chapter id contains a colon or space.
 */
const SEP = String.fromCharCode(0);
export const compositeId = {
  chapter: (entryKey: string, chapterId: string): string => `${entryKey}${SEP}${chapterId}`,
  progress: (entryKey: string, chapterId: string): string => `${entryKey}${SEP}${chapterId}`,
  trackerLink: (entryKey: string, trackerId: string): string => `${entryKey}${SEP}${trackerId}`,
  bridgeSettings: (bridgeId: string): string => bridgeId,
};

/** Split a composite id back into its two parts (inverse of the helpers above). */
export function splitCompositeId(id: string): [string, string] {
  const i = id.indexOf(SEP);
  return i === -1 ? [id, ""] : [id.slice(0, i), id.slice(i + 1)];
}
