/**
 * Per-bridge user settings store: persists user-supplied configuration (backend URL,
 * credentials, options) to disk, separate from the bridge's own `storage` capability.
 *
 * This is the mechanism by which a user configures which backend a bridge points to.
 * All values live in `{dataDir}/settings/{bridgeId}.json`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResolvedSettings } from "@comical/contract";

export class SettingsStore {
  private readonly dir: string;
  private cache = new Map<string, Record<string, string | boolean>>();

  constructor(dataDir: string) {
    this.dir = join(dataDir, "settings");
  }

  private path(bridgeId: string): string {
    return join(this.dir, `${bridgeId}.json`);
  }

  async get(bridgeId: string): Promise<ResolvedSettings> {
    if (this.cache.has(bridgeId)) return this.cache.get(bridgeId)!;
    try {
      const raw = await readFile(this.path(bridgeId), "utf8");
      const parsed = JSON.parse(raw) as Record<string, string | boolean>;
      this.cache.set(bridgeId, parsed);
      return parsed;
    } catch {
      return {};
    }
  }

  async set(bridgeId: string, settings: Record<string, string | boolean>): Promise<void> {
    this.cache.set(bridgeId, settings);
    await mkdir(dirname(this.path(bridgeId)), { recursive: true });
    await writeFile(this.path(bridgeId), JSON.stringify(settings, null, 2), "utf8");
  }

  async patch(bridgeId: string, patch: Record<string, string | boolean>): Promise<ResolvedSettings> {
    const current = await this.get(bridgeId) as Record<string, string | boolean>;
    const updated = { ...current, ...patch };
    await this.set(bridgeId, updated);
    return updated;
  }
}
