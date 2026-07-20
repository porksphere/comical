import { describe, expect, test } from "bun:test";

import type { TrackerInfo } from "@comical/contract";

import { buildProxyTracker } from "../src/tracker-proxy.ts";
import type { NativeTrackerRuntime } from "../src/types.ts";

const INFO = {
  id: "t",
  name: "T",
  version: "1.0.0",
  contractVersion: "1.0.0",
  capabilities: ["library-sync"],
} as unknown as TrackerInfo;

/** Native runtime whose `callTracker` always returns `raw` — same shape as proxy-bridge.test.ts's
 *  `nativeReturning`, exercising the marshaller's handling of a method result verbatim. */
function nativeReturning(raw: string): NativeTrackerRuntime {
  return {
    initTracker: async () => JSON.stringify({ info: INFO, methods: [] }),
    callTracker: async () => raw,
    disposeTracker: () => {},
    drainTrackerSettingsPatch: async () => null,
  };
}

function call(raw: string, method = "getLibrary"): Promise<unknown> {
  const tracker = buildProxyTracker("t", INFO, [], [method], nativeReturning(raw));
  return (tracker as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!(1);
}

describe("buildProxyTracker result marshalling", () => {
  test('a bare "undefined" (stale harness void) resolves to undefined, not a JSON.parse crash', async () => {
    await expect(call("undefined", "updateEntry")).resolves.toBeUndefined();
  });

  test("an empty result resolves to undefined", async () => {
    await expect(call("")).resolves.toBeUndefined();
  });

  test('"null" round-trips to a real null (not undefined)', async () => {
    await expect(call("null")).resolves.toBeNull();
  });

  test("a real JSON result is still parsed", async () => {
    await expect(call(JSON.stringify({ items: [], page: 1, hasNextPage: false }))).resolves.toEqual({
      items: [],
      page: 1,
      hasNextPage: false,
    });
  });
});

describe("buildProxyTracker structure", () => {
  test("info and getSettings are served synchronously, never marshalled", () => {
    const settings = [{ type: "string", key: "baseUrl", label: "URL" } as const];
    const tracker = buildProxyTracker("t", INFO, settings as never, ["getSettings", "getLibrary"], nativeReturning("null"));
    expect(tracker.info).toBe(INFO);
    expect(tracker.getSettings?.()).toBe(settings as never);
  });

  test("only the passed methods are attached", () => {
    const tracker = buildProxyTracker("t", INFO, [], ["getLibrary"], nativeReturning("null"));
    expect(typeof (tracker as unknown as Record<string, unknown>).getLibrary).toBe("function");
    expect((tracker as unknown as Record<string, unknown>).updateEntry).toBeUndefined();
    expect((tracker as unknown as Record<string, unknown>).search).toBeUndefined();
  });
});

describe("buildProxyTracker afterCall hook", () => {
  test("runs after a successful call", async () => {
    let calls = 0;
    const tracker = buildProxyTracker("t", INFO, [], ["getLibrary"], nativeReturning("null"), {
      afterCall: () => { calls++; },
    });
    await (tracker as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>).getLibrary!(1);
    expect(calls).toBe(1);
  });

  test("still runs when the native call throws (a refresh may have happened before the failure)", async () => {
    let calls = 0;
    const native: NativeTrackerRuntime = {
      initTracker: async () => JSON.stringify({ info: INFO, methods: [] }),
      callTracker: async () => { throw new Error("boom"); },
      disposeTracker: () => {},
      drainTrackerSettingsPatch: async () => null,
    };
    const tracker = buildProxyTracker("t", INFO, [], ["getLibrary"], native, { afterCall: () => { calls++; } });
    await expect(
      (tracker as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>).getLibrary!(1),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });
});
