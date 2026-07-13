/**
 * Schema tests for `bridgeInfoSchema.iconUrl` — a small square icon representing the bridge's
 * source, rendered by clients (e.g. comical-app's bridge picker) as a plain image URL. Optional
 * and additive so bridges that predate the field still validate.
 */
import { describe, expect, test } from "bun:test";
import { bridgeInfoSchema, parseBridgeId } from "../src/models.ts";

const BASE = {
  id: "example",
  name: "Example",
  version: "0.1.0",
  contractVersion: "1.0.0",
  languages: ["en"],
  nsfw: false,
  capabilities: [],
};

describe("bridgeInfoSchema iconUrl", () => {
  test("accepts an absolute URL", () => {
    const info = bridgeInfoSchema.parse({ ...BASE, iconUrl: "https://example.com/favicon.ico" });
    expect(info.iconUrl).toBe("https://example.com/favicon.ico");
  });

  test("parses when omitted (backward-compatible with existing bridges)", () => {
    const info = bridgeInfoSchema.parse({ ...BASE });
    expect(info.iconUrl).toBeUndefined();
  });

  test("rejects a non-URL string", () => {
    expect(() => bridgeInfoSchema.parse({ ...BASE, iconUrl: "not-a-url" })).toThrow();
  });
});

describe("bridgeInfoSchema id scoping", () => {
  test("accepts a bare (unscoped) id — backward compatible", () => {
    expect(bridgeInfoSchema.parse({ ...BASE, id: "example" }).id).toBe("example");
  });

  test("accepts a publisher-scoped id (scope.name)", () => {
    expect(bridgeInfoSchema.parse({ ...BASE, id: "acme.example" }).id).toBe("acme.example");
  });

  test("accepts a multi-level scope (reverse-DNS)", () => {
    expect(bridgeInfoSchema.parse({ ...BASE, id: "com.acme.example" }).id).toBe("com.acme.example");
  });

  test("rejects url-unsafe separators and path traversal", () => {
    for (const bad of ["acme/example", "..", "acme..example", ".example", "example.", "Acme.Example"]) {
      expect(() => bridgeInfoSchema.parse({ ...BASE, id: bad })).toThrow();
    }
  });

  test("parseBridgeId splits scope from name", () => {
    expect(parseBridgeId("acme.example")).toEqual({ scope: "acme", name: "example" });
    expect(parseBridgeId("com.acme.example")).toEqual({ scope: "com.acme", name: "example" });
    expect(parseBridgeId("example")).toEqual({ name: "example" });
  });
});

describe("bridgeInfoSchema assetProxy", () => {
  test("accepts declared hosts with a Referer", () => {
    const info = bridgeInfoSchema.parse({
      ...BASE,
      assetProxy: { hosts: ["cdn.example.net", "example.org"], referer: "https://example.org/" },
    });
    expect(info.assetProxy?.hosts).toEqual(["cdn.example.net", "example.org"]);
    expect(info.assetProxy?.referer).toBe("https://example.org/");
  });

  test("accepts hosts without a Referer", () => {
    const info = bridgeInfoSchema.parse({ ...BASE, assetProxy: { hosts: ["cdn.example.net"] } });
    expect(info.assetProxy?.referer).toBeUndefined();
  });

  test("parses when omitted (backward-compatible with bridges that proxy nothing)", () => {
    expect(bridgeInfoSchema.parse({ ...BASE }).assetProxy).toBeUndefined();
  });

  test("rejects an empty hosts list", () => {
    expect(() => bridgeInfoSchema.parse({ ...BASE, assetProxy: { hosts: [] } })).toThrow();
  });

  test("rejects a non-URL Referer", () => {
    expect(() =>
      bridgeInfoSchema.parse({ ...BASE, assetProxy: { hosts: ["x.example"], referer: "not-a-url" } }),
    ).toThrow();
  });
});
