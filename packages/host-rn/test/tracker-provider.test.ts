/**
 * `EmbeddedTrackerProvider` — mirrors `provider.test.ts`'s style (a fake `NativeTrackerRuntime`
 * backed by real `@comical/core` `loadTracker` + the default NodeVmEvaluator, the same node:vm
 * stand-in for the on-device JSC/QuickJS engine that host-native's own tests use), but exercises
 * the provider directly rather than through the router — router-level `/trackers*` mounting is
 * covered by `transport-trackers.test.ts`. The `bundles` dep is a `TrackerBundleSource` test double
 * (see `bundleSourceOf` below) — trackers are registry-installed on-device exactly like bridges
 * (`ManifestTrackerBundleSource`'s real tests live in `registry-bundle-source.test.ts` and
 * `manifest-install.test.ts`), not a static app-bundled map.
 *
 * Also covers the drain-and-persist path unique to trackers: `NativeTrackerRuntime.
 * drainTrackerSettingsPatch` is how a refreshed OAuth token gets from the sandboxed native context
 * back to the app's `SettingsStore` (see `tracker-provider.ts`'s doc comment).
 */
import { describe, expect, test } from "bun:test";
import { loadTracker, type LoadedTracker } from "@comical/core";
import { EmbeddedTrackerProvider } from "../src/tracker-provider.ts";
import type { NativeTrackerRuntime, SettingsStore, TrackerBundleSource } from "../src/types.ts";

// A minimal in-memory HostCapabilities for loadTracker (these demo trackers do no network I/O).
function makeHost(settings: Record<string, unknown>): unknown {
  return {
    network: { request: async () => ({ url: "x", status: 200, statusText: "OK", headers: {}, body: "{}" }) },
    storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    settings,
  };
}

const TRACKER_INFO = {
  id: "anilist",
  name: "AniList",
  version: "1.0.0",
  contractVersion: "1.0.0",
  capabilities: ["library-sync", "settings"],
};
// A real CJS tracker bundle, the shape `bun build --format=cjs` emits — mirrors `provider.test.ts`'s
// DEMO_BUNDLE. `getLibrary` echoes the configured token into the title so a call proves settings
// actually reached the sandboxed context.
const TRACKER_BUNDLE = `module.exports = { default: (host) => ({
  info: ${JSON.stringify(TRACKER_INFO)},
  getSettings: () => [{ type: "string", key: "token", label: "Token", required: true }],
  getLibrary: async (page) => ({ items: [{ externalId: "1", title: "Series " + (host.settings.token ?? ""), status: "reading" }], page, hasNextPage: false }),
}) };`;

// A second tracker that starts unconfigured (required "token" not yet set).
const CFG_INFO = { ...TRACKER_INFO, id: "cfg" };
const CFG_BUNDLE = `module.exports = { default: (host) => ({
  info: ${JSON.stringify(CFG_INFO)},
  getSettings: () => [{ type: "string", key: "token", label: "Token", required: true }],
  getLibrary: async (page) => ({ items: [], page, hasNextPage: false }),
}) };`;

/** A `TrackerBundleSource` test double over a static map — trackers are registry-installed on-device
 *  (see `ManifestTrackerBundleSource`), but this file exercises the provider in isolation, so a tiny
 *  in-memory source stands in the same way `provider.test.ts`'s bundle fixtures do for bridges. */
function bundleSourceOf(map: Record<string, string>): TrackerBundleSource {
  return {
    async ids() {
      return Object.keys(map);
    },
    async resolveBundle(id) {
      const code = map[id];
      if (!code) throw new Error(`tracker not found: ${id}`);
      return code;
    },
  };
}

const bundles: TrackerBundleSource = bundleSourceOf({ anilist: TRACKER_BUNDLE, cfg: CFG_BUNDLE });

