/**
 * Filesystem-backed, per-bridge key/value storage. Each bridge gets its own JSON file under the
 * data dir, so a bridge's stored state (tokens, ETags) is namespaced and cannot read another's.
 */
import { join } from "node:path";
import type { KeyValueStore, StorageCapability } from "@comical/contract";
import { asJsonRecord, JsonDoc } from "./json-file.ts";

export class FileStorage implements KeyValueStore {
  private readonly doc: JsonDoc<Record<string, string>>;

  constructor(dataDir: string, bridgeId: string) {
    this.doc = new JsonDoc(join(dataDir, "storage", `${bridgeId}.json`), {
      empty: () => ({}),
      decode: (raw) => asJsonRecord<string>(raw),
    });
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.doc.get())[key];
  }

  async set(key: string, value: string): Promise<void> {
    await this.doc.update((data) => {
      data[key] = value;
    });
  }

  async delete(key: string): Promise<void> {
    await this.doc.update((data) => {
      delete data[key];
    });
  }

  async keys(): Promise<string[]> {
    return Object.keys(await this.doc.get());
  }
}

/** In-memory storage (no persistence) — handy for one-shot CLI invocations and tests. */
export class MemoryStorage implements KeyValueStore {
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

/**
 * Wrap a `KeyValueStore` as a full `StorageCapability`. Bun has no OS Keychain/Keystore to reach
 * for, so `secure` is the exact same store, aliased per the contract's "hosts that cannot do
 * better" rule rather than a second, differently-protected namespace.
 */
export function asStorageCapability(store: KeyValueStore): StorageCapability {
  return {
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
    delete: (key) => store.delete(key),
    keys: () => store.keys(),
    secure: store,
  };
}
