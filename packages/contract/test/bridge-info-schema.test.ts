/**
 * Schema tests for `bridgeInfoSchema.iconUrl` — a small square icon representing the bridge's
 * source, rendered by clients (e.g. comical-app's bridge picker) as a plain image URL. Optional
 * and additive so bridges that predate the field still validate.
 */
import { describe, expect, test } from "bun:test";
import { bridgeInfoSchema } from "../src/models.ts";

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
