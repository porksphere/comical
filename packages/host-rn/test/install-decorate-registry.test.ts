/**
 * `decorateRegistry` is the seam an app records registry changes through (`@comical/sync`'s
 * `wrapRegistryProvider`): what it returns is what the router installs through, so an add or
 * install made from a screen goes past the decorator.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createRouter } from "@comical/host-server/router";
import { installEmbeddedTransport, uninstallEmbeddedTransport } from "../src/install.ts";
import { setNativeBridgeRuntime } from "../src/native-runtime.ts";
import type { CreateRouter, EmbeddedTransport, NativeBridgeRuntime, RegistryProvider } from "../src/types.ts";

const stubNative: NativeBridgeRuntime = {
  initBridge: async () => JSON.stringify({ info: { id: "stub" } }),
  callBridge: async () => "null",
  disposeBridge: () => {},
};

const emptyStore = { all: async () => [], get: async () => null, add: async () => {}, remove: async () => {} };

afterEach(() => {
  uninstallEmbeddedTransport();
  setNativeBridgeRuntime(null);
});

describe("installEmbeddedTransport — decorateRegistry", () => {
  test("the router's registry calls go through the decorated provider", async () => {
    setNativeBridgeRuntime(stubNative);
    const seen: string[] = [];
    let transport: EmbeddedTransport | null = null;
    installEmbeddedTransport({
      createRouter: createRouter as unknown as CreateRouter,
      installed: emptyStore,
      installedTrackers: emptyStore,
      registries: emptyStore,
      settings: { get: async () => ({}), set: async () => {} },
      fetcher: {
        fetchIndex: async () => {
          throw new Error("offline");
        },
        downloadBundle: async () => {
          throw new Error("offline");
        },
      },
      decorateRegistry: (registry) =>
        new Proxy(registry, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver) as unknown;
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              seen.push(String(prop));
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          },
        }) as RegistryProvider,
      setTransport: (t) => {
        transport = t;
      },
    });

    const res = await transport!("/registries");
    expect(res.status).toBe(200);
    expect(seen).toEqual(["list"]);

    // An add with no network fails inside the real provider, past the decorator.
    const add = await transport!("/registries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://reg.example/index.json" }),
    });
    expect(add.ok).toBe(false);
    expect(seen).toEqual(["list", "add"]);
  });
});
