/**
 * Sync over a bridge's settings — the ones that are safe to copy. One record per bridge and key, so
 * two devices changing different settings of one bridge both keep their change.
 *
 * A bridge's settings also hold its logins, and a change log is a copy of everything it has ever
 * carried, so what travels is decided closed, at both ends. A key leaves a device only while the
 * bridge installed there declares it as a plain preference; it is written on arrival only once the
 * bridge installed THERE declares it the same way and accepts the value. The host's own per-bridge
 * content filters (`excludedTags`, `maxContentRating`) are the only keys that travel without a
 * descriptor. Everything else — an OAuth token, a `secret` string, a key no installed version
 * declares — stays where it is.
 *
 * Devices run different versions of a bridge, so a value can arrive ahead of the version that
 * understands it, or ahead of the bridge itself. Storing it anyway would stop the bridge loading
 * (`resolveSettings` rejects an invalid stored value), so it is kept aside and retried through
 * `retry()`, which the host calls each round, until the bridge here takes it, a later record
 * replaces it, or the setting is changed here. What is kept aside is not saved: a restart forgets it.
 */
import { z } from "zod";
import {
  contentRatingSchema,
  EXCLUDED_TAGS_KEY,
  MAX_CONTENT_RATING_KEY,
  settingValueSchema,
  type SettingDescriptor,
  type SettingValue,
} from "@comical/contract";
import { validateSettingsInput } from "@comical/core/settings";
import type { SyncEngine } from "./engine.ts";
import { stableJson, type SyncStore } from "./store.ts";
import { compositeId, splitCompositeId, type TableId } from "./tables.ts";

export const SETTINGS_TABLES = ["bridgeSettings"] as const satisfies readonly TableId[];

/** The part of a host's bridge provider this needs; `BridgeManager` and `EmbeddedBridgeProvider` both fit. */
export interface BridgeSettingsProvider {
  /** Loads the bridge; throws when it isn't installed or can't be loaded. */
  get(id: string): Promise<{ getSettings?(): readonly SettingDescriptor[] }>;
  storedSettings(id: string): Promise<Record<string, SettingValue>>;
  /** Merges a patch into the stored settings and resolves to the result. */
  updateSettings(id: string, values: Record<string, SettingValue>): Promise<Record<string, SettingValue>>;
}

export interface BridgeSettingsSyncStore extends SyncStore {
  /** Re-attempt the values this device couldn't take yet; resolves to how many it wrote. Call once per sync round. */
  retry(): Promise<number>;
  /** How many values are waiting on a retry. */
  pending(): number;
}

export interface BridgeSettingsSyncOptions {
  log?: Pick<Console, "error">;
  /** Attempts at a bridge that won't load before its value is dropped. */
  maxAttempts?: number;
}

const MAX_ATTEMPTS = 5;

const record = z.object({ value: settingValueSchema });

// No bridge declares these, so their shape is checked here. "" is how "no limit" is stored.
const HOST_KEYS = new Map<string, z.ZodType<SettingValue>>([
  [EXCLUDED_TAGS_KEY, z.array(z.string())],
  [MAX_CONTENT_RATING_KEY, z.union([contentRatingSchema, z.literal("")])],
]);

// Named kinds only: a kind of setting added later stays put until it is listed here.
function isPreference(d: SettingDescriptor): boolean {
  switch (d.type) {
    case "number":
    case "boolean":
    case "enum":
      return true;
    case "string":
      return !d.secret;
    default:
      return false;
  }
}

type Gate =
  /** `accept` resolves a value to what should be stored, or undefined when it isn't valid here. */
  | { open: true; accept(value: SettingValue): SettingValue | undefined }
  | { open: false; why: "login" | "undeclared" | "unloaded" };

/** What the bridge installed here declares, or undefined when it can't be loaded to ask. */
async function declared(provider: BridgeSettingsProvider, bridgeId: string): Promise<readonly SettingDescriptor[] | undefined> {
  try {
    return (await provider.get(bridgeId)).getSettings?.() ?? [];
  } catch {
    return undefined;
  }
}

function gate(key: string, descriptors: readonly SettingDescriptor[] | undefined): Gate {
  const host = HOST_KEYS.get(key);
  if (host) {
    return {
      open: true,
      accept: (value) => {
        const parsed = host.safeParse(value);
        return parsed.success ? parsed.data : undefined;
      },
    };
  }
  if (!descriptors) return { open: false, why: "unloaded" };
  const d = descriptors.find((x) => x.key === key);
  if (!d) return { open: false, why: "undeclared" };
  if (!isPreference(d)) return { open: false, why: "login" };
  return {
    open: true,
    accept: (value) => {
      try {
        return validateSettingsInput({ [key]: value }, [d])[key];
      } catch {
        return undefined;
      }
    },
  };
}

// The bridge is only loaded when a key needs its say.
async function gateFor(provider: BridgeSettingsProvider, bridgeId: string, key: string): Promise<Gate> {
  return gate(key, HOST_KEYS.has(key) ? undefined : await declared(provider, bridgeId));
}

async function travelling(provider: BridgeSettingsProvider, bridgeId: string, keys: readonly string[]): Promise<string[]> {
  const descriptors = keys.every((k) => HOST_KEYS.has(k)) ? undefined : await declared(provider, bridgeId);
  return keys.filter((k) => gate(k, descriptors).open);
}