function memorySettings(): SettingsStore {
  const map = new Map<string, Record<string, never>>();
  return { get: async (id) => map.get(id) ?? {}, set: async (id, v) => void map.set(id, v as Record<string, never>) };
}

/** Fake native module: loadTracker under the default NodeVmEvaluator, like `provider.test.ts`'s
 *  `makeFakeNative` for bridges. `drainTrackerSettingsPatch` returns whatever `nextPatch()` yields
 *  (default: always null — no refresh pending), letting tests script an OAuth-refresh round-trip. */
function makeFakeNative(nextPatch: () => { key: string; blob: unknown } | null = () => null): NativeTrackerRuntime {
  const contexts = new Map<string, LoadedTracker>();
  return {
    async initTracker(id, code, settingsJson) {
      const settings = JSON.parse(settingsJson) as Record<string, unknown>;
      const tracker = loadTracker({ code, capabilities: makeHost(settings) as never });
      contexts.set(id, tracker);
      const bag = tracker as unknown as Record<string, unknown>;
      const methods = Object.keys(bag).filter((k) => typeof bag[k] === "function");
      return JSON.stringify({ info: tracker.info, methods });
    },
    async callTracker(id, method, argsJson) {
      const tracker = contexts.get(id);
      if (!tracker) throw new Error(`tracker not initialised: ${id}`);
      const args = JSON.parse(argsJson) as unknown[];
      const fn = (tracker as unknown as Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined>)[method];
      if (!fn) throw new Error(`method not implemented: ${method}`);
      // Mirror host-native `comical_call_tracker`: serialize void → valid JSON "null".
      return JSON.stringify((await fn(...args)) ?? null);
    },
    disposeTracker(id) {
      contexts.delete(id);
    },
    async drainTrackerSettingsPatch() {
      const patch = nextPatch();
      return patch ? JSON.stringify(patch) : null;
    },
  };
}

