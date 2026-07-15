/**
 * `@comical/sync` — the cross-device sync core: the wire types, the CRDT merge and the allow-list of
 * what syncs, plus the replica/engine and the `LibraryStore` bridge built on top of them.
 *
 * Deliberately platform-agnostic (no `fs`, `process`, sockets, `fetch`, DOM) because both halves of
 * sync depend on it: the app's replica running on JSC/QuickJS/Hermes, and the hub running under Bun
 * inside `@comical/host-server`. Sharing one copy of the replica + bridge is what lets the hub compute
 * exactly the same merge result the devices do — the property the whole design rests on — instead of a
 * second implementation that could drift.
 *
 * Platform-specific pieces stay out: the app owns its AsyncStorage cursor/persistence, the HTTP sync
 * backend, and the E2E crypto; the hub owns its file persistence. Only what both sides must agree on,
 * and the pure machinery they both run, lives here.
 */
export { Clock, compare, comparePacked, pack, unpack, type Hlc } from "./hlc.ts";
export { isLive, mergeEnvelope, type Envelope, type Progress, type Register, type SetElement } from "./crdt.ts";
export {
  ALL_TABLES,
  compositeId,
  DEVICE_LOCAL_KEYS,
  isTableId,
  splitCompositeId,
  TABLE_STRATEGY,
  type Strategy,
  type TableId,
} from "./tables.ts";
export {
  envelopeSchema,
  hlcSchema,
  isValidAccountId,
  parseCursor,
  parseSyncRecords,
  syncRecordSchema,
  type PullResult,
  type SyncRecord,
} from "./wire.ts";
export { RecordSet } from "./record-set.ts";

// ── Replica + engine + store bridge (the machinery both the app and the hub run) ────────────────
export { Replica } from "./replica.ts";
export { SyncEngine, MemoryCursor, type CursorStore, type SyncStats } from "./engine.ts";
export { MemoryBackend, type SyncBackend } from "./backend.ts";
export type { StoreBridge } from "./store-bridge.ts";
export { LibraryStoreBridge } from "./library-bridge.ts";
export { wrapLibraryStore } from "./library-writethrough.ts";
export { toProgressFields, fromProgress } from "./library-map.ts";
