/**
 * End-to-end proof of the embedded transport, run under Bun.
 *
 * Wires the REAL `@comical/host-server` `createRouter` to the `EmbeddedBridgeProvider`, backed by a
 * fake `NativeBridgeRuntime` that runs a real bridge bundle through `@comical/core`'s `loadBridge` +
 * NodeVmEvaluator — the same node:vm stand-in for the on-device JSC/QuickJS engine that host-native's
 * own tests use. So this exercises the exact production path (path → router.fetch → proxy provider →
 * native engine → bridge method → JSON), differing only in the JS engine that runs the bundle.
 */
import { describe, expect, test } from "bun:test";
import { loadBridge, type LoadedBridge } from "@comical/core";
import { createRouter } from "@comical/host-server/router";
import { EmbeddedBridgeProvider } from "../src/provider.ts";
import { createEmbeddedTransport } from "../src/transport.ts";
import type { BundleSource, CreateRouter, InstalledBridge, NativeBridgeRuntime, SettingsStore } from "../src/types.ts";

const router = createRouter as unknown as CreateRouter;

// A minimal in-memory HostCapabilities for loadBridge (the demo bridge does no network I/O).
function makeHost(settings: Record<string, unknown>): unknown {
  const store = new Map<string, string>();
  return {
    network: { request: async () => ({ url: "x", status: 200, statusText: "OK", headers: {}, body: "{}" }) },
    storage: {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      keys: async () => [...store.keys()],
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    settings,
  };
}

const BRIDGE_INFO = {
  id: "demo",
  name: "Demo",
  version: "1.0.0",
  contractVersion: "1.0.0",
  languages: ["en"],
  nsfw: false,
  capabilities: ["lists", "search"],
};
// A real CJS bridge bundle, the shape `bun build --format=cjs` emits.
const DEMO_BUNDLE = `module.exports = { default: (host) => ({
  info: ${JSON.stringify(BRIDGE_INFO)},
  getLists: async () => [{ id: "home", name: "Home" }],
  getListItems: async (listId, page) => ({ items: [{ id: "a", title: "A" }], page, hasNextPage: false }),
  getSearchResults: async (q, page) => ({ items: [{ id: "hit", title: "Result for " + q }], page, hasNextPage: false }),
  getSeriesDetails: async (id) => ({ id, title: "Series " + id }),
  getChapters: async () => [{ id: "c1", name: "Chapter 1", number: 1 }],
  getChapterPages: async () => [{ index: 0, imageUrl: "https://cdn/p0.webp" }],
}) };`;

/** Fake native module: loadBridge under the default NodeVmEvaluator, like host-native's runtime test. */
function makeFakeNative(): NativeBridgeRuntime {
  const contexts = new Map<string, LoadedBridge>();
  return {
    async initBridge(id, code, settingsJson) {
      const settings = JSON.parse(settingsJson) as Record<string, unknown>;
      const bridge = loadBridge({ code, capabilities: makeHost(settings) as never });
      contexts.set(id, bridge);
      const bag = bridge as unknown as Record<string, unknown>;
      const methods = Object.keys(bag).filter((k) => typeof bag[k] === "function");
      return JSON.stringify({ info: bridge.info, methods });
    },
    async callBridge(id, method, argsJson) {
      const bridge = contexts.get(id);
      if (!bridge) throw new Error(`bridge not initialised: ${id}`);
      const args = JSON.parse(argsJson) as unknown[];
      const fn = (bridge as unknown as Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined>)[method];
      if (!fn) throw new Error(`method not implemented: ${method}`);
      return JSON.stringify(await fn(...args));
    },
    disposeBridge(id) {
      contexts.delete(id);
    },
  };
}

// A configurable bridge: advertises "settings" + a required baseUrl, so it starts unconfigured.
const CONFIGURABLE_INFO = { ...BRIDGE_INFO, id: "cfg", capabilities: ["search", "settings"] };
const CONFIGURABLE_BUNDLE = `module.exports = { default: (host) => ({
  info: ${JSON.stringify(CONFIGURABLE_INFO)},
  getSettings: () => [{ type: "string", key: "baseUrl", label: "Base URL", required: true }],
  getSeriesDetails: async (id) => ({ id, title: id }),
  getSearchResults: async (q, page) => ({ items: [], page, hasNextPage: false }),
}) };`;

const installed: InstalledBridge[] = [
  { info: BRIDGE_INFO as never, source: "registry" },
  { info: CONFIGURABLE_INFO as never, source: "registry" },
];
const bundles: BundleSource = {
  installed: async () => installed,
  resolveBundle: async (id) => {
    if (id === "demo") return DEMO_BUNDLE;
    if (id === "cfg") return CONFIGURABLE_BUNDLE;
    throw new Error(`bridge not found: ${id}`);
  },
};
function memorySettings(): SettingsStore {
  const map = new Map<string, Record<string, never>>();
  return { get: async (id) => map.get(id) ?? {}, set: async (id, v) => void map.set(id, v as Record<string, never>) };
}

function makeProvider(): EmbeddedBridgeProvider {
  return new EmbeddedBridgeProvider({ native: makeFakeNative(), bundles, settings: memorySettings() });
}

describe("embedded transport (real router + core, node:vm engine stand-in)", () => {
  test("GET /bridges lists the on-device bridge as configured", async () => {
    const transport = createEmbeddedTransport(makeProvider(), router);
    const res = await transport("/bridges");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { info: { id: string }; configured: boolean }[];
    expect(body[0]?.info.id).toBe("demo");
    expect(body[0]?.configured).toBe(true);
  });

  test("GET /bridges summarizes a settings-less bridge without loading it into the engine", async () => {
    // Instrument initBridge so we can prove which bridges the summary actually loads.
    const inited: string[] = [];
    const base = makeFakeNative();
    const native: NativeBridgeRuntime = {
      ...base,
      initBridge: (id, code, settingsJson, networkJson) => {
        inited.push(id);
        return base.initBridge(id, code, settingsJson, networkJson);
      },
    };
    const provider = new EmbeddedBridgeProvider({ native, bundles, settings: memorySettings() });
    const body = (await (await createEmbeddedTransport(provider, router)("/bridges")).json()) as {
      info: { id: string };
      configured: boolean;
    }[];

    // "demo" declares no "settings" capability → configured straight from the manifest, never loaded.
    expect(body.find((b) => b.info.id === "demo")?.configured).toBe(true);
    expect(inited).not.toContain("demo");
    // "cfg" advertises "settings", so it IS loaded to read its descriptors.
    expect(inited).toContain("cfg");
  });

  test("list() returns without awaiting the (networked) update check, running it in the background", async () => {
    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const provider = new EmbeddedBridgeProvider({
      native: makeFakeNative(),
      bundles,
      settings: memorySettings(),
      // A refresh that never settles until we release the gate — list() must not wait on it.
      refreshUpdates: async () => {
        refreshCalls += 1;
        await gate;
      },
    });
    const res = await createEmbeddedTransport(provider, router)("/bridges");
    expect(res.status).toBe(200); // resolved even though refreshUpdates is still pending
    expect(refreshCalls).toBe(1); // …but the check was kicked off
    releaseRefresh();
  });

  test("search runs the bundle on-device and returns contract-shaped results", async () => {
    const transport = createEmbeddedTransport(makeProvider(), router);
    const res = await transport("/bridges/demo/search?q=naruto&page=1");
    const body = (await res.json()) as { items: { title: string }[] };
    expect(body.items[0]?.title).toBe("Result for naruto");
  });

  test("series detail → chapters → chapter pages", async () => {
    const transport = createEmbeddedTransport(makeProvider(), router);
    expect(((await (await transport("/bridges/demo/series/s1")).json()) as { id: string }).id).toBe("s1");
    const chapters = (await (await transport("/bridges/demo/series/s1/chapters")).json()) as { id: string }[];
    expect(chapters[0]?.id).toBe("c1");
    const pages = (await (await transport("/bridges/demo/series/s1/chapters/c1/pages")).json()) as unknown[];
    expect(pages).toHaveLength(1);
  });

  test("unknown bridge → 404", async () => {
    const transport = createEmbeddedTransport(makeProvider(), router);
    expect((await transport("/bridges/nope/lists")).status).toBe(404);
  });

  test("descriptors flow: a required-baseUrl bridge is unconfigured until set", async () => {
    const settings = memorySettings();
    const provider = new EmbeddedBridgeProvider({ native: makeFakeNative(), bundles, settings });
    const transport = createEmbeddedTransport(provider, router);

    // GET /bridges reflects configured status derived from loaded getSettings descriptors.
    const summaries = (await (await transport("/bridges")).json()) as {
      info: { id: string };
      configured: boolean;
      missingRequired: string[];
    }[];
    const cfg = summaries.find((s) => s.info.id === "cfg");
    expect(cfg?.configured).toBe(false);
    expect(cfg?.missingRequired).toEqual(["baseUrl"]);

    // A content call is refused (400) while required settings are missing.
    expect((await transport("/bridges/cfg/search?q=x")).status).toBe(400);

    // Set baseUrl → provider invalidates + reloads → now configured, content flows.
    await settings.set("cfg", { baseUrl: "https://api.example" });
    provider.invalidate("cfg");
    expect((await transport("/bridges/cfg/search?q=x")).status).toBe(200);
  });
});
