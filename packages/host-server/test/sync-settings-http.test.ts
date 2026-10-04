/**
 * Bridge settings sync through the real stack: a `BridgeManager` and its `SettingsStore` on each
 * side, the server's settings routes in front of one, and the example bridge's own descriptors
 * deciding what travels.
 */
import { join } from "node:path";
import { readdir, readFile, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { InMemoryLibraryStore } from "@comical/library";
import {
  bridgeSettingsSyncStore,
  composeSyncStores,
  LIBRARY_TABLES,
  librarySyncStore,
  SETTINGS_TABLES,
  SyncEngine,
  wrapBridgeSettings,
  type SyncedRegistry,
} from "@comical/sync";
import { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";
import { createSyncHost } from "../src/sync-host.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DIR = join(import.meta.dir, ".tmp-sync-settings-http");
const quiet = { error: () => {} };

const noRegistry: SyncedRegistry = {
  registries: async () => [],
  installed: async () => [],
  installedTrackers: async () => [],
  add: async () => {},
  remove: async () => {},
  install: async () => {},
  uninstall: async () => {},
  installTracker: async () => {},
  uninstallTracker: async () => {},
};

async function manager(name: string, baseUrl: string) {
  const dataDir = join(DIR, name);
  const settings = new SettingsStore(dataDir);
  await settings.set("example", { baseUrl });
  return new BridgeManager({ bridgesDir: BRIDGES_DIR, dataDir, settings });
}

let server: BridgeManager;
let other: BridgeManager;
let host: ReturnType<typeof createSyncHost<SyncedRegistry, BridgeManager>>;
let device: { engine: SyncEngine; bridges: BridgeManager };
let baseUrl: string;
let stop: () => void;

beforeAll(async () => {
  await rm(DIR, { recursive: true, force: true });
  server = await manager("server", "https://server.example");
  other = await manager("device", "https://device.example");

  host = createSyncHost({
    dir: join(DIR, "hub"),
    store: new InMemoryLibraryStore(),
    registry: noRegistry,
    bridges: server,
    lists: noRegistry,
    log: quiet,
  });
  await host.ready;
  const srv = Bun.serve({ port: 0, fetch: createRouter(host.bridges).fetch });
  baseUrl = `http://localhost:${srv.port}`;
  stop = () => srv.stop(true);

  const engine = new SyncEngine({
    store: composeSyncStores([
      [LIBRARY_TABLES, librarySyncStore(new InMemoryLibraryStore())],
      [SETTINGS_TABLES, bridgeSettingsSyncStore(other, { log: quiet })],
    ]),
    backend: host.backend,
    device: "device",
    name: () => "A device",
    newDeviceId: () => "device-2",
  });
  device = { engine, bridges: wrapBridgeSettings(other, engine) };
});

afterAll(async () => {
  stop();
  host.stop();
  await rm(DIR, { recursive: true, force: true });
});

const put = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("bridge settings saved over HTTP", () => {
  test("a preference and a content filter reach another device; the login saved beside them doesn't", async () => {
    expect((await put("/bridges/example/settings", { defaultSort: "author", sessionToken: "s3cret-token" })).status).toBe(200);
    expect((await put("/bridges/example/excluded-tags", { tags: ["t1"] })).status).toBe(200);
    expect((await put("/bridges/example/max-content-rating", { rating: "mature" })).status).toBe(200);
    await host.flush();
    await device.engine.sync();

    expect(await other.storedSettings("example")).toEqual({
      baseUrl: "https://device.example",
      defaultSort: "author",
      excludedTags: ["t1"],
      maxContentRating: "mature",
    });
    const segments = join(DIR, "hub", "segments");
    const kept = (await Promise.all((await readdir(segments)).map((f) => readFile(join(segments, f), "utf8")))).join();
    expect(kept).toContain("defaultSort");
    expect(kept).not.toContain("sessionToken");
    expect(kept).not.toContain("s3cret-token");
  });

  test("a preference changed on the other device shows in the server's own settings, login intact", async () => {
    await device.bridges.updateSettings("example", { defaultSort: "title", sessionToken: "device-token" });
    await device.engine.sync();
    await host.flush();

    const detail = (await fetch(`${baseUrl}/bridges/example`).then((r) => r.json())) as {
      values: Record<string, unknown>;
      secretsSet: string[];
      configured: boolean;
    };
    expect(detail.values.defaultSort).toBe("title");
    expect(detail.secretsSet).toEqual(["sessionToken"]);
    expect(detail.configured).toBe(true);
    expect((await server.storedSettings("example")).sessionToken).toBe("s3cret-token");
  });

  test("a rejected save records nothing", async () => {
    const before = (await readdir(join(DIR, "hub", "segments"))).length;
    expect((await put("/bridges/example/settings", { defaultSort: "nonsense" })).status).toBe(400);
    expect((await put("/bridges/nope/excluded-tags", { tags: ["t1"] })).status).toBe(404);
    await host.flush();
    expect(await readdir(join(DIR, "hub", "segments"))).toHaveLength(before);
  });
});