describe("EmbeddedTrackerProvider", () => {
  test("list() summarizes configured vs. unconfigured installed trackers", async () => {
    const settings = memorySettings();
    await settings.set("anilist", { token: "t1" });
    const provider = new EmbeddedTrackerProvider({ native: makeFakeNative(), bundles, settings });

    const list = await provider.list();
    const byId = Object.fromEntries(list.map((s) => [s.info.id, s]));
    expect(byId.anilist?.configured).toBe(true);
    expect(byId.anilist?.missingRequired).toEqual([]);
    expect(byId.cfg?.configured).toBe(false);
    expect(byId.cfg?.missingRequired).toEqual(["token"]);
    // Every on-device tracker is registry-installed, so it's uninstallable.
    expect(byId.anilist?.source).toBe("registry");
    expect(byId.cfg?.source).toBe("registry");
  });

  test("get() returns a proxy tracker whose methods marshal through native, seeing stored settings", async () => {
    const settings = memorySettings();
    await settings.set("anilist", { token: "t1" });
    const provider = new EmbeddedTrackerProvider({ native: makeFakeNative(), bundles, settings });

    const tracker = await provider.get("anilist");
    const result = await tracker.getLibrary!(1);
    expect(result.items[0]?.title).toBe("Series t1");
  });

  test("get() rejects an id the bundle source doesn't know about", async () => {
    const provider = new EmbeddedTrackerProvider({ native: makeFakeNative(), bundles, settings: memorySettings() });
    await expect(provider.get("nope")).rejects.toThrow(/not found/);
  });

  test("updateSettings persists the patch and invalidates the cache so the next load re-inits native", async () => {
    const settings = memorySettings();
    let initCount = 0;
    const base = makeFakeNative();
    const native: NativeTrackerRuntime = {
      ...base,
      initTracker: (...args) => {
        initCount++;
        return base.initTracker(...args);
      },
    };
    const provider = new EmbeddedTrackerProvider({ native, bundles, settings });

    await provider.get("cfg");
    expect(initCount).toBe(1);

    await provider.updateSettings("cfg", { token: "new" });
    expect(await settings.get("cfg")).toEqual({ token: "new" });

    await provider.get("cfg"); // reloads because updateSettings invalidated the cache
    expect(initCount).toBe(2);
  });

  test("invalidate() disposes the native context and drops the cache; a repeat call is a no-op", async () => {
    const settings = memorySettings();
    await settings.set("anilist", { token: "t1" });
    const disposed: string[] = [];
    const base = makeFakeNative();
    const native: NativeTrackerRuntime = {
      ...base,
      disposeTracker: (id) => {
        disposed.push(id);
        base.disposeTracker(id);
      },
    };
    const provider = new EmbeddedTrackerProvider({ native, bundles, settings });

    await provider.get("anilist");
    provider.invalidate("anilist");
    expect(disposed).toEqual(["anilist"]);

    provider.invalidate("anilist"); // never loaded since -> no dispose call
    expect(disposed).toEqual(["anilist"]);
  });

  test("refresh() disposes every loaded tracker and clears the whole cache", async () => {
    const settings = memorySettings();
    await settings.set("anilist", { token: "t1" });
    const disposed: string[] = [];
    const base = makeFakeNative();
    const native: NativeTrackerRuntime = {
      ...base,
      disposeTracker: (id) => {
        disposed.push(id);
        base.disposeTracker(id);
      },
    };
    const provider = new EmbeddedTrackerProvider({ native, bundles, settings });

    await provider.get("anilist");
    await provider.get("cfg");
    provider.refresh();
    expect(disposed.sort()).toEqual(["anilist", "cfg"]);
  });

  test("a call that refreshes an OAuth token drains + persists the new blob and reloads on next use", async () => {
    const settings = memorySettings();
    await settings.set("anilist", { token: "t1" });
    let drained = 0;
    const base = makeFakeNative(() => {
      drained++;
      return drained === 1 ? { key: "token", blob: { access: "t2", refresh: "r2" } } : null;
    });
    let initCount = 0;
    const native: NativeTrackerRuntime = {
      ...base,
      initTracker: (...args) => {
        initCount++;
        return base.initTracker(...args);
      },
    };
    const provider = new EmbeddedTrackerProvider({ native, bundles, settings });

    const tracker = await provider.get("anilist");
    expect(initCount).toBe(1);
    await tracker.getLibrary!(1); // triggers afterCall -> drainAndPersist

    expect(await settings.get("anilist")).toEqual({ token: JSON.stringify({ access: "t2", refresh: "r2" }) });

    await provider.get("anilist"); // the drain invalidated the cache -> this reloads
    expect(initCount).toBe(2);
  });

  test("a call that refreshes nothing leaves stored settings untouched (no spurious reload)", async () => {
    const settings = memorySettings();
    await settings.set("anilist", { token: "t1" });
    let initCount = 0;
    const base = makeFakeNative(() => null);
    const native: NativeTrackerRuntime = {
      ...base,
      initTracker: (...args) => {
        initCount++;
        return base.initTracker(...args);
      },
    };
    const provider = new EmbeddedTrackerProvider({ native, bundles, settings });

    const tracker = await provider.get("anilist");
    await tracker.getLibrary!(1);
    expect(await settings.get("anilist")).toEqual({ token: "t1" });
    expect(initCount).toBe(1); // never invalidated -> still cached
  });

  test("list() returns without awaiting the (networked) update check, running it in the background", async () => {
    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const provider = new EmbeddedTrackerProvider({
      native: makeFakeNative(),
      bundles,
      settings: memorySettings(),
      // A refresh that never settles until we release the gate — list() must not wait on it.
      refreshUpdates: async () => {
        refreshCalls += 1;
        await gate;
      },
    });
    const list = await provider.list();
    expect(list.length).toBeGreaterThan(0); // resolved even though refreshUpdates is still pending
    expect(refreshCalls).toBe(1); // …but the check was kicked off
    releaseRefresh();
  });
});
