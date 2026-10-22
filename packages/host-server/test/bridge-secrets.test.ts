/**
 * `GET /bridges/:id` prefills the settings form with stored values, but a credential of any kind —
 * a secret string, an OAuth token, a sign-in's cookies — comes back only as a key in `secretsSet`.
 * The app reads that list to show "Signed in", so leaving a kind out both leaks the value and makes
 * the user look signed out.
 */
import { describe, expect, test } from "bun:test";
import type { BridgeInfo, SettingDescriptor, SettingValue } from "@comical/contract";
import type { BridgeProvider } from "../src/bridge-provider.ts";
import { createRouter } from "../src/router.ts";

const INFO: BridgeInfo = {
  id: "src",
  name: "Source",
  version: "1.0.0",
  contractVersion: "2.1.0",
  languages: ["en"],
  nsfw: false,
  capabilities: [],
};

const SETTINGS: SettingDescriptor[] = [
  { type: "web-login", key: "session", label: "Account", url: "https://site.example/login", cookies: ["sid"] },
  { type: "string", key: "token", label: "Token", secret: true },
  { type: "string", key: "mirror", label: "Mirror" },
];

async function get(stored: Record<string, SettingValue>) {
  const bridge = { info: INFO, getSettings: () => SETTINGS };
  const manager: BridgeProvider = {
    list: async () => [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: async (): Promise<any> => bridge,
    missingRequired: async () => [],
    storedSettings: async () => stored,
    updateSettings: async () => ({}),
    invalidate: () => {},
    refresh: () => {},
  };
  const app = createRouter(manager);
  const res = await app.fetch(new Request("http://embedded/bridges/src"));
  return (await res.json()) as { values: Record<string, SettingValue>; secretsSet: string[] };
}

describe("GET /bridges/:id — stored credentials", () => {
  test("a sign-in's cookies are reported as set, never echoed", async () => {
    const body = await get({ session: "sid=abc123", token: "tok", mirror: "eu" });
    expect(body.secretsSet.sort()).toEqual(["session", "token"]);
    expect(body.values).toEqual({ mirror: "eu" });
    expect(JSON.stringify(body)).not.toContain("abc123");
  });

  test("an empty sign-in is neither set nor echoed", async () => {
    const body = await get({ session: "" });
    expect(body.secretsSet).toEqual([]);
    expect(body.values).toEqual({});
  });
});
