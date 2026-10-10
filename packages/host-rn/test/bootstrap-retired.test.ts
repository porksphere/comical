/**
 * The app configures the embedded runtime through `configureEmbeddedRuntime`, never through
 * `installEmbeddedTransport` directly, so a store it hands over there has to reach the runtime: a
 * retired store dropped on the way means every uninstalled bridge is known by its id alone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createRouter } from "@comical/host-server/router";
import { InMemoryLibraryStore } from "@comical/library";
import type { RetiredBridge } from "@comical/registry/schema";
import { applyEmbeddedMode, configureEmbeddedRuntime, type EmbeddedBootstrapConfig } from "../src/bootstrap.ts";
import { uninstallEmbeddedTransport } from "../src/install.ts";
import { setNativeBridgeRuntime } from "../src/native-runtime.ts";
import type { CreateRouter, EmbeddedTransport, NativeBridgeRuntime } from "../src/types.ts";

const stubNative: NativeBridgeRuntime = {
  initBridge: async () => JSON.stringify({ info: { id: "stub" } }),
  callBridge: async () => "null",
  disposeBridge: () => {},
};

const emptyStore = { all: async () => [], get: async () => null, add: async () => {}, remove: async () => {} };

const gone: RetiredBridge = {
  id: "gone",
  registryUrl: "https://reg.example/index.json",
  info: { name: "Gone Direct", nsfw: true, capabilities: ["direct"] },
  uninstalledAt: "2026-10-01T00:00:00.000Z",
};

afterEach(() => {
  uninstallEmbeddedTransport();
  setNativeBridgeRuntime(null);
});

async function missingBridges(extra: Partial<EmbeddedBootstrapConfig>): Promise<unknown> {
  setNativeBridgeRuntime(stubNative);
  const libraryStore = new InMemoryLibraryStore();
  await libraryStore.putActivity({ bridgeId: "gone", seriesId: "s1", chapterId: "c1", title: "One", detectedAt: 1 });
  let transport: EmbeddedTransport | null = null;
  configureEmbeddedRuntime({
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
    libraryStore,
    setTransport: (t) => {
      transport = t;
    },
    ...extra,
  });
  expect(applyEmbeddedMode(true)).toBe(true);
  const res = await transport!("/library/missing-bridges");
  expect(res.status).toBe(200);
  return res.json();
}

describe("configureEmbeddedRuntime — retired", () => {
  test("an uninstalled bridge is described from the retired store it was given", async () => {
    const retired = { all: async () => [gone], add: async () => {}, remove: async () => {} };
    expect(await missingBridges({ retired })).toEqual([
      { id: "gone", name: "Gone Direct", nsfw: true, capabilities: ["direct"], registryUrl: gone.registryUrl },
    ]);
  });

  test("without one, the bridge is known by its id alone", async () => {
    expect(await missingBridges({})).toEqual([{ id: "gone" }]);
  });
});
