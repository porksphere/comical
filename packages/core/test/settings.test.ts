import { describe, expect, test } from "bun:test";
import type { HostCapabilities, SettingDescriptor, SettingValue } from "@comical/contract";
import { BridgeSettingsError, loadBridge, redactSettingSecrets, resolveSettings, validateSettingsInput } from "../src/index.ts";

function mockHost(settings: Record<string, SettingValue>): HostCapabilities {
  const store = new Map<string, string>();
  return {
    network: { request: async () => ({ url: "", status: 200, statusText: "OK", headers: {}, body: "" }) },
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, v),
      delete: async (k) => void store.delete(k),
      keys: async () => [...store.keys()],
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    settings,
  };
}

const INFO = `{ id: "s", name: "S", version: "0", contractVersion: "1.0.0", languages: ["en"], nsfw: false, capabilities: ["settings"] }`;
// A bridge whose getSeriesDetails echoes a setting value back through the title, so tests can
// observe the resolved (defaulted/coerced) settings the bridge actually sees.
const SETTINGS_BRIDGE = `module.exports = { default: (host) => ({
  info: ${INFO},
  getSettings: () => [
    { type: "string", key: "baseUrl", label: "URL", required: true },
    { type: "number", key: "perPage", label: "Per page", default: 40 },
  ],
  getSeriesDetails: async (id) => ({ id, title: String(host.settings.perPage) + ":" + typeof host.settings.perPage }),
  getChapters: async () => [],
  getChapterPages: async () => [],
}) };`;

const DESCRIPTORS: SettingDescriptor[] = [
  { type: "string", key: "baseUrl", label: "Backend URL", required: true },
  { type: "string", key: "apiKey", label: "API key", secret: true },
  { type: "number", key: "perPage", label: "Per page", default: 40, min: 1, max: 100 },
  { type: "boolean", key: "adult", label: "Adult", default: false },
  {
    type: "enum",
    key: "region",
    label: "Region",
    options: [{ value: "us", label: "US" }, { value: "eu", label: "EU" }],
    default: "us",
  },
];

describe("resolveSettings (load-time enforcement)", () => {
  test("applies declared defaults for unset keys", () => {
    const { values } = resolveSettings({ baseUrl: "https://x" }, DESCRIPTORS);
    expect(values.perPage).toBe(40);
    expect(values.adult).toBe(false);
    expect(values.region).toBe("us");
  });

  test("coerces string inputs to number/boolean (CLI --set ergonomics)", () => {
    const { values } = resolveSettings(
      { baseUrl: "https://x", perPage: "25", adult: "true" },
      DESCRIPTORS,
    );
    expect(values.perPage).toBe(25);
    expect(values.adult).toBe(true);
  });

  test("reports missing required without throwing", () => {
    const { missingRequired } = resolveSettings({}, DESCRIPTORS);
    expect(missingRequired).toEqual(["baseUrl"]);
  });

  test("throws BridgeSettingsError on an out-of-range number", () => {
    expect(() => resolveSettings({ baseUrl: "https://x", perPage: 999 }, DESCRIPTORS)).toThrow(
      BridgeSettingsError,
    );
  });

  test("throws on an invalid enum value", () => {
    expect(() => resolveSettings({ baseUrl: "https://x", region: "antarctica" }, DESCRIPTORS)).toThrow(
      BridgeSettingsError,
    );
  });

  test("does not throw merely because a required value is absent", () => {
    expect(() => resolveSettings({}, DESCRIPTORS)).not.toThrow();
  });
});

describe("validateSettingsInput (update-time, no defaults)", () => {
  test("coerces and returns only the supplied keys", () => {
    const out = validateSettingsInput({ perPage: "10" }, DESCRIPTORS);
    expect(out).toEqual({ perPage: 10 });
  });

  test("rejects unknown keys", () => {
    expect(() => validateSettingsInput({ nope: "x" }, DESCRIPTORS)).toThrow(BridgeSettingsError);
  });

  test("rejects a non-coercible number", () => {
    expect(() => validateSettingsInput({ perPage: "abc" }, DESCRIPTORS)).toThrow(BridgeSettingsError);
  });

  test("accepts a valid enum value", () => {
    expect(validateSettingsInput({ region: "eu" }, DESCRIPTORS)).toEqual({ region: "eu" });
  });
});

describe("redactSettingSecrets", () => {
  test("masks exchange.clientSecret on an oauth-callback descriptor, keeps clientId/url visible", () => {
    const descriptors: SettingDescriptor[] = [{
      type: "oauth-callback",
      key: "token",
      label: "Account",
      authUrlTemplate: "https://example.com/authorize?client_id={clientId}",
      exchange: { url: "https://example.com/token", clientId: "public-id", clientSecret: "super-secret" },
    }];
    const [redacted] = redactSettingSecrets(descriptors);
    expect(redacted?.type).toBe("oauth-callback");
    expect(redacted?.type === "oauth-callback" && redacted.exchange.clientSecret).toBe("");
    expect(redacted?.type === "oauth-callback" && redacted.exchange.clientId).toBe("public-id");
    expect(redacted?.type === "oauth-callback" && redacted.exchange.url).toBe("https://example.com/token");
  });

  test("masks exchange.clientSecret on an oauth-pin descriptor", () => {
    const descriptors: SettingDescriptor[] = [{
      type: "oauth-pin",
      key: "token",
      label: "Account",
      authUrl: "https://example.com/pin",
      exchange: { url: "https://example.com/token", clientId: "public-id", clientSecret: "super-secret", redirectUri: "urn:ietf:wg:oauth:2.0:oob" },
    }];
    const [redacted] = redactSettingSecrets(descriptors);
    expect(redacted?.type === "oauth-pin" && redacted.exchange?.clientSecret).toBe("");
  });

  test("leaves non-oauth descriptors and oauth descriptors without a clientSecret untouched", () => {
    const descriptors: SettingDescriptor[] = [
      { type: "string", key: "baseUrl", label: "URL", required: true },
      { type: "oauth-callback", key: "token", label: "Account", authUrlTemplate: "https://x", exchange: { url: "https://x/token", clientIdKey: "clientId" } },
    ];
    expect(redactSettingSecrets(descriptors)).toEqual(descriptors);
  });
});

describe("loader settings wiring", () => {
  test("declared defaults are applied and visible to the running bridge", async () => {
    const b = loadBridge({ code: SETTINGS_BRIDGE, capabilities: mockHost({ baseUrl: "https://x" }) });
    const details = await b.getSeriesDetails("m1");
    expect(details.title).toBe("40:number"); // default applied, typed as number
  });

  test("a bridge missing a required setting still loads (discovery must work)", () => {
    expect(() => loadBridge({ code: SETTINGS_BRIDGE, capabilities: mockHost({}) })).not.toThrow();
  });

  test("an invalid present setting value throws BridgeSettingsError at load", () => {
    expect(() =>
      loadBridge({ code: SETTINGS_BRIDGE, capabilities: mockHost({ baseUrl: "https://x", perPage: "notnum" }) }),
    ).toThrow(BridgeSettingsError);
  });
});
