/**
 * `GET /bridges/:id/settings/form` and `POST /bridges/:id/settings/actions/:key` — a bridge's live
 * settings screen (`Bridge.loadSettings` / `runSettingAction`, contract 2.1).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rateLimitedMessage, type SettingDescriptor, type SettingsForm } from "@comical/contract";
import type { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";

const info = (id: string) => ({
  id, name: id, version: "1.0.0", contractVersion: "2.1.0", languages: ["en"], nsfw: false, capabilities: ["settings"],
});
const SETTINGS: SettingDescriptor[] = [{ type: "string", key: "token", label: "Token", secret: true }];

const BRIDGES: Record<string, object> = {
  live: {
    getSettings: () => SETTINGS,
    loadSettings: async (): Promise<SettingsForm> => ({
      sections: [{
        title: "Account",
        items: [
          { type: "oauth-pin", key: "auth", label: "Auth", authUrl: "https://a.test", exchange: { url: "u", clientId: "c", clientSecret: "s", redirectUri: "r" } },
          { type: "action", key: "test", label: "Test login" },
        ],
      }],
    }),
    runSettingAction: async (key: string) => {
      if (key === "busy") throw new Error(rateLimitedMessage(5_000, "slow down"));
      return key === "test" ? { ok: false, message: "Token rejected" } : { ok: true };
    },
  },
  plain: { getSettings: () => SETTINGS },
};

let srv: ReturnType<typeof Bun.serve>;
const url = (path: string) => `http://localhost:${srv.port}${path}`;

beforeAll(() => {
  const mgr = {
    get: async (id: string) => {
      const b = BRIDGES[id];
      if (!b) throw new Error(`not found: ${id}`);
      return { info: info(id), ...b };
    },
    missingRequired: async () => [],
    storedSettings: async () => ({}),
  } as unknown as BridgeManager;
  srv = Bun.serve({ port: 0, fetch: createRouter(mgr).fetch });
});
afterAll(() => srv.stop(true));

describe("settings form", () => {
  test("GET /bridges/:id says whether there is a live form", async () => {
    expect(((await (await fetch(url("/bridges/live"))).json()) as { settingsForm: boolean }).settingsForm).toBe(true);
    expect(((await (await fetch(url("/bridges/plain"))).json()) as { settingsForm: boolean }).settingsForm).toBe(false);
  });

  test("serves the form with exchange secrets masked", async () => {
    const res = await fetch(url("/bridges/live/settings/form"));
    expect(res.status).toBe(200);
    const form = (await res.json()) as SettingsForm;
    expect(form.sections[0]!.title).toBe("Account");
    expect(JSON.stringify(form)).not.toContain(`"clientSecret":"s"`);
    expect(form.sections[0]!.items[1]).toEqual({ type: "action", key: "test", label: "Test login" });
  });

  test("404s for a bridge with no form, or no such bridge", async () => {
    expect((await fetch(url("/bridges/plain/settings/form"))).status).toBe(404);
    expect((await fetch(url("/bridges/missing/settings/form"))).status).toBe(404);
  });
});

describe("settings actions", () => {
  const press = (id: string, key: string) => fetch(url(`/bridges/${id}/settings/actions/${key}`), { method: "POST" });

  test("answers what the action reported", async () => {
    const res = await press("live", "test");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, message: "Token rejected" });
  });

  test("a throttled action is a 429", async () => {
    expect((await press("live", "busy")).status).toBe(429);
  });

  test("404s for a bridge with no actions", async () => {
    expect((await press("plain", "test")).status).toBe(404);
  });
});
