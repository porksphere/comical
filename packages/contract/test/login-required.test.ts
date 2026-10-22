import { describe, expect, test } from "bun:test";
import { isSecretSetting, loginRequiredMessage, parseLoginRequired, settingDescriptorSchema } from "../src/index.ts";

describe("login-required marker", () => {
  test("round-trips the setting key and reason", () => {
    expect(parseLoginRequired(loginRequiredMessage("cookies", "Favorites need you signed in"))).toEqual({
      key: "cookies",
      reason: "Favorites need you signed in",
    });
  });

  test("survives the prefixes a sandbox adds", () => {
    const msg = `Bridge call failed: Error: ${loginRequiredMessage("session")}`;
    expect(parseLoginRequired(msg)).toEqual({ key: "session", reason: "sign in to continue" });
  });

  test("null without the marker, or with a malformed one", () => {
    expect(parseLoginRequired("HTTP 401")).toBeNull();
    expect(parseLoginRequired("[login-required:cookies no close")).toBeNull();
    expect(parseLoginRequired("[login-required:] empty key")).toBeNull();
  });
});

describe("web-login setting", () => {
  const base = { type: "web-login", key: "cookies", label: "Account", url: "https://example.com/login", cookies: ["sid"] };

  test("accepts a sign-in page and the cookies it waits for", () => {
    const d = settingDescriptorSchema.parse({ ...base, cookieUrls: ["https://cdn.example.com/"] });
    expect(d.type).toBe("web-login");
  });

  test("needs at least one cookie name and a real URL", () => {
    expect(settingDescriptorSchema.safeParse({ ...base, cookies: [] }).success).toBe(false);
    expect(settingDescriptorSchema.safeParse({ ...base, url: "not a url" }).success).toBe(false);
  });

  test("is a secret, like the other credentials", () => {
    expect(isSecretSetting(settingDescriptorSchema.parse(base))).toBe(true);
    expect(isSecretSetting({ type: "string", key: "k", label: "K", secret: true })).toBe(true);
    expect(isSecretSetting({ type: "string", key: "k", label: "K" })).toBe(false);
    expect(isSecretSetting({ type: "boolean", key: "b", label: "B" })).toBe(false);
  });
});
