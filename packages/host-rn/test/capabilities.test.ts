/**
 * Drift guard: the capability→method fallback map must cover every `BridgeCapability`. Adding a
 * capability to the contract without mapping it here fails this test rather than silently dropping
 * the new methods from a proxy built off the fallback (the drift this map once had for "read-sync").
 */
import { describe, expect, test } from "bun:test";
import { bridgeCapabilitySchema } from "@comical/contract";
import { CAPABILITY_METHODS, methodsForBridge } from "../src/capabilities.ts";

describe("CAPABILITY_METHODS", () => {
  test("covers every BridgeCapability in the contract", () => {
    const mapped = new Set(Object.keys(CAPABILITY_METHODS));
    const missing = bridgeCapabilitySchema.options.filter((cap) => !mapped.has(cap));
    expect(missing).toEqual([]);
  });

  test("read-sync exposes its mutation methods (the historically-dropped capability)", () => {
    const methods = methodsForBridge({
      id: "x",
      name: "X",
      version: "1.0.0",
      contractVersion: "1.0.0",
      languages: ["en"],
      nsfw: false,
      capabilities: ["read-sync"],
    });
    for (const m of ["markChapterRead", "markChapterUnread", "setSeriesStatus", "getReadChapters"]) {
      expect(methods).toContain(m);
    }
  });

  test('a chaptered (non-"direct") bridge gets getChapters/getChapterPages', () => {
    const methods = methodsForBridge({
      id: "x",
      name: "X",
      version: "1.0.0",
      contractVersion: "1.0.0",
      languages: ["en"],
      nsfw: false,
      capabilities: ["search"],
    });
    expect(methods).toContain("getChapters");
    expect(methods).toContain("getChapterPages");
    expect(methods).toContain("getSeriesDetails");
  });
});
