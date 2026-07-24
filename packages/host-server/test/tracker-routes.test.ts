/**
 * Tests the optional /trackers/* route group. Routes are only mounted when a TrackerManager is
 * supplied to createRouter — this file verifies both the presence (with a minimal mock manager)
 * and the absence (no manager) cases.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SettingValue } from "@comical/contract";
import { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";
import type { TrackerManager, TrackerSummary } from "../src/tracker-manager.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-tracker-routes");

const TRACKER_SUMMARY: TrackerSummary = {
  info: {
    id: "mock-tracker",
    name: "Mock Tracker",
    version: "1.0.0",
    contractVersion: "1.0.0",
    capabilities: [],
  },
  settings: [
    { key: "apiKey", label: "API Key", type: "string", secret: true },
    {
      key: "token",
      label: "Account",
      type: "oauth-callback",
      authUrlTemplate: "https://example.com/authorize?client_id={clientId}",
      exchange: { url: "https://example.com/token", clientId: "public-client-id", clientSecret: "should-never-leave-the-host" },
    },
  ],
  values: {},
  secretsSet: ["apiKey"],
  configured: true,
  missingRequired: [],
  source: "registry",
};

const mockManager = {
  list: async (): Promise<TrackerSummary[]> => [TRACKER_SUMMARY],
  get: async (id: string) => {
    if (id !== "mock-tracker") throw new Error(`tracker not found: ${id}`);
    return {
      info: TRACKER_SUMMARY.info,
      getSettings: () => TRACKER_SUMMARY.settings,
    };
  },
  storedSettings: async (): Promise<Record<string, SettingValue>> => ({ apiKey: "stored-secret" }),
  updateSettings: async (_id: string, patch: Record<string, SettingValue>) => patch,
  invalidate: (_id: string): void => {},
} as unknown as TrackerManager;

let baseUrl: string;
let noTrackerUrl: string;
let stop: () => void;
let noTrackerStop: () => void;

beforeAll(() => {
  const manager = new BridgeManager({
    bridgesDir: BRIDGES_DIR,
    dataDir: DATA_DIR,
    settings: new SettingsStore(DATA_DIR),
  });

  const srv = Bun.serve({ port: 0, fetch: createRouter(manager, { trackers: mockManager }).fetch });
  baseUrl = `http://localhost:${srv.port}`;
  stop = () => srv.stop(true);

  const noTrackerSrv = Bun.serve({ port: 0, fetch: createRouter(manager).fetch });
  noTrackerUrl = `http://localhost:${noTrackerSrv.port}`;
  noTrackerStop = () => noTrackerSrv.stop(true);
});

afterAll(() => { stop(); noTrackerStop(); });

describe("GET /trackers", () => {
  test("lists trackers from the manager", async () => {
    const list = await fetch(`${baseUrl}/trackers`).then((r) => r.json()) as TrackerSummary[];
    expect(list).toHaveLength(1);
    expect(list[0]!.info.id).toBe("mock-tracker");
    expect(list[0]!.configured).toBe(true);
    expect(list[0]!.source).toBe("registry");
  });
});

describe("GET /trackers/:id/settings", () => {
  test("returns info, settings descriptors, and masks secret values", async () => {
    const data = await fetch(`${baseUrl}/trackers/mock-tracker/settings`).then((r) => r.json()) as {
      info: { id: string };
      settings: { key: string; type: string; exchange?: { clientSecret?: string; clientId?: string } }[];
      values: Record<string, SettingValue>;
      secretsSet: string[];
    };
    expect(data.info.id).toBe("mock-tracker");
    expect(data.settings).toHaveLength(2);
    // apiKey is secret — must appear in secretsSet, not in values
    expect(data.secretsSet).toContain("apiKey");
    expect(data.values["apiKey"]).toBeUndefined();
    // the oauth-callback descriptor's exchange.clientSecret must never be serialized to a client,
    // while non-secret exchange metadata (clientId) stays visible — regression test for a real
    // credential leak found in this route.
    const oauth = data.settings.find((s) => s.key === "token");
    expect(oauth?.exchange?.clientSecret).toBe("");
    expect(oauth?.exchange?.clientId).toBe("public-client-id");
  });

  test("returns 404 for unknown tracker", async () => {
    const res = await fetch(`${baseUrl}/trackers/nonexistent/settings`);
    expect(res.status).toBe(404);
  });
});

describe("PUT /trackers/:id/settings", () => {
  test("saves and echoes back updated settings", async () => {
    const res = await fetch(`${baseUrl}/trackers/mock-tracker/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "new-value" }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as { settings: Record<string, SettingValue> };
    expect(data.settings["apiKey"]).toBe("new-value");
  });

  test("returns 400 for invalid JSON body", async () => {
    const res = await fetch(`${baseUrl}/trackers/mock-tracker/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("tracker routes absent without TrackerManager", () => {
  test("GET /trackers → 404", async () => {
    expect((await fetch(`${noTrackerUrl}/trackers`)).status).toBe(404);
  });

  test("GET /trackers/:id/settings → 404", async () => {
    expect((await fetch(`${noTrackerUrl}/trackers/any/settings`)).status).toBe(404);
  });
});
