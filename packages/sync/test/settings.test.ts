import { describe, expect, test } from "bun:test";
import type { SettingDescriptor, SettingValue } from "@comical/contract";
import {
  adoptBridgeSettings,
  bridgeSettingsSyncStore,
  composeSyncStores,
  compositeId,
  MemoryBackend,
  SETTINGS_TABLES,
  SyncEngine,
  wrapBridgeSettings,
  type BridgeSettingsProvider,
  type SyncBackend,
} from "../src/index.ts";

let wall = 1_700_000_000_000;
const now = () => (wall += 10);

const BRIDGE = "bridge-a";

const LANGUAGE: SettingDescriptor = {
  type: "enum",
  key: "language",
  label: "Language",
  options: [
    { value: "en", label: "English" },
    { value: "fr", label: "French" },
  ],
};
const PAGE_SIZE: SettingDescriptor = { type: "number", key: "pageSize", label: "Page size", min: 10, max: 100 };
const DATA_SAVER: SettingDescriptor = { type: "boolean", key: "dataSaver", label: "Data saver" };
const SERVER: SettingDescriptor = { type: "string", key: "server", label: "Server" };
const PASSWORD: SettingDescriptor = { type: "string", key: "password", label: "Password", secret: true };
const PIN: SettingDescriptor = { type: "oauth-pin", key: "pinToken", label: "Sign in", authUrl: "https://auth.example.test/pin" };
const CALLBACK: SettingDescriptor = {
  type: "oauth-callback",
  key: "callbackToken",
  label: "Sign in",
  authUrlTemplate: "https://auth.example.test/authorize",
  exchange: { url: "https://auth.example.test/token", clientId: "client" },
};
const ALL = [LANGUAGE, PAGE_SIZE, DATA_SAVER, SERVER, PASSWORD, PIN, CALLBACK];

/** Bridges over plain maps: what each declares, and what is stored for it. */
function fakeBridges(declares: Record<string, SettingDescriptor[]> = { [BRIDGE]: ALL }) {
  const stored = new Map<string, Record<string, SettingValue>>();
  const loads: string[] = [];
  const writes: string[] = [];
  const provider: BridgeSettingsProvider & { invalidate(id: string): string } = {
    get: async (id) => {
      loads.push(id);
      const descriptors = declares[id];
      if (!descriptors) throw new Error(`bridge not found: ${id}`);
      return { getSettings: () => descriptors };
    },
    storedSettings: async (id) => ({ ...stored.get(id) }),
    updateSettings: async (id, values) => {
      writes.push(`${id} ${Object.keys(values).join(",")}`);
      const next = { ...stored.get(id), ...values };
      stored.set(id, next);
      return { ...next };
    },
    invalidate(id) {
      return `invalidated ${id} on ${this === provider ? "the provider" : "something else"}`;
    },
  };
  return { provider, declares, stored, loads, writes, of: (id = BRIDGE) => stored.get(id) ?? {} };
}

function device(backend: SyncBackend, name: string, declares?: Record<string, SettingDescriptor[]>) {
  const real = fakeBridges(declares);
  const errors: string[] = [];
  const store = bridgeSettingsSyncStore(real.provider, { log: { error: (m: string) => void errors.push(m) }, maxAttempts: 3 });
  const engine = new SyncEngine({
    store: composeSyncStores([[SETTINGS_TABLES, store]]),
    backend,
    device: name,
    name: () => name,
    newDeviceId: () => `${name}-2`,
    now,
  });
  return { real, store, engine, errors, bridges: wrapBridgeSettings(real.provider, engine) };
}

/** Every record the hub holds, as `key=value` (or `key=∅` for a removal). */
function carried(hub: MemoryBackend): string[] {
  return hub.log
    .pull({})
    .segments.flatMap((s) => s.records)
    .map((r) => `${r.id.split("\u0000").join("/")}=${r.env.kind === "register" && !r.env.deleted ? JSON.stringify(r.env.value) : "∅"}`);
}

