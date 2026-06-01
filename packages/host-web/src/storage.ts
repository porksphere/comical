/**
 * localStorage-backed StorageCapability for the browser host.
 * Keys are namespaced per-bridge so bridges cannot read each other's state.
 *
 * Falls back to MemoryStorage when localStorage is unavailable (e.g. private browsing in
 * some browsers, or non-browser environments running host-web code).
 */
import type { StorageCapability } from "@comical/contract";

export class LocalStorageCapability implements StorageCapability {
  private readonly prefix: string;

  constructor(bridgeId: string) {
    this.prefix = `comical:${bridgeId}:`;
  }

  async get(key: string): Promise<string | undefined> {
    return localStorage.getItem(this.prefix + key) ?? undefined;
  }

  async set(key: string, value: string): Promise<void> {
    localStorage.setItem(this.prefix + key, value);
  }

  async delete(key: string): Promise<void> {
    localStorage.removeItem(this.prefix + key);
  }

  async keys(): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(this.prefix)) out.push(k.slice(this.prefix.length));
    }
    return out;
  }
}

/** In-memory fallback for environments without localStorage. */
export class WebMemoryStorage implements StorageCapability {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.map.get(key); }
  async set(key: string, value: string): Promise<void> { this.map.set(key, value); }
  async delete(key: string): Promise<void> { this.map.delete(key); }
  async keys(): Promise<string[]> { return [...this.map.keys()]; }
}

export function createWebStorage(bridgeId: string): StorageCapability {
  try {
    localStorage.setItem("__comical_test__", "1");
    localStorage.removeItem("__comical_test__");
    return new LocalStorageCapability(bridgeId);
  } catch {
    return new WebMemoryStorage();
  }
}
