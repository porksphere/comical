/**
 * Schema tests for `trackerInfoSchema.iconUrl` — the service's icon, the tracker's counterpart of
 * `bridgeInfoSchema.iconUrl`. Optional and additive so trackers that predate the field still validate.
 */
import { describe, expect, test } from "bun:test";
import { trackerInfoSchema } from "../src/tracker.ts";

const BASE = {
  id: "example-tracker",
  name: "Example Tracker",
  version: "0.1.0",
  contractVersion: "2.0.0",
  capabilities: ["search"],
};

describe("trackerInfoSchema iconUrl", () => {
  test("accepts an absolute URL", () => {
    const info = trackerInfoSchema.parse({ ...BASE, iconUrl: "https://example.com/icon.png" });
    expect(info.iconUrl).toBe("https://example.com/icon.png");
  });

  test("accepts a data URI", () => {
    const uri = "data:image/png;base64,iVBORw0KGgo=";
    expect(trackerInfoSchema.parse({ ...BASE, iconUrl: uri }).iconUrl).toBe(uri);
  });

  test("parses when omitted (backward-compatible with existing trackers)", () => {
    expect(trackerInfoSchema.parse({ ...BASE }).iconUrl).toBeUndefined();
  });

  test("rejects a non-URL string", () => {
    expect(() => trackerInfoSchema.parse({ ...BASE, iconUrl: "not-a-url" })).toThrow();
  });
});
