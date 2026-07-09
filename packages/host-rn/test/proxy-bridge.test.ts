import { describe, expect, test } from "bun:test";

import type { BridgeInfo } from "@comical/contract";

import { buildProxyBridge } from "../src/proxy-bridge.ts";
import type { NativeBridgeRuntime } from "../src/types.ts";

const INFO = {
  id: "t",
  name: "T",
  version: "1.0.0",
  contractVersion: "1.0.0",
  languages: ["en"],
  nsfw: false,
  capabilities: ["favorites"],
} as unknown as BridgeInfo;

/** Native runtime whose `callBridge` always returns `raw` — lets us exercise the marshaller's
 *  handling of a method result verbatim, including the string forms a void return takes. */
function nativeReturning(raw: string): NativeBridgeRuntime {
  return {
    initBridge: async () => JSON.stringify({ info: INFO, methods: [] }),
    callBridge: async () => raw,
    disposeBridge: () => {},
  };
}

function call(raw: string, method = "addFavorite"): Promise<unknown> {
  const bridge = buildProxyBridge("t", INFO, [], [method], nativeReturning(raw));
  return (bridge as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]("series-1");
}

describe("buildProxyBridge result marshalling", () => {
  // Post-fix, `comical_call` serializes a void return as the valid JSON "null" (see host-native
  // runtime.ts), which round-trips below. The bare string "undefined" is only defensively tolerated
  // for an older native harness that mis-serialized void — without it the marshaller fed "undefined"
  // to JSON.parse and threw `Unexpected character 'u'`, surfacing as a favorite toggle that reverted
  // on-device while browsing (real JSON) worked.
  test('a bare "undefined" (stale harness void) resolves to undefined, not a JSON.parse crash', async () => {
    await expect(call("undefined")).resolves.toBeUndefined();
  });

  test("an empty result resolves to undefined", async () => {
    await expect(call("")).resolves.toBeUndefined();
  });

  // A real null return (e.g. getLibrary's "no library store") MUST survive as null — not be coerced
  // to undefined — or the app's `data === null` checks break on-device.
  test('"null" round-trips to a real null (not undefined)', async () => {
    await expect(call("null", "getLibrary")).resolves.toBeNull();
  });

  test("a real JSON result is still parsed", async () => {
    await expect(call(JSON.stringify({ ok: true }), "getState")).resolves.toEqual({ ok: true });
  });
});
