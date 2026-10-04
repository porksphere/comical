/**
 * `decorateBridges` is the seam an app records settings changes through (`@comical/sync`'s
 * `wrapBridgeSettings`): what it returns is what the router reads and writes bridges through, so a
 * setting saved from a screen goes past the decorator.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createRouter } from "@comical/host-server/router";
import { installEmbeddedTransport, uninstallEmbeddedTransport } from "../src/install.ts";
import { setNativeBridgeRuntime } from "../src/native-runtime.ts";
import type { BridgeProvider, CreateRouter, EmbeddedTransport, NativeBridgeRuntime } from "../src/types.ts";

const stubNative: NativeBridgeRuntime = {
  initBridge: async () => JSON.stringify({ info: { id: "stub" } }),
  callBridge: async () => "null",
  disposeBridge: () => {},
};

const emptyStore = { all: async () => [], get: async () => null, add: async () => {}, remove: async () => {} };
const fetcher = {
  fetchIndex: async () => {
    throw new Error("offline");
  },
  downloadBundle: async () => {
    throw new Error("offline");
  },
};

afterEach(() => {
  uninstallEmbeddedTransport();
  setNativeBridgeRuntime(null);
});

function install(decorateBridges?: (bridges: BridgeProvider) => BridgeProvider): EmbeddedTransport {
  setNativeBridgeRuntime(stubNative);
  let transport: EmbeddedTransport | null = null;
  installEmbeddedTransport({
    createRouter: createRouter as unknown as CreateRouter,
    installed: emptyStore,
    installedTrackers: emptyStore,
    registries: emptyStore,
    settings: { get: async () => ({}), set: async () => {} },
    fetcher,
    ...(decorateBridges ? { decorateBridges } : {}),
    setTransport: (t) => {
      transport = t;
    },
  });
  return transport!;
}

describe("installEmbeddedTransport — decorateBridges", () => {
  test("the router's bridge calls go through the decorated provider", async () => {
    const seen: string[] = [];
    const transport = install(
      (bridges) =>
        new Proxy(bridges, {
          get(target, prop) {
            const value = Reflect.get(target, prop, target) as unknown;
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              seen.push(String(prop));
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          },
        }),
    );

    expect((await transport("/bridges")).status).toBe(200);
    expect(seen).toEqual(["list"]);

    // No such bridge: the real provider says so, past the decorator.
    const put = await transport("/bridges/missing/excluded-tags", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["a"] }),
    });
    expect(put.status).toBe(404);
    expect(seen).toEqual(["list", "get"]);
  });

  test("without a decorator the router gets the provider itself", async () => {
    expect((await install()("/bridges")).status).toBe(200);
  });
});
