/**
 * Tests the optional /registries/* and /registry/* route group. Routes are only mounted when a
 * RegistryManager is supplied to createRouter — this file verifies both the presence (with a
 * minimal mock manager) and the absence (no manager) cases.
 *
 * The mock avoids any network calls or filesystem I/O; it validates the routing layer and JSON
 * shapes, not the RegistryManager implementation (which has its own tests).
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AvailableBridge, SavedRegistry } from "@comical/registry";
import { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";
import type { RegistryManager } from "@comical/registry";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-registry-routes");

const SAVED_REGISTRY: SavedRegistry = {
  url: "https://example.com/registry.json",
  name: "Example Registry",
  requireSignature: false,
};

const mockRegistry = {
  list: async (): Promise<SavedRegistry[]> => [SAVED_REGISTRY],
  add: async (url: string): Promise<SavedRegistry> => ({ url, name: "New Registry", requireSignature: false }),
  remove: async (): Promise<void> => {},
  browse: async (): Promise<AvailableBridge[]> => [],
  browseAll: async (): Promise<AvailableBridge[]> => [],
  install: async (): Promise<{ id: string; version: string; bundlePath: string }> => ({
    id: "some-bridge",
    version: "1.0.0",
    bundlePath: "/tmp/some-bridge.js",
  }),
  update: async (bridgeId: string) => ({ id: bridgeId, version: "1.1.0", bundlePath: "/tmp/some-bridge.js" }),
  uninstall: async (): Promise<void> => {},
  checkUpdates: async () => [],
  browseAllTrackers: async () => [],
  browseTrackers: async () => [],
  installTracker: async (url: string, id: string) => ({ id, version: "1.0.0", bundlePath: `/tmp/${id}.js` }),
  updateTracker: async (id: string) => ({ id, version: "1.1.0", bundlePath: `/tmp/${id}.js` }),
  uninstallTracker: async (): Promise<void> => {},
  checkTrackerUpdates: async () => [],
  // registry bridge methods required for orphan detection (called by BridgeManager)
  allInstalledTrackers: async () => [],
  isOrphaned: async () => false,
  isTrackerOrphaned: async () => false,
  resolveBundle: async () => null,
  resolveTrackerBundle: async () => null,
} as unknown as RegistryManager;

let baseUrl: string;
let noRegistryUrl: string;
let stop: () => void;
let noRegistryStop: () => void;

beforeAll(() => {
  const manager = new BridgeManager({
    bridgesDir: BRIDGES_DIR,
    dataDir: DATA_DIR,
    settings: new SettingsStore(DATA_DIR),
  });

  const srv = Bun.serve({ port: 0, fetch: createRouter(manager, { registry: mockRegistry }).fetch });
  baseUrl = `http://localhost:${srv.port}`;
  stop = () => srv.stop(true);

  const noReg = Bun.serve({ port: 0, fetch: createRouter(manager).fetch });
  noRegistryUrl = `http://localhost:${noReg.port}`;
  noRegistryStop = () => noReg.stop(true);
});

afterAll(() => { stop(); noRegistryStop(); });

describe("GET /registries", () => {
  test("returns the list of saved registries", async () => {
    const list = await fetch(`${baseUrl}/registries`).then((r) => r.json()) as SavedRegistry[];
    expect(list).toHaveLength(1);
    expect(list[0]!.url).toBe("https://example.com/registry.json");
    expect(list[0]!.name).toBe("Example Registry");
  });
});

describe("POST /registries", () => {
  test("adds a registry by URL and returns 201", async () => {
    const res = await fetch(`${baseUrl}/registries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://new.example.com/registry.json" }),
    });
    expect(res.status).toBe(201);
    const data = await res.json() as SavedRegistry;
    expect(data.url).toBe("https://new.example.com/registry.json");
  });

  test("returns 400 when url is missing", async () => {
    const res = await fetch(`${baseUrl}/registries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 for invalid JSON body", async () => {
    const res = await fetch(`${baseUrl}/registries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /registries/:encodedUrl", () => {
  test("removes a registry and returns ok", async () => {
    const encodedUrl = encodeURIComponent("https://example.com/registry.json");
    const res = await fetch(`${baseUrl}/registries/${encodedUrl}`, { method: "DELETE" });
    expect(res.ok).toBe(true);
    const data = await res.json() as { ok: boolean };
    expect(data.ok).toBe(true);
  });
});

describe("GET /registry/bridges", () => {
  test("returns all bridges across registries (empty for mock)", async () => {
    const data = await fetch(`${baseUrl}/registry/bridges`).then((r) => r.json());
    expect(Array.isArray(data)).toBe(true);
  });
});

describe("GET /registry/updates", () => {
  test("returns empty updates list for mock", async () => {
    const data = await fetch(`${baseUrl}/registry/updates`).then((r) => r.json());
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(0);
  });
});

describe("GET /registry/trackers", () => {
  test("returns all trackers across registries (empty for mock)", async () => {
    const data = await fetch(`${baseUrl}/registry/trackers`).then((r) => r.json());
    expect(Array.isArray(data)).toBe(true);
  });
});

describe("registry routes absent without RegistryManager", () => {
  test("GET /registries → 404", async () => {
    expect((await fetch(`${noRegistryUrl}/registries`)).status).toBe(404);
  });

  test("GET /registry/bridges → 404", async () => {
    expect((await fetch(`${noRegistryUrl}/registry/bridges`)).status).toBe(404);
  });
});
