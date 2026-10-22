/**
 * A bridge that needs the user signed in throws `loginRequiredMessage(key, reason)`; the router answers
 * 401 `{ error, loginRequired: { key, reason } }`, so a client can send the user to that setting.
 */
import { describe, expect, test } from "bun:test";
import { loginRequiredMessage, type BridgeInfo, type SeriesEntry } from "@comical/contract";
import type { BridgeProvider } from "../src/bridge-provider.ts";
import { createRouter } from "../src/router.ts";

const INFO: BridgeInfo = {
  id: "src",
  name: "Source",
  version: "1.0.0",
  contractVersion: "2.1.0",
  languages: ["en"],
  nsfw: false,
  capabilities: ["favorites"],
};

function setup(signedIn: boolean) {
  const bridge = {
    info: INFO,
    getFavorites: async (): Promise<{ items: SeriesEntry[] }> => {
      if (!signedIn) throw new Error(`getFavorites threw: ${loginRequiredMessage("cookies", "Sign in to see favorites")}`);
      return { items: [] };
    },
    addFavorite: async () => {
      throw new Error("getFavorites threw: HTTP 503");
    },
  };
  const manager: BridgeProvider = {
    list: async () => [{ info: INFO, settings: [], configured: true, secretsSet: [], missingRequired: [], source: "registry" as const }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: async (id: string): Promise<any> => {
      if (id !== "src") throw new Error(`bridge not found: ${id}`);
      return bridge;
    },
    missingRequired: async () => [],
    storedSettings: async () => ({}),
    updateSettings: async () => ({}),
    invalidate: () => {},
    refresh: () => {},
  };
  const app = createRouter(manager);
  return (p: string, method = "GET") => app.fetch(new Request(`http://embedded${p}`, { method }));
}

describe("login required", () => {
  test("answers 401 naming the setting that signs in", async () => {
    const res = await setup(false)("/bridges/src/favorites");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { loginRequired: { key: string; reason: string } };
    expect(body.loginRequired).toEqual({ key: "cookies", reason: "Sign in to see favorites" });
  });

  test("signed in, the same route answers normally", async () => {
    expect((await setup(true)("/bridges/src/favorites")).status).toBe(200);
  });

  test("any other failure is still a 500, not a sign-in problem", async () => {
    const res = await setup(true)("/bridges/src/favorites/x", "PUT");
    expect(res.status).toBe(500);
    expect(((await res.json()) as { loginRequired?: unknown }).loginRequired).toBeUndefined();
  });
});