type Held = {
  value: SettingValue;
  attempts: number;
  /** What was stored when the value arrived, once it has been read. */
  base?: string;
};

type Outcome = "written" | "settled" | "login" | "malformed" | "waiting" | "unavailable";

/** The engine reads from and applies into this; build it over the REAL provider, never the wrapped one. */
export function bridgeSettingsSyncStore(provider: BridgeSettingsProvider, opts: BridgeSettingsSyncOptions = {}): BridgeSettingsSyncStore {
  const log = opts.log ?? console;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const waiting = new Map<string, Held>();

  async function apply(bridgeId: string, key: string, held: Held): Promise<Outcome> {
    const now = stableJson((await provider.storedSettings(bridgeId))[key]);
    // Changed here since the value arrived: that change is the later one, and is on its way out.
    if (held.base !== undefined && held.base !== now) return "settled";
    held.base = now;
    const g = await gateFor(provider, bridgeId, key);
    if (!g.open) return g.why === "login" ? "login" : g.why === "unloaded" ? "unavailable" : "waiting";
    const next = g.accept(held.value);
    // A host key's shape is the same in every version, so a value that fails it never will pass.
    if (next === undefined) return HOST_KEYS.has(key) ? "malformed" : "waiting";
    if (stableJson(next) === now) return "settled";
    await provider.updateSettings(bridgeId, { [key]: next });
    return "written";
  }

  // The values themselves stay out of the log: a preference can still be an address or a name.
  async function attempt(id: string, held: Held): Promise<boolean> {
    const [bridgeId, key] = splitCompositeId(id);
    const outcome = await apply(bridgeId, key, held).catch((): Outcome => "unavailable");
    waiting.delete(id);
    switch (outcome) {
      case "written":
        return true;
      case "settled":
        return false;
      case "login":
        log.error(`sync: refusing ${bridgeId} setting "${key}": it is a login on this device`);
        return false;
      case "malformed":
        log.error(`sync: dropping ${bridgeId} setting "${key}": unrecognized value`);
        return false;
      case "waiting":
        waiting.set(id, held);
        return false;
      case "unavailable":
        held.attempts++;
        if (held.attempts >= maxAttempts) {
          log.error(`sync: giving up on ${bridgeId} setting "${key}" after ${held.attempts} attempts: the bridge is not available`);
          return false;
        }
        waiting.set(id, held);
        return false;
    }
  }

  return {
    async read(_table, id) {
      const [bridgeId, key] = splitCompositeId(id);
      const value = (await provider.storedSettings(bridgeId))[key];
      if (value === undefined) return undefined;
      return (await gateFor(provider, bridgeId, key)).open ? { value } : undefined;
    },
    async write(_table, id, value) {
      waiting.delete(id);
      // Sync never removes a setting. A record only goes absent when its key stops travelling —
      // a bridge update made it a login, or dropped it — which says nothing about the value here.
      if (value === undefined) return;
      const parsed = record.safeParse(value);
      if (!parsed.success) {
        const [bridgeId, key] = splitCompositeId(id);
        log.error(`sync: dropping ${bridgeId} setting "${key}": unrecognized value`);
        return;
      }
      await attempt(id, { value: parsed.data.value, attempts: 0 });
    },
    async retry() {
      let written = 0;
      for (const [id, held] of [...waiting]) if (await attempt(id, held)) written++;
      return written;
    },
    pending: () => waiting.size,
  };
}

/**
 * The provider to hand the router: a settings write goes through to `provider`, and each key it
 * changed that travels is recorded with the engine. Everything else is the provider's own.
 */
export function wrapBridgeSettings<P extends BridgeSettingsProvider>(provider: P, engine: SyncEngine): P {
  const update = (id: string, values: Record<string, SettingValue>) =>
    engine.exclusive(async () => {
      const before = await provider.storedSettings(id);
      // Asked before the write: a host drops its loaded bridge on a settings change, so asking
      // after would load it again only to answer this.
      const keys = await travelling(provider, id, Object.keys(values));
      const after = await provider.updateSettings(id, values);
      for (const key of keys) {
        if (stableJson(before[key]) !== stableJson(after[key])) engine.touch("bridgeSettings", compositeId.bridgeSetting(id, key));
      }
      return after;
    });

  return new Proxy(provider, {
    get(target, prop) {
      if (prop === "updateSettings") return update;
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => fn.apply(target, args);
    },
  });
}

/**
 * Stamp the settings this device already holds for `bridgeIds`, for a fresh pairing or a device
 * from before settings synced; run after the first pull, so what the other devices hold wins and
 * only what they lack is sent.
 */
export async function adoptBridgeSettings(
  provider: BridgeSettingsProvider,
  bridgeIds: readonly string[],
  engine: SyncEngine,
  tables: readonly TableId[] = SETTINGS_TABLES,
): Promise<void> {
  if (!tables.includes("bridgeSettings")) return;
  await engine.exclusive(async () => {
    for (const bridgeId of bridgeIds) {
      const keys = Object.keys(await provider.storedSettings(bridgeId));
      for (const key of await travelling(provider, bridgeId, keys)) {
        engine.adopt("bridgeSettings", compositeId.bridgeSetting(bridgeId, key));
      }
    }
  });
}
