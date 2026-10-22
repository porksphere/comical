import { describe, expect, test } from "bun:test";

import { defineSettings, type InferSettings } from "../src/settings.ts";

const SETTINGS = defineSettings([
  { type: "string", key: "apiKey", label: "API key", secret: true, required: true },
  { type: "web-login", key: "session", label: "Account", url: "https://example.com/login", cookies: ["sid"] },
  { type: "oauth-pin", key: "token", label: "Token", authUrl: "https://example.com/auth" },
  { type: "enum", key: "region", label: "Region", options: [{ value: "us", label: "US" }, { value: "eu", label: "EU" }] },
  { type: "enum", key: "tags", label: "Tags", multiple: true, options: [{ value: "a", label: "A" }] },
  { type: "number", key: "limit", label: "Limit" },
]);
type S = InferSettings<typeof SETTINGS>;

describe("InferSettings", () => {
  test("a sign-in's value is the string it stores", () => {
    const s: S = { apiKey: "k", session: "sid=1", token: "t" };
    const session: string | undefined = s.session;
    const token: string | undefined = s.token;
    expect([session, token]).toEqual(["sid=1", "t"]);
  });

  test("required keys are present, and enums narrow to their options", () => {
    // @ts-expect-error apiKey is required
    const missing: S = {};
    const s: S = { apiKey: "k", region: "eu", tags: ["a"], limit: 3 };
    // @ts-expect-error "jp" is not an option
    const wrong: S = { apiKey: "k", region: "jp" };
    void [missing, wrong];
    expect(s.region).toBe("eu");
  });
});
