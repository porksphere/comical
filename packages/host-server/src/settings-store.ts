/**
 * Per-bridge user settings store: persists user-supplied configuration (backend URL,
 * credentials, options) to disk, separate from the bridge's own `storage` capability.
 *
 * This is the mechanism by which a user configures which backend a bridge points to.
 * All values live in `{dataDir}/settings/{bridgeId}.json`, read and written through
 * `@comical/host-bun`'s json-file (an unreadable file is moved aside, never silently replaced).
 */
import { join } from "node:path";
import { asJsonRecord, JsonDoc } from "@comical/host-bun";
import type { ResolvedSettings, SettingValue } from "@comical/contract";

export class SettingsStore {
  private readonly dir: string;
  private docs = new Map<string, JsonDoc<Record<string, SettingValue>>>();

  constructor(dataDir: string) {
    this.dir = join(dataDir, "settings");
  }

  private doc(bridgeId: string): JsonDoc<Record<string, SettingValue>> {
    let doc = this.docs.get(bridgeId);
    if (!doc) {
      doc = new JsonDoc(join(this.dir, `${bridgeId}.json`), {
        empty: () => ({}),
        decode: (raw) => asJsonRecord<SettingValue>(raw),
      });
      this.docs.set(bridgeId, doc);
    }
    return doc;
  }

  async get(bridgeId: string): Promise<ResolvedSettings> {
    return this.doc(bridgeId).get();
  }

  async set(bridgeId: string, settings: Record<string, SettingValue>): Promise<void> {
    await this.doc(bridgeId).replace(settings);
  }

  async patch(bridgeId: string, patch: Record<string, SettingValue>): Promise<ResolvedSettings> {
    // A transform, not get-then-set: two overlapping patches must both land.
    let updated: Record<string, SettingValue> = {};
    await this.doc(bridgeId).transform((current) => (updated = { ...current, ...patch }));
    return updated;
  }
}
