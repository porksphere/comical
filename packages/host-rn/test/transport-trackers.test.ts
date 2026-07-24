/**
 * The embedded transport's optional on-device tracker support: when `createEmbeddedTransport` is
 * given a `TrackerProvider` (built by `installEmbeddedTransport` from injected `trackerBundles` +
 * `trackerSettings`, only when a native tracker runtime is registered — see `install.ts`), the
 * reused `@comical/host-server` router mounts the `/trackers*` endpoints and resolves them
 * in-process. Without it, those endpoints are unmounted (404) — the same "absent capability"
 * pattern as `transport-library.test.ts`'s `/library*` coverage.
 */
import { describe, expect, test } from "bun:test";
import { createRouter } from "@comical/host-server/router";
import { createEmbeddedTransport } from "../src/transport.ts";
import type { BridgeProvider, CreateRouter, TrackerProvider, TrackerSummary } from "../src/types.ts";

// The `/trackers*` routes exercised here never touch a bridge, so a stub that throws is enough —
// it proves the tracker endpoints resolve purely from the injected TrackerProvider.
const stubBridgeProvider = {
  list: async () => [],
  get: async () => {
    throw new Error("bridge not found");
  },
  missingRequired: async () => [],
  storedSettings: async () => ({}),
  updateSettings: async () => ({}),
  invalidate: () => {},
  refresh: () => {},
} as unknown as BridgeProvider;

const TRACKER_SUMMARY: TrackerSummary = {
  info: {
    id: "anilist",
    name: "AniList",
    version: "1.0.0",
    contractVersion: "1.0.0",
    capabilities: ["library-sync", "settings"],
  },
  settings: [{ type: "string", key: "token", label: "Token", required: true }],
  values: {},
  secretsSet: [],
  configured: true,
  missingRequired: [],
  source: "registry",
};

const stubTrackerProvider: TrackerProvider = {
  list: async () => [TRACKER_SUMMARY],
  get: async (id) => {
    if (id !== "anilist") throw new Error(`tracker not found: ${id}`);
    return { info: TRACKER_SUMMARY.info, getSettings: () => TRACKER_SUMMARY.settings };
  },
  storedSettings: async () => ({}),
  updateSettings: async (_id, patch) => patch,
  invalidate: () => {},
};

const OAUTH_TRACKER_SUMMARY: TrackerSummary = {
  info: {
    id: "anilist",
    name: "AniList",
    version: "1.0.0",
    contractVersion: "1.0.0",
    capabilities: ["library-sync", "settings"],
  },
  settings: [
    {
      type: "oauth-callback",
      key: "token",
      label: "AniList Account",
      authUrlTemplate: "https://example.com/authorize?client_id={clientId}&redirect_uri={callbackUrl}&state={state}",
      exchange: { url: "https://example.com/token", clientId: "abc" },
    },
  ],
  values: {},
  secretsSet: [],
  configured: false,
  missingRequired: [],
  source: "registry",
};

const oauthTrackerProvider: TrackerProvider = {
  list: async () => [OAUTH_TRACKER_SUMMARY],
  get: async (id) => {
    if (id !== "anilist") throw new Error(`tracker not found: ${id}`);
    return { info: OAUTH_TRACKER_SUMMARY.info, getSettings: () => OAUTH_TRACKER_SUMMARY.settings };
  },
  storedSettings: async () => ({}),
  updateSettings: async (_id, patch) => patch,
  invalidate: () => {},
};

const makeCreate = () => createRouter as unknown as CreateRouter;

describe("embedded transport — on-device trackers", () => {
  test("mounts /trackers* when a TrackerProvider is supplied", async () => {
    const t = createEmbeddedTransport(stubBridgeProvider, makeCreate(), undefined, undefined, undefined, undefined, undefined, stubTrackerProvider);

    const list = await t("/trackers");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { info: { id: string }; configured: boolean }[];
    expect(body[0]?.info.id).toBe("anilist");
    expect(body[0]?.configured).toBe(true);

    const settingsRes = await t("/trackers/anilist/settings");
    expect(settingsRes.status).toBe(200);
    const settingsBody = (await settingsRes.json()) as { info: { id: string }; settings: { key: string }[] };
    expect(settingsBody.info.id).toBe("anilist");
    expect(settingsBody.settings.map((d) => d.key)).toEqual(["token"]);

    // Unknown tracker id -> the router's not-found mapping (see router.ts's `msg.includes("not found")`).
    const missing = await t("/trackers/nope/settings");
    expect(missing.status).toBe(404);
  });

  test("leaves /trackers* unmounted (404) when no TrackerProvider is supplied", async () => {
    const t = createEmbeddedTransport(stubBridgeProvider, makeCreate());
    const res = await t("/trackers");
    expect(res.status).toBe(404);
  });

  // On-device there's no real HTTP server to redirect an OAuth provider back to, so
  // `installEmbeddedTransport` threads the app's own custom-scheme deep link through as
  // `callbackBaseUrl` — this proves it actually reaches the router's `oauth-start` route instead of
  // silently falling back to the default `http://localhost:3100`.
  test("threads callbackBaseUrl into oauth-start's authUrl instead of the localhost default", async () => {
    const withCustomBase = createEmbeddedTransport(
      stubBridgeProvider, makeCreate(), undefined, undefined, undefined, undefined, undefined,
      oauthTrackerProvider, "comical://oauth-callback",
    );
    const res = await withCustomBase("/trackers/anilist/oauth-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "token" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authUrl: string };
    expect(body.authUrl).toContain(encodeURIComponent("comical://oauth-callback/oauth/callback"));
    expect(body.authUrl).not.toContain("localhost");
  });

  test("falls back to the localhost default when no callbackBaseUrl is supplied", async () => {
    const withoutCustomBase = createEmbeddedTransport(
      stubBridgeProvider, makeCreate(), undefined, undefined, undefined, undefined, undefined,
      oauthTrackerProvider,
    );
    const res = await withoutCustomBase("/trackers/anilist/oauth-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "token" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authUrl: string };
    expect(body.authUrl).toContain(encodeURIComponent("http://localhost:3100/oauth/callback"));
  });
});
