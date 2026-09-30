/**
 * `@comical/sync` — cross-device sync. Each device numbers its own changes; a reader tracks how far
 * it has read each device's log (a version vector), so a rendezvous can be a hub or a plain folder
 * of per-device files and nothing is ever missed or re-scanned.
 *
 * Platform-agnostic (no `fs`, `process`, sockets, `fetch`, DOM): the app runs the engine on
 * Hermes/JSC/QuickJS and the desktop hub runs the same merge under Bun.
 */
export { Clock, compare, comparePacked, MAX_DRIFT_MS, pack, unpack, type Hlc } from "./hlc.ts";
export {
  envelopeChanges,
  isLive,
  mergeEnvelope,
  type Envelope,
  type Progress,
  type Register,
  type SetElement,
} from "./crdt.ts";
export {
  ALL_TABLES,
  compositeId,
  isTableId,
  recordKey,
  splitCompositeId,
  splitRecordKey,
  TABLE_STRATEGY,
  type Strategy,
  type TableId,
} from "./tables.ts";
export {
  deviceIdSchema,
  envelopeSchema,
  hlcSchema,
  MAX_PULL_LIMIT,
  parsePullRequest,
  parsePullResult,
  parsePushRefusal,
  parseSegment,
  parseVersionVector,
  pullRequestSchema,
  pullResultSchema,
  pushRefusalSchema,
  segmentSchema,
  SYNC_PULL_PATH,
  SYNC_PUSH_PATH,
  syncRecordSchema,
  versionVectorSchema,
  type PullRequest,
  type PullResult,
  type PushRefusal,
  type Segment,
  type SyncRecord,
  type VersionVector,
} from "./wire.ts";
export { ChangeLog, DEFAULT_PULL_LIMIT, SeqConflictError, SeqGapError } from "./log.ts";
export { MemoryBackend, type SyncBackend } from "./backend.ts";
export { MemorySegmentStore, SyncHub, type SegmentStore } from "./hub.ts";
export { HttpBackend, SyncHttpError, type HttpBackendOptions } from "./http.ts";
export { composeSyncStores, type ProgressValue, type SyncStore } from "./store.ts";
export {
  SyncEngine,
  type Stamp,
  type SyncEngineOptions,
  type SyncStateSnapshot,
  type SyncStats,
} from "./engine.ts";
export { adoptLibrary, LIBRARY_TABLES, librarySyncStore, wrapLibraryStore } from "./library.ts";
export {
  adoptRegistry,
  REGISTRY_TABLES,
  registrySyncStore,
  wrapRegistryProvider,
  type RegistryLists,
  type RegistryMutations,
  type RegistrySyncOptions,
  type RegistrySyncStore,
  type SyncedRegistry,
} from "./registry.ts";