describe("bridge settings sync", () => {
  test("a changed setting reaches the other device, and only the keys that changed are sent", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.bridges.updateSettings(BRIDGE, { language: "fr", pageSize: 40 });
    await a.engine.sync();
    await a.bridges.updateSettings(BRIDGE, { language: "fr", pageSize: 60, dataSaver: true });
    await a.engine.sync();
    await b.engine.sync();

    expect(b.real.of()).toEqual({ language: "fr", pageSize: 60, dataSaver: true });
    expect(carried(hub)).toEqual([
      `${BRIDGE}/language={"value":"fr"}`,
      `${BRIDGE}/pageSize={"value":40}`,
      `${BRIDGE}/pageSize={"value":60}`,
      `${BRIDGE}/dataSaver={"value":true}`,
    ]);
  });

  test("a write that changes nothing sends nothing", async () => {
    const a = device(new MemoryBackend(), "a");
    await a.bridges.updateSettings(BRIDGE, { language: "fr" });
    await a.engine.sync();
    await a.bridges.updateSettings(BRIDGE, { language: "fr" });
    expect(a.engine.hasUnsent()).toBe(false);
  });

  test("two devices changing different settings of one bridge both keep their change", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.bridges.updateSettings(BRIDGE, { language: "fr" });
    await b.bridges.updateSettings(BRIDGE, { pageSize: 50 });
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();

    expect(a.real.of()).toEqual({ language: "fr", pageSize: 50 });
    expect(b.real.of()).toEqual({ language: "fr", pageSize: 50 });
  });

  test("the same setting changed on two devices settles on the later change, on both", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.bridges.updateSettings(BRIDGE, { language: "fr" });
    await b.bridges.updateSettings(BRIDGE, { language: "en" });
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();

    expect(a.real.of()).toEqual({ language: "en" });
    expect(b.real.of()).toEqual({ language: "en" });
  });

  test("a login never leaves the device: a secret, either OAuth token, or a key the bridge doesn't declare", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.bridges.updateSettings(BRIDGE, {
      server: "https://library.example.test",
      password: "hunter2",
      pinToken: "pin-token",
      callbackToken: "callback-token",
      leftover: "from an older version",
    });
    expect(a.real.of().password).toBe("hunter2");
    await a.engine.sync();
    await b.engine.sync();

    expect(carried(hub)).toEqual([`${BRIDGE}/server={"value":"https://library.example.test"}`]);
    expect(b.real.of()).toEqual({ server: "https://library.example.test" });
  });

  test("a setting of a bridge that can't be loaded to ask stays put", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a", {});
    await a.bridges.updateSettings(BRIDGE, { language: "fr" });
    expect(a.real.of()).toEqual({ language: "fr" });
    expect(a.engine.hasUnsent()).toBe(false);
  });

  test("a key that became a login between the write and the send is sent as nothing", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.bridges.updateSettings(BRIDGE, { server: "https://library.example.test" });
    await a.engine.sync();
    await b.engine.sync();
    await a.bridges.updateSettings(BRIDGE, { server: "token-like" });
    a.real.declares[BRIDGE] = [{ ...SERVER, secret: true }];
    await a.engine.sync();
    await b.engine.sync();

    expect(carried(hub)).toEqual([`${BRIDGE}/server={"value":"https://library.example.test"}`, `${BRIDGE}/server=∅`]);
    // And an absent record removes nothing where it lands.
    expect(b.real.of()).toEqual({ server: "https://library.example.test" });
  });

  test("a device that declares the key as a login refuses a value for it", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b", { [BRIDGE]: [{ ...SERVER, secret: true }] });
    await b.real.provider.updateSettings(BRIDGE, { server: "b's secret" });
    await a.bridges.updateSettings(BRIDGE, { server: "https://library.example.test" });
    await a.engine.sync();
    await b.engine.sync();

    expect(b.real.of()).toEqual({ server: "b's secret" });
    expect(b.store.pending()).toBe(0);
    expect(b.errors).toEqual([`sync: refusing ${BRIDGE} setting "server": it is a login on this device`]);
  });

  test("the host's content filters travel without a descriptor, the tag list as a whole", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a", { [BRIDGE]: [] });
    const b = device(hub, "b", { [BRIDGE]: [] });
    await b.real.provider.updateSettings(BRIDGE, { excludedTags: ["gore"] });
    await a.bridges.updateSettings(BRIDGE, { excludedTags: ["horror", "spiders"], maxContentRating: "mature" });
    await a.engine.sync();
    await b.engine.sync();
    expect(b.real.of()).toEqual({ excludedTags: ["horror", "spiders"], maxContentRating: "mature" });

    // "" is "no limit", and has to travel too.
    await b.bridges.updateSettings(BRIDGE, { maxContentRating: "" });
    await b.engine.sync();
    await a.engine.sync();
    expect(a.real.of().maxContentRating).toBe("");
    // Neither needed the bridge loaded.
    expect([...a.real.loads, ...b.real.loads]).toEqual([]);
  });

  test("a content filter of the wrong shape is dropped, not kept aside", async () => {
    const b = device(new MemoryBackend(), "b");
    await b.store.write("bridgeSettings", compositeId.bridgeSetting(BRIDGE, "maxContentRating"), { value: "everything" });
    await b.store.write("bridgeSettings", compositeId.bridgeSetting(BRIDGE, "excludedTags"), { value: "horror" });
    await b.store.write("bridgeSettings", compositeId.bridgeSetting(BRIDGE, "language"), { nope: true });

    expect(b.real.of()).toEqual({});
    expect(b.store.pending()).toBe(0);
    expect(b.errors).toHaveLength(3);
    // The value is never what gets logged.
    expect(b.errors.join()).not.toContain("everything");
  });

  test("a value the bridge here doesn't accept yet is kept aside, and written once it does", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a", {
      [BRIDGE]: [{ ...LANGUAGE, options: [...(LANGUAGE.type === "enum" ? LANGUAGE.options : []), { value: "ja", label: "Japanese" }] }],
    });
    const b = device(hub, "b");
    await b.real.provider.updateSettings(BRIDGE, { language: "en" });
    await a.bridges.updateSettings(BRIDGE, { language: "ja" });
    await a.engine.sync();
    await b.engine.sync();

    expect(b.real.of()).toEqual({ language: "en" });
    expect(b.store.pending()).toBe(1);
    expect(await b.store.retry()).toBe(0);
    expect(b.store.pending()).toBe(1);

    // b's bridge updates to the version that knows the option.
    b.real.declares[BRIDGE] = a.real.declares[BRIDGE]!;
    expect(await b.store.retry()).toBe(1);
    expect(b.real.of()).toEqual({ language: "ja" });
    expect(b.store.pending()).toBe(0);
    // Applied from another device, so nothing of b's goes out.
    expect(b.engine.hasUnsent()).toBe(false);
  });

  test("a key the bridge here doesn't declare yet waits for the version that does", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b", { [BRIDGE]: [LANGUAGE] });
    await a.bridges.updateSettings(BRIDGE, { dataSaver: true });
    await a.engine.sync();
    await b.engine.sync();
    expect(b.real.of()).toEqual({});
    expect(b.store.pending()).toBe(1);

    b.real.declares[BRIDGE] = ALL;
    expect(await b.store.retry()).toBe(1);
    expect(b.real.of()).toEqual({ dataSaver: true });
  });

  test("a value kept aside is forgotten once the setting is changed here", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a", { [BRIDGE]: [{ ...PAGE_SIZE, max: 500 }] });
    const b = device(hub, "b");
    await a.bridges.updateSettings(BRIDGE, { pageSize: 300 });
    await a.engine.sync();
    await b.engine.sync();
    expect(b.store.pending()).toBe(1);

    await b.bridges.updateSettings(BRIDGE, { pageSize: 80 });
    b.real.declares[BRIDGE] = a.real.declares[BRIDGE]!;
    expect(await b.store.retry()).toBe(0);
    expect(b.store.pending()).toBe(0);
    await b.engine.sync();
    await a.engine.sync();
    expect(a.real.of()).toEqual({ pageSize: 80 });
    expect(b.real.of()).toEqual({ pageSize: 80 });
  });

  test("a later record replaces the one kept aside", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a", { [BRIDGE]: [{ ...PAGE_SIZE, max: 500 }] });
    const b = device(hub, "b");
    await a.bridges.updateSettings(BRIDGE, { pageSize: 300 });
    await a.engine.sync();
    await b.engine.sync();
    expect(b.store.pending()).toBe(1);

    await a.bridges.updateSettings(BRIDGE, { pageSize: 90 });
    await a.engine.sync();
    await b.engine.sync();
    expect(b.real.of()).toEqual({ pageSize: 90 });
    expect(b.store.pending()).toBe(0);
  });

  test("a setting for a bridge that isn't here yet is written when the bridge arrives", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b", {});
    await a.bridges.updateSettings(BRIDGE, { language: "fr" });
    await a.engine.sync();
    await b.engine.sync();
    expect(b.real.of()).toEqual({});
    expect(b.store.pending()).toBe(1);

    b.real.declares[BRIDGE] = ALL;
    expect(await b.store.retry()).toBe(1);
    expect(b.real.of()).toEqual({ language: "fr" });
  });

  test("a bridge that never arrives is given up on", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b", {});
    await a.bridges.updateSettings(BRIDGE, { language: "fr" });
    await a.engine.sync();
    await b.engine.sync();
    await b.store.retry();
    expect(b.store.pending()).toBe(1);
    await b.store.retry();
    expect(b.store.pending()).toBe(0);
    expect(b.errors).toEqual([`sync: giving up on ${BRIDGE} setting "language" after 3 attempts: the bridge is not available`]);

    b.real.declares[BRIDGE] = ALL;
    expect(await b.store.retry()).toBe(0);
    expect(b.real.of()).toEqual({});
  });

  test("a store that fails is retried rather than failing the round", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    const update = b.real.provider.updateSettings;
    b.real.provider.updateSettings = async () => {
      throw new Error("disk full");
    };
    await a.bridges.updateSettings(BRIDGE, { language: "fr" });
    await a.engine.sync();
    await b.engine.sync();
    expect(b.store.pending()).toBe(1);

    b.real.provider.updateSettings = update;
    expect(await b.store.retry()).toBe(1);
    expect(b.real.of()).toEqual({ language: "fr" });
  });

  test("a value arriving as its string form is stored as the bridge's own type", async () => {
    const b = device(new MemoryBackend(), "b");
    await b.store.write("bridgeSettings", compositeId.bridgeSetting(BRIDGE, "pageSize"), { value: "40" });
    await b.store.write("bridgeSettings", compositeId.bridgeSetting(BRIDGE, "dataSaver"), { value: "true" });
    expect(b.real.of()).toEqual({ pageSize: 40, dataSaver: true });
  });

  test("a value already held is not written again", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await b.real.provider.updateSettings(BRIDGE, { language: "fr" });
    b.real.writes.length = 0;
    await a.bridges.updateSettings(BRIDGE, { language: "fr" });
    await a.engine.sync();
    await b.engine.sync();
    expect(b.real.writes).toEqual([]);
  });

  test("a first pairing sends what only this device has, and takes the other's where both do", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.bridges.updateSettings(BRIDGE, { language: "fr" });
    await a.engine.sync();

    await b.real.provider.updateSettings(BRIDGE, { language: "en", pageSize: 30, password: "hunter2", excludedTags: ["gore"] });
    await b.real.provider.updateSettings("bridge-b", { language: "en" });
    await b.engine.sync();
    await adoptBridgeSettings(b.real.provider, [BRIDGE, "bridge-b", "bridge-c"], b.engine);
    await b.engine.sync();
    await a.engine.sync();

    expect(b.real.of().language).toBe("fr");
    expect(a.real.of()).toEqual({ language: "fr", pageSize: 30, excludedTags: ["gore"] });
    // bridge-b isn't one b can load, so nothing of it was sent; bridge-c has nothing stored.
    expect(carried(hub).filter((r) => !r.startsWith(`${BRIDGE}/`))).toEqual([]);
  });

  test("adoption is only for the tables it is asked for, and loads no bridge for host keys alone", async () => {
    const a = device(new MemoryBackend(), "a");
    await a.real.provider.updateSettings(BRIDGE, { excludedTags: ["gore"] });
    await adoptBridgeSettings(a.real.provider, [BRIDGE], a.engine, ["activity"]);
    expect(a.engine.hasUnsent()).toBe(false);
    await adoptBridgeSettings(a.real.provider, [BRIDGE], a.engine);
    expect(a.engine.hasUnsent()).toBe(true);
    expect(a.real.loads).toEqual([]);
  });

  test("the wrapped provider is otherwise the provider itself", async () => {
    const a = device(new MemoryBackend(), "a");
    expect(a.bridges.invalidate(BRIDGE)).toBe(`invalidated ${BRIDGE} on the provider`);
    expect(await a.bridges.storedSettings(BRIDGE)).toEqual({});
    await expect(a.bridges.get("missing")).rejects.toThrow("not found");
  });

  test("a write the provider refuses is refused through the wrapper, and records nothing", async () => {
    const a = device(new MemoryBackend(), "a");
    a.real.provider.updateSettings = async () => {
      throw new Error("disk full");
    };
    await expect(a.bridges.updateSettings(BRIDGE, { language: "fr" })).rejects.toThrow("disk full");
    expect(a.engine.hasUnsent()).toBe(false);
  });
});
