/**
 * `installEmbeddedTransport` + on-device tracker search — the end-to-end regression guard for the
 * "ComicalRuntime: no trackers configured" bug. The `/trackers/:id/search` (and `/sync`) routes
 * resolve through `ComicalRuntime.searchTracker`, NOT the router's TrackerManager, so the runtime
 * install.ts builds behind the library pair must carry its OWN tracker provider. It once didn't:
 * install.ts built the runtime with only `{ bridges, library }`, so list/settings/connect worked but
 * search silently 400'd on-device. `transport-trackers.test.ts` locks the router↔runtime seam by
 * building the runtime itself; THIS test locks install.ts's wiring by driving the whole real stack
 * (manifest bundle source → fake native engine → reused router) exactly the way the app does — the
 * only layer that would actually have caught the original regression.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createRouter } from "@comical/host-server/router";
import { InMemoryLibraryStore } from "@comical/library";
import { installEmbeddedTransport, uninstallEmbeddedTransport } from "../src/install.ts";
import { setNativeBridgeRuntime, setNativeTrackerRuntime } from "../src/native-runtime.ts";
import type {
  CreateRouter,
  EmbeddedTransport,
  InstalledTrackerRecord,
  NativeBridgeRuntime,
} from "../src/types.ts";
import { makeFakeNativeTracker, SEARCH_TRACKER_BUNDLE, SEARCH_TRACKER_INFO } from "./mock-tracker.ts";

const stubNative: NativeBridgeRuntime = {
  initBridge: async () => JSON.stringify({ info: { id: "stub" } }),
  callBridge: async () => "null",
  disposeBridge: () => {},
};

const REG = "https://reg.example/index.json";
const TRACKER_RECORD: InstalledTrackerRecord = {
  id: "anilist",
  registryUrl: REG,
  version: "1.0.0",
  contractVersion: "2.0.0",
  info: SEARCH_TRACKER_INFO,
  url: "https://reg.example/trackers/anilist.js",
  sha256: "a".repeat(64),
};

/** In-memory stores mirroring what the app implements over AsyncStorage. `installedTrackers` surfaces
 *  one search-capable tracker; `fetcher.downloadBundle` serves its real bundle body (the injected
 *  fake ignores the verification opts, exactly like `manifest-install.test.ts`'s doubles). */
const memStores = (trackerToken?: string) => {
  const trackerSettings = new Map<string, Record<string, string>>();
  if (trackerToken !== undefined) trackerSettings.set("anilist", { token: trackerToken });
  return {
    installed: { all: async () => [], get: async () => null, add: async () => {}, remove: async () => {} },
    installedTrackers: {
      all: async () => [TRACKER_RECORD],
      get: async (id: string) => (id === "anilist" ? TRACKER_RECORD : null),
      add: async () => {},
      remove: async () => {},
    },
    registries: { all: async () => [], get: async () => null, add: async () => {}, remove: async () => {} },
    settings: { get: async () => ({}), set: async () => {} },
    trackerSettings: {
      get: async (id: string) => trackerSettings.get(id) ?? {},
      set: async (id: string, v: Record<string, string>) => void trackerSettings.set(id, v),
    },
    fetcher: {
      fetchIndex: async () => {
        throw new Error("no registry index in this test");
      },
      downloadBundle: async () => ({ text: SEARCH_TRACKER_BUNDLE }),
    },
  };
};

afterEach(() => {
  uninstallEmbeddedTransport();
  setNativeBridgeRuntime(null);
  setNativeTrackerRuntime(null);
});

/** Install the embedded transport the way the app does on native: both native runtimes registered,
 *  a library store (so `ComicalRuntime` — the thing that carries trackers — gets built), and a
 *  tracker settings store (so `/trackers*` mounts). */
function install(trackerToken?: string): EmbeddedTransport {
  setNativeBridgeRuntime(stubNative);
  setNativeTrackerRuntime(makeFakeNativeTracker());
  let transport: EmbeddedTransport | null = null;
  const ok = installEmbeddedTransport({
    createRouter: createRouter as unknown as CreateRouter,
    ...memStores(trackerToken),
    libraryStore: new InMemoryLibraryStore(),
    setTransport: (t) => {
      transport = t;
    },
  });
  expect(ok).toBe(true);
  return transport!;
}

describe("installEmbeddedTransport — on-device tracker search", () => {
  test("resolves /trackers/:id/search through the runtime install.ts wires (regression guard)", async () => {
    const transport = install("t1");

    const res = await transport("/trackers/anilist/search?q=blame");
    // Pre-fix, the runtime was built without `trackers`, so this 400'd "no trackers configured".
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { externalId: number; title: string }[] };
    expect(body.items[0]?.title).toBe("match: blame");
    expect(body.items[0]?.externalId).toBe(42);
  });

  test("lists the installed tracker as configured once its token is stored", async () => {
    const transport = install("t1");

    const res = await transport("/trackers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { info: { id: string }; configured: boolean }[];
    const anilist = body.find((t) => t.info.id === "anilist");
    expect(anilist?.configured).toBe(true);
  });

  test("search still resolves before the tracker is configured (search takes no auth here)", async () => {
    // The runtime must reach the tracker for search regardless of stored settings — the bug wasn't
    // about configuration, it was the missing tracker provider on the runtime.
    const transport = install(); // no token stored

    const res = await transport("/trackers/anilist/search?q=solo");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { title: string }[] };
    expect(body.items[0]?.title).toBe("match: solo");
  });

  test("leaves /trackers* unmounted (404) when no native tracker runtime is registered", async () => {
    // Bridge-only native build: install proceeds, but with no tracker engine the provider is absent
    // and the tracker routes never mount — the same absent-capability shape as downloads/library.
    setNativeBridgeRuntime(stubNative); // NB: setNativeTrackerRuntime intentionally NOT called
    let transport: EmbeddedTransport | null = null;
    installEmbeddedTransport({
      createRouter: createRouter as unknown as CreateRouter,
      ...memStores("t1"),
      libraryStore: new InMemoryLibraryStore(),
      setTransport: (t) => {
        transport = t;
      },
    });
    const res = await transport!("/trackers/anilist/search?q=blame");
    expect(res.status).toBe(404);
  });
});
