/**
 * Filesystem-backed, per-bridge key/value storage. Each bridge gets its own JSON file under the
 * data dir, so a bridge's stored state (tokens, ETags) is namespaced and cannot read another's.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StorageCapability } from "@comical/contract";

export class FileStorage implements StorageCapability {
  private readonly file: string;
  private cache: Record<string, string> | undefined;

  constructor(dataDir: string, bridgeId: string) {
    this.file = join(dataDir, "storage", `${bridgeId}.json`);
  }

  private async read(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.file, "utf8")) as Record<string, string>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async write(data: Record<string, string>): Promise<void> {
    this.cache = data;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(data, null, 2), "utf8");
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.read())[key];
  }

  async set(key: string, value: string): Promise<void> {
    const data = await this.read();
    data[key] = value;
    await this.write(data);
  }

  async delete(key: string): Promise<void> {
    const data = await this.read();
    delete data[key];
    await this.write(data);
  }

  async keys(): Promise<string[]> {
    return Object.keys(await this.read());
  }
}

/** In-memory storage (no persistence) — handy for one-shot CLI invocations and tests. */
export class MemoryStorage implements StorageCapability {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.map.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }
}
