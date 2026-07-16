/**
 * The byte-storage seam for the download engine. The `Downloads` service persists only the manifest;
 * a `BlobStore` persists the actual page bytes, keyed by the manifest's relative `file` path (see
 * `paths.ts` for the layout). Implementations: filesystem on a server host, expo-file-system on
 * device, IndexedDB/OPFS on a browser host — each rooted wherever that platform keeps durable data.
 */
export interface BlobStore {
  /** Write one page's bytes at `relPath` (creating parent dirs), returning the stored size. */
  write(relPath: string, data: Uint8Array): Promise<{ bytes: number }>;
  /** Remove stored blobs by relative path (best-effort — a leftover orphan is harmless). */
  remove(relPaths: string[]): Promise<void>;
  /** Optional: wipe the entire blob root (the "delete all" belt-and-suspenders sweep). */
  removeAll?(): Promise<void>;
  /** Optional: read a blob back — implemented by hosts that serve downloaded bytes (host-server). */
  read?(relPath: string): Promise<Uint8Array | undefined>;
  /** Optional: the ACTUAL bytes under the blob root. Reported beside the manifest's rolled-up total
   *  (`StorageUsage.diskBytes`) so a gap surfaces orphaned blobs on any host. */
  usage?(): Promise<number>;
}
