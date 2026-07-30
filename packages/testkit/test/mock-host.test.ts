/** Unit tests for `mockHost()`'s optional `getDefaultUserAgent` wiring. */
import { describe, expect, test } from "bun:test";
import { mockHost } from "../src/mock-host.ts";

describe("mockHost getDefaultUserAgent", () => {
  test("absent when no userAgent option is given — simulates a host with no platform UA", () => {
    const host = mockHost({ handle: async () => ({ url: "x", status: 200, statusText: "OK", headers: {}, body: "" }) });
    expect(host.getDefaultUserAgent).toBeUndefined();
  });

  test("present and returns the configured value when userAgent is given", () => {
    const host = mockHost({
      handle: async () => ({ url: "x", status: 200, statusText: "OK", headers: {}, body: "" }),
      userAgent: "TestUA/1.0",
    });
    expect(host.getDefaultUserAgent?.()).toBe("TestUA/1.0");
  });
});
