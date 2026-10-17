/**
 * Filesystem `BlobStore` — where the server-side download engine keeps page bytes, rooted at
 * `{dataDir}/downloads/blobs`. Paths are the manifest's relative `file` values (see
 * `@comical/downloads` `paths.ts` for the layout); `read` is implemented so the router can serve
 * downloaded pages back to clients.
 *
 * Every path is validated against traversal before touching the filesystem: engine-written paths are
 * already sanitized, but manifest `file` fields are client-writable via the manifest-only
 * `recordPage` route, so the store must not trust them.
 */
import { mkdir, readdir, readFile, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BlobStore } from "@comical/downloads";

const USAGE_TTL_MS = 4000;

export class FileBlobStore implements BlobStore {
  /** `at` is when the walk FINISHED — a walk still running is always shared, however long it takes. */
  private usageCache: { bytes: Promise<number>; at: number } | null = null;

  constructor(private readonly root: string) {}

  /** Resolve a manifest-relative path under the root, rejecting traversal/absolute segments. */
  private resolve(relPath: string): string {
    const segments = relPath.split("/");
    if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes("\\") || s.includes(":"))) {
      throw new Error(`invalid blob path: ${relPath}`);
    }
    return join(this.root, ...segments);
  }

  async write(relPath: string, data: Uint8Array): Promise<{ bytes: number }> {
    const path = this.resolve(relPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return { bytes: data.byteLength };
  }

  async read(relPath: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.resolve(relPath)));
    } catch {
      return undefined;
    }
  }

  /** Best-effort removal; prunes chapter/series dirs a deletion emptied (rmdir refuses non-empty). */
  async remove(relPaths: string[]): Promise<void> {
    for (const relPath of relPaths) {
      let path: string;
      try {
        path = this.resolve(relPath);
      } catch {
        continue; // a malformed manifest path never aborts the rest of the deletion
      }
      await unlink(path).catch(() => {});
      const chapterDir = dirname(path);
      const seriesDir = dirname(chapterDir);
      await rmdir(chapterDir).catch(() => {});
      await rmdir(seriesDir).catch(() => {});
    }
    this.usageCache = null;
  }

  async removeAll(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
    this.usageCache = null;
  }

  /**
   * The actual bytes under the blob root (0 when it doesn't exist yet). `GET /downloads` carries
   * this and clients refetch that on every pause, enqueue and progress event, while one walk of a
   * large download dir takes about a second — so walk at most once per `USAGE_TTL_MS`, sharing the
   * walk in progress, and drop the cache on a delete, the one change the number must show promptly.
   * The same policy as the device's blob store.
   */
  usage(): Promise<number> {
    if (this.usageCache && Date.now() - this.usageCache.at < USAGE_TTL_MS) return this.usageCache.bytes;
    const bytes = this.walkUsage();
    const entry = { bytes, at: Number.POSITIVE_INFINITY };
    this.usageCache = entry;
    bytes.then(
      () => {
        entry.at = Date.now();
      },
      () => {
        if (this.usageCache === entry) this.usageCache = null;
      },
    );
    return bytes;
  }

  private async walkUsage(): Promise<number> {
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // root missing / transient — report what we could see
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else total += (await stat(path).catch(() => null))?.size ?? 0;
      }
    };
    await walk(this.root);
    return total;
  }
}
