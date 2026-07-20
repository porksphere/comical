/**
 * Drift guard: the capability→method fallback map must cover every `TrackerCapability`. Adding a
 * capability to the contract without mapping it here fails this test rather than silently dropping
 * the new methods from a proxy built off the fallback (mirrors capabilities.test.ts for bridges).
 */
import { describe, expect, test } from "bun:test";
import { trackerCapabilitySchema } from "@comical/contract";
import { methodsForTracker, TRACKER_CAPABILITY_METHODS } from "../src/tracker-capabilities.ts";

describe("TRACKER_CAPABILITY_METHODS", () => {
  test("covers every TrackerCapability in the contract", () => {
    const mapped = new Set(Object.keys(TRACKER_CAPABILITY_METHODS));
    const missing = trackerCapabilitySchema.options.filter((cap) => !mapped.has(cap));
    expect(missing).toEqual([]);
  });

  test("each capability maps to its dedicated method", () => {
    const base = { id: "t", name: "T", version: "1.0.0", contractVersion: "1.0.0" };
    expect(methodsForTracker({ ...base, capabilities: ["library-sync"] })).toEqual(["getLibrary"]);
    expect(methodsForTracker({ ...base, capabilities: ["status-sync"] })).toEqual(["updateEntry"]);
    expect(methodsForTracker({ ...base, capabilities: ["search"] })).toEqual(["search"]);
    expect(methodsForTracker({ ...base, capabilities: ["settings"] })).toEqual(["getSettings"]);
  });

  test("multiple capabilities union their methods, deduped", () => {
    const methods = methodsForTracker({
      id: "t", name: "T", version: "1.0.0", contractVersion: "1.0.0",
      capabilities: ["library-sync", "status-sync", "search", "settings"],
    });
    expect(new Set(methods)).toEqual(new Set(["getLibrary", "updateEntry", "search", "getSettings"]));
  });

  test("no capabilities yields no methods", () => {
    expect(methodsForTracker({ id: "t", name: "T", version: "1.0.0", contractVersion: "1.0.0", capabilities: [] })).toEqual([]);
  });
});
