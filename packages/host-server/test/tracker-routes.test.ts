/**
 * Tests the optional /trackers/* route group. Routes are only mounted when a TrackerManager is
 * supplied to createRouter — this file verifies both the presence (with a minimal mock manager)
 * and the absence (no manager) cases.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SettingValue } from "@comical/contract";
import { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter, DEFAULT_OAUTH_REDIRECT_URL } from "../src/router.ts";
import type { TrackerManager, TrackerSummary } from "../src/tracker-manager.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-tracker-routes");

const TRACKER_SUMMARY: TrackerSummary = {
  info: {
    id: "mock-tracker",
    name: "Mock Tracker",
    version: "1.0.0",
    contractVersion: "2.0.0",
    capabilities: [],
  },
  settings: [
    { key: "apiKey", label: "API Key", type: "string", secret: true },
    {
      key: "token",
      label: "Account",
      type: "oauth-callback",
      authUrlTemplate: "https://example.com/authorize?client_id={clientId}&redirect_uri={callbackUrl}&state={state}",
      // `url` is repointed at the mock token endpoint in beforeAll.
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
  updateSettings: async (_id: string, patch: Record<string, SettingValue>) => {
    savedSettings.push(patch);
    return patch;
  },
  invalidate: (_id: string): void => {},
} as unknown as TrackerManager;
const savedSettings: Record<string, SettingValue>[] = [];
/** The form bodies the mock token endpoint received, newest last. */
const tokenExchanges: URLSearchParams[] = [];

let baseUrl: string;
let customRedirectUrl: string;
let noTrackerUrl: string;
let stop: () => void;
let customRedirectStop: () => void;
let noTrackerStop: () => void;
let tokenStop: () => void;

beforeAll(() => {
  const manager = new BridgeManager({
    bridgesDir: BRIDGES_DIR,
    dataDir: DATA_DIR,
    settings: new SettingsStore(DATA_DIR),
  });

  const tokenSrv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      tokenExchanges.push(new URLSearchParams(await req.text()));
      return Response.json({ access_token: "issued-access", refresh_token: "issued-refresh", expires_in: 3600 });
    },
  });
  tokenStop = () => tokenSrv.stop(true);
  const oauthField = TRACKER_SUMMARY.settings.find((d) => d.type === "oauth-callback");
  if (oauthField?.type === "oauth-callback") oauthField.exchange.url = `http://localhost:${tokenSrv.port}/token`;

  const srv = Bun.serve({ port: 0, fetch: createRouter(manager, { trackers: mockManager }).fetch });
  baseUrl = `http://localhost:${srv.port}`;
  stop = () => srv.stop(true);

  const customSrv = Bun.serve({
    port: 0,
    fetch: createRouter(manager, { trackers: mockManager, oauthRedirectUrl: "https://relay.example/return" }).fetch,
  });
  customRedirectUrl = `http://localhost:${customSrv.port}`;
  customRedirectStop = () => customSrv.stop(true);

  const noTrackerSrv = Bun.serve({ port: 0, fetch: createRouter(manager).fetch });
  noTrackerUrl = `http://localhost:${noTrackerSrv.port}`;
  noTrackerStop = () => noTrackerSrv.stop(true);
});

afterAll(() => { stop(); customRedirectStop(); noTrackerStop(); tokenStop(); });

const startOAuth = (base: string, body: Record<string, unknown>) =>
  fetch(`${base}/trackers/mock-tracker/oauth-start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const stateOf = (authUrl: string): string => {
  const state = new URL(authUrl).searchParams.get("state");
  if (!state) throw new Error(`no state in ${authUrl}`);
  return state;
};

describe("POST /trackers/:id/oauth-start", () => {
  test("aims the provider at the shared relay and tags the state with where to return", async () => {
    const res = await startOAuth(baseUrl, { key: "token", returnTo: "native" });
    expect(res.status).toBe(200);
    const { authUrl } = (await res.json()) as { authUrl: string };
    const url = new URL(authUrl);
    expect(url.searchParams.get("redirect_uri")).toBe(DEFAULT_OAUTH_REDIRECT_URL);
    expect(url.searchParams.get("client_id")).toBe("public-client-id");
    expect(stateOf(authUrl)).toMatch(/^native:[0-9a-f]{32}$/);
  });

  test("defaults the return to a web popup", async () => {
    const res = await startOAuth(baseUrl, { key: "token" });
    expect(res.status).toBe(200);
    const { authUrl } = (await res.json()) as { authUrl: string };
    expect(stateOf(authUrl)).toMatch(/^web:[0-9a-f]{32}$/);
  });

  test("rejects a return target the relay would not understand", async () => {
    const res = await startOAuth(baseUrl, { key: "token", returnTo: "carrier-pigeon" });
    expect(res.status).toBe(400);
  });

  test("honours a self-hosted redirect override", async () => {
    const res = await startOAuth(customRedirectUrl, { key: "token" });
    expect(res.status).toBe(200);
    const { authUrl } = (await res.json()) as { authUrl: string };
    expect(new URL(authUrl).searchParams.get("redirect_uri")).toBe("https://relay.example/return");
  });
});

describe("GET /oauth/callback", () => {
  test("exchanges the code against the same redirect_uri the provider saw, then stores the token blob", async () => {
    const started = (await (await startOAuth(baseUrl, { key: "token", returnTo: "native" })).json()) as { authUrl: string };
    const state = stateOf(started.authUrl);
    const before = tokenExchanges.length;

    const res = await fetch(`${baseUrl}/oauth/callback?code=the-code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(200);

    const exchange = tokenExchanges[before];
    expect(exchange?.get("grant_type")).toBe("authorization_code");
    expect(exchange?.get("code")).toBe("the-code");
    // A provider refuses the exchange when this differs from the authorize request's redirect_uri.
    expect(exchange?.get("redirect_uri")).toBe(DEFAULT_OAUTH_REDIRECT_URL);
    expect(exchange?.get("client_secret")).toBe("should-never-leave-the-host");

    const saved = savedSettings.at(-1);
    const blob = JSON.parse(String(saved?.token)) as { access: string; refresh?: string; expiresAt?: number };
    expect(blob.access).toBe("issued-access");
    expect(blob.refresh).toBe("issued-refresh");
    expect(blob.expiresAt).toBeGreaterThan(Date.now());
  });

  test("a state is single-use", async () => {
    const started = (await (await startOAuth(baseUrl, { key: "token" })).json()) as { authUrl: string };
    const state = stateOf(started.authUrl);
    expect((await fetch(`${baseUrl}/oauth/callback?code=c&state=${encodeURIComponent(state)}`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/oauth/callback?code=c&state=${encodeURIComponent(state)}`)).status).toBe(400);
  });

  test("an unknown state is refused without touching the provider", async () => {
    const before = tokenExchanges.length;
    expect((await fetch(`${baseUrl}/oauth/callback?code=c&state=web:nope`)).status).toBe(400);
    expect(tokenExchanges.length).toBe(before);
  });
});

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
