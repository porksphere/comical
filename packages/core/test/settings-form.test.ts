import { describe, expect, test } from "bun:test";
import { settingsFormSchema } from "@comical/contract";
import type { HostCapabilities, SettingDescriptor, SettingsForm } from "@comical/contract";
import { BridgeValidationError, loadBridge, normalizeSettingsForm, redactSettingsForm } from "../src/index.ts";

const DECLARED: SettingDescriptor[] = [
  { type: "string", key: "token", label: "Token", secret: true },
  { type: "boolean", key: "adult", label: "Adult", default: false },
  {
    type: "enum", key: "slot", label: "Slot", default: "0",
    options: [{ value: "0", label: "0" }, { value: "1", label: "1" }, { value: "2", label: "2" }],
  },
  { type: "string", key: "server", label: "Server", required: true },
];

describe("settingsFormSchema", () => {
  test("accepts sections of settings and actions", () => {
    expect(settingsFormSchema.safeParse({
      sections: [{ title: "Account", footer: "f", items: [DECLARED[0], { type: "action", key: "test", label: "Test login" }] }],
    }).success).toBe(true);
  });

  test("rejects an action with no label", () => {
    expect(settingsFormSchema.safeParse({ sections: [{ items: [{ type: "action", key: "test", label: "" }] }] }).success).toBe(false);
  });
});

describe("normalizeSettingsForm", () => {
  test("keeps what is stored from getSettings and takes presentation from the form", () => {
    const { form, issues } = normalizeSettingsForm({
      sections: [{
        title: "Account",
        items: [
          // The form tries to make the token a plain string with a default; only the presentation sticks.
          { type: "string", key: "token", label: "API token", description: "From your profile", placeholder: "abc…", default: "x" },
          { type: "action", key: "test", label: "Test login" },
          { type: "string", key: "server", label: "Server URL" },
        ],
      }],
    }, DECLARED);
    expect(issues).toEqual([]);
    expect(form.sections[0]!.items).toEqual([
      { type: "string", key: "token", label: "API token", description: "From your profile", placeholder: "abc…", secret: true },
      { type: "action", key: "test", label: "Test login" },
      { type: "string", key: "server", label: "Server URL", required: true },
    ]);
  });

  test("renames and narrows an enum's options but never adds one", () => {
    const { form, issues } = normalizeSettingsForm({
      sections: [{ items: [{
        type: "enum", key: "slot", label: "Slot",
        options: [{ value: "1", label: "Manga" }, { value: "0", label: "Reading" }, { value: "9", label: "Made up" }],
      }] }],
    }, DECLARED);
    const slot = form.sections[0]!.items[0] as Extract<SettingDescriptor, { type: "enum" }>;
    expect(slot.options).toEqual([{ value: "1", label: "Manga" }, { value: "0", label: "Reading" }]);
    expect(slot.default).toBe("0");
    expect(issues).toEqual([`"slot" offers options getSettings() doesn't`, expect.stringContaining("server")]);
  });

  test("an enum left with no declared option keeps the declared ones", () => {
    const { form } = normalizeSettingsForm({
      sections: [{ items: [{ type: "enum", key: "slot", label: "Slot", options: [{ value: "9", label: "?" }] }, DECLARED[3]!] }],
    }, DECLARED);
    expect((form.sections[0]!.items[0] as Extract<SettingDescriptor, { type: "enum" }>).options).toHaveLength(3);
  });

  test("drops undeclared keys, changed types, repeats and actions on a setting's key", () => {
    const { form, issues } = normalizeSettingsForm({
      sections: [
        { title: "Gone", items: [{ type: "string", key: "nope", label: "Nope" }, { type: "string", key: "adult", label: "Adult" }] },
        {
          items: [
            DECLARED[3]!,
            { type: "string", key: "server", label: "Again" },
            { type: "action", key: "token", label: "Clash" },
            { type: "action", key: "go", label: "Go" },
            { type: "action", key: "go", label: "Go again" },
          ],
        },
      ],
    }, DECLARED);
    expect(form.sections).toEqual([{ items: [DECLARED[3]!, { type: "action", key: "go", label: "Go" }] }]);
    expect(issues).toHaveLength(5);
  });

  test("puts a required setting the form left out back at the end; optional ones may be hidden", () => {
    const { form } = normalizeSettingsForm({ sections: [{ title: "Content", items: [DECLARED[1]!] }] }, DECLARED);
    expect(form.sections).toEqual([{ title: "Content", items: [DECLARED[1]!] }, { items: [DECLARED[3]!] }]);
  });
});

