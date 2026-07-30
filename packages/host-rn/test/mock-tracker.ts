/**
 * Shared mock tracker fixture for host-rn tests. A single search-capable tracker bundle plus the
 * `loadTracker`-backed fake `NativeTrackerRuntime` (the node:vm stand-in for the on-device
 * JSC/QuickJS engine) that several tests need — `tracker-provider.test.ts` exercises the provider
 * directly, `install-trackers.test.ts` drives the whole `installEmbeddedTransport` stack. Keeping
 * one fixture means the "a tracker that really runs and can search" shape is defined once.
 */
import type { TrackerInfo } from "@comical/contract";
import { loadTracker, type LoadedTracker } from "@comical/core";
import type { NativeTrackerRuntime } from "../src/types.ts";

/** A search-capable tracker — the on-device shape the AniList tracker exposes (search + settings). */
export const SEARCH_TRACKER_INFO: TrackerInfo = {
  id: "anilist",
  name: "AniList",
  version: "1.0.0",
  contractVersion: "2.0.0",
  capabilities: ["library-sync", "search", "settings"],
};

/**
 * A real CJS tracker bundle, the shape `bun build --format=cjs` emits. `search` echoes the query
 * back in the result title so a round trip proves the call reached the sandboxed context; `getLibrary`
 * echoes the configured token so settings-threading can be asserted too.
 */
export const SEARCH_TRACKER_BUNDLE = `module.exports = { default: (host) => ({
  info: ${JSON.stringify(SEARCH_TRACKER_INFO)},
  getSettings: () => [{ type: "string", key: "token", label: "Token", required: true }],
  search: async (query, page) => ({ items: [{ externalId: 42, title: "match: " + query }], page, hasNextPage: false }),
  getLibrary: async (page) => ({ items: [{ externalId: "1", title: "Series " + (host.settings.token ?? ""), status: "reading" }], page, hasNextPage: false }),
}) };`;

/** A minimal in-memory `HostCapabilities` for `loadTracker` (this demo tracker does no network I/O). */
function makeHost(settings: Record<string, unknown>): unknown {
  return {
    network: { request: async () => ({ url: "x", status: 200, statusText: "OK", headers: {}, body: "{}" }) },
    storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    settings,
  };
}

/**
 * Fake native tracker module: `loadTracker` under the default `NodeVmEvaluator`, the same node:vm
 * stand-in host-native's own tests use. `drainTrackerSettingsPatch` returns whatever `nextPatch()`
 * yields (default: always null — no refresh pending), letting a test script an OAuth-refresh round trip.
 */
export function makeFakeNativeTracker(
  nextPatch: () => { key: string; blob: unknown } | null = () => null,
): NativeTrackerRuntime {
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
