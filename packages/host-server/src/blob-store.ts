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
import { mkdir, readFile, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BlobStore } from "@comical/downloads";

export class FileBlobStore implements BlobStore {
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
  }

  async removeAll(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