test("redactSettingsForm masks an exchange secret and leaves actions alone", () => {
  const form: SettingsForm = {
    sections: [{ items: [
      { type: "oauth-pin", key: "auth", label: "Auth", authUrl: "https://a.test", exchange: { url: "u", clientId: "c", clientSecret: "s", redirectUri: "r" } },
      { type: "action", key: "go", label: "Go" },
    ] }],
  };
  const out = redactSettingsForm(form).sections[0]!.items;
  expect((out[0] as Extract<SettingDescriptor, { type: "oauth-pin" }>).exchange!.clientSecret).toBe("");
  expect(out[1]).toEqual({ type: "action", key: "go", label: "Go" });
});

describe("loader loadSettings / runSettingAction", () => {
  const warnings: string[] = [];
  const host = (): HostCapabilities => ({
    network: { request: async () => ({ url: "", status: 200, statusText: "OK", headers: {}, body: "" }) },
    storage: {
      get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [],
      secure: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
    },
    log: { debug() {}, info() {}, warn: (m: string) => { warnings.push(m); }, error() {} },
    settings: { token: "t" },
  });
  const BRIDGE = (body: string) => `module.exports = { default: (host) => ({
    info: { id: "frm", name: "Frm", version: "0.0.0", contractVersion: "2.1.0", languages: ["en"], nsfw: false, capabilities: ["settings"] },
    getSeriesDetails: async (id) => ({ id, title: "T" }),
    getSettings: () => [{ type: "string", key: "token", label: "Token", secret: true }],
    ${body}
  }) };`;

  test("serves the form held to getSettings, and logs what it changed", async () => {
    warnings.length = 0;
    const b = await loadBridge({
      code: BRIDGE(`loadSettings: async () => ({ sections: [{ title: "Account", items: [
        { type: "string", key: "token", label: host.settings.token ? "Token (saved)" : "Token" },
        { type: "string", key: "extra", label: "Extra" },
        { type: "action", key: "test", label: "Test login" },
      ] }] }),`),
      capabilities: host(),
    });
    expect(await b.loadSettings!()).toEqual({ sections: [{ title: "Account", items: [
      { type: "string", key: "token", label: "Token (saved)", secret: true },
      { type: "action", key: "test", label: "Test login" },
    ] }] });
    expect(warnings).toEqual([expect.stringContaining(`"extra"`)]);
  });

  test("rejects a malformed form", async () => {
    const b = await loadBridge({ code: BRIDGE(`loadSettings: async () => ({ sections: [{ items: [{ type: "action" }] }] }),`), capabilities: host() });
    await expect(b.loadSettings!()).rejects.toBeInstanceOf(BridgeValidationError);
  });

  test("runs an action and validates its answer", async () => {
    const b = await loadBridge({
      code: BRIDGE(`runSettingAction: async (key) => key === "test" ? { ok: true, message: "Signed in" } : { ok: "yes" },`),
      capabilities: host(),
    });
    expect(await b.runSettingAction!("test")).toEqual({ ok: true, message: "Signed in" });
    await expect(b.runSettingAction!("other")).rejects.toBeInstanceOf(BridgeValidationError);
    await expect(b.runSettingAction!("")).rejects.toThrow();
  });

  test("a bridge without them exposes neither", async () => {
    const b = await loadBridge({ code: BRIDGE(""), capabilities: host() });
    expect(b.loadSettings).toBeUndefined();
    expect(b.runSettingAction).toBeUndefined();
  });
});
