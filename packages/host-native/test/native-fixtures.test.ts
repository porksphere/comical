/**
 * The Swift (XCTest) and Kotlin (instrumented) native-host tests each embed tiny inline bridge and
 * tracker bundles and call them through the harness. Those tests only run on a macOS runner or an
 * emulator (`.github/workflows/native.yml`), so when the contract moved to cursor paging the
 * fixtures drifted for months without anything noticing — until the first real run failed 5 of 17.
 *
 * This test lifts the SAME fixture strings out of the Swift/Kotlin sources and drives them through
 * `installComicalHarness` under Bun, making the exact calls the native tests make. It runs in the
 * per-push CI, so a contract change that invalidates a native fixture fails here, on every push,
 * instead of on the next weekly native run.
 *
 * It checks the fixtures and the call shapes, not Swift/Kotlin marshalling — that stays on-device.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NodeVmEvaluator } from "@comical/core";
import { makeAsyncHost } from "../src/adapter-async.ts";
import { makeCallbackHost } from "../src/adapter-callback.ts";
import { installComicalHarness } from "../src/runtime.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;

const NATIVE_GLOBALS = [
  "__comical_native_eval",
  "_native_log",
  "_native_network_request",
  "_native_storage_get",
  "_native_storage_set",
  "_native_storage_delete",
  "_native_storage_keys",
  "_native_storage_secure_get",
  "_native_storage_secure_set",
  "_native_storage_secure_delete",
  "_native_storage_secure_keys",
  "_native_get_default_user_agent",
  "comical_init",
  "comical_call",
  "comical_bridge",
  "comical_init_tracker",
  "comical_call_tracker",
  "comical_drain_tracker_patch",
  "comical_tracker",
];

afterEach(() => {
  for (const k of NATIVE_GLOBALS) delete g[k];
});

const PACKAGES = join(import.meta.dir, "..", "..");
const SWIFT_TESTS = join(PACKAGES, "host-ios", "Tests", "ComicalHostIOSTests");
const KOTLIN_TESTS = join(PACKAGES, "host-android", "src", "androidTest", "kotlin", "dev", "comical", "host");

/** `<name> = """` … `"""` — the same triple-quoted literal syntax in Swift and Kotlin. */
function fixture(file: string, name: string): string {
  const src = readFileSync(file, "utf8");
  const m = new RegExp(`${name}\\s*=\\s*"""\\n([\\s\\S]*?)\\n\\s*"""`).exec(src);
  if (!m) throw new Error(`no triple-quoted fixture named ${name} in ${file}`);
  return m[1]!;
}

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };
function installNativeEval(): void {
  const ev = new NodeVmEvaluator();
  g.__comical_native_eval = (code: string) => ev.evaluate(code, noopLog).exports;
}

/** iOS-style: callback (err, result) natives — what the Swift contexts inject. */
function installCallbackNatives(): void {
  const store = new Map<string, string>();
  const secureStore = new Map<string, string>();
  type Cb = (err: unknown, result?: string) => void;
  g._native_log = () => {};
  g._native_network_request = (_req: string, cb: Cb) =>
    cb(null, JSON.stringify({ url: "x", status: 200, statusText: "OK", headers: {}, body: "" }));
  g._native_storage_get = (k: string, cb: Cb) => cb(null, store.get(k));
  g._native_storage_set = (k: string, v: string, cb: Cb) => { store.set(k, v); cb(null); };
  g._native_storage_delete = (k: string, cb: Cb) => { store.delete(k); cb(null); };
  g._native_storage_keys = (cb: Cb) => cb(null, JSON.stringify([...store.keys()]));
  g._native_storage_secure_get = (k: string, cb: Cb) => cb(null, secureStore.get(k));
  g._native_storage_secure_set = (k: string, v: string, cb: Cb) => { secureStore.set(k, v); cb(null); };
  g._native_storage_secure_delete = (k: string, cb: Cb) => { secureStore.delete(k); cb(null); };
  g._native_storage_secure_keys = (cb: Cb) => cb(null, JSON.stringify([...secureStore.keys()]));
}

/** Android-style: promise-returning natives — what the Kotlin contexts inject. */
function installAsyncNatives(): void {
  const store = new Map<string, string>();
  const secureStore = new Map<string, string>();
  g._native_log = () => {};
  g._native_network_request = () =>
    Promise.resolve(JSON.stringify({ url: "x", status: 200, statusText: "OK", headers: {}, body: "" }));
  g._native_storage_get = (k: string) => Promise.resolve(store.get(k) ?? null);
  g._native_storage_set = (k: string, v: string) => { store.set(k, v); return Promise.resolve(null); };
  g._native_storage_delete = (k: string) => { store.delete(k); return Promise.resolve(null); };
  g._native_storage_keys = () => Promise.resolve(JSON.stringify([...store.keys()]));
  g._native_storage_secure_get = (k: string) => Promise.resolve(secureStore.get(k) ?? null);
  g._native_storage_secure_set = (k: string, v: string) => { secureStore.set(k, v); return Promise.resolve(null); };
  g._native_storage_secure_delete = (k: string) => { secureStore.delete(k); return Promise.resolve(null); };
  g._native_storage_secure_keys = () => Promise.resolve(JSON.stringify([...secureStore.keys()]));
}

const call = async (method: string, args: unknown[]) => JSON.parse(await g.comical_call(method, JSON.stringify(args)));
const callTracker = async (method: string, args: unknown[]) =>
  JSON.parse(await g.comical_call_tracker(method, JSON.stringify(args)));

const PLATFORMS = [
  {
    name: "iOS (Swift XCTest fixtures, callback natives)",
    bridgeFile: join(SWIFT_TESTS, "ComicalBridgeContextTests.swift"),
    bridgeFixture: "MINIMAL_BUNDLE",
    trackerFile: join(SWIFT_TESTS, "ComicalTrackerContextTests.swift"),
    trackerFixture: "MINIMAL_TRACKER_BUNDLE",
    install: () => {
      installNativeEval();
      installCallbackNatives();
      installComicalHarness(makeCallbackHost);
    },
  },
  {
    name: "Android (Kotlin instrumented fixtures, async natives)",
    bridgeFile: join(KOTLIN_TESTS, "ComicalBridgeContextInstrumentedTest.kt"),
    bridgeFixture: "GOOD_BUNDLE",
    trackerFile: join(KOTLIN_TESTS, "ComicalTrackerContextInstrumentedTest.kt"),
    trackerFixture: "GOOD_TRACKER_BUNDLE",
    install: () => {
      installNativeEval();
      installAsyncNatives();
      installComicalHarness(makeAsyncHost);
    },
  },
];

for (const p of PLATFORMS) {
  describe(p.name, () => {
    test("the bridge fixture loads and answers the calls the native test makes", async () => {
      p.install();
      const info = JSON.parse(await g.comical_init(fixture(p.bridgeFile, p.bridgeFixture), JSON.stringify({ baseUrl: "https://test.example" })));
      expect(info.contractVersion).toBe("2.0.0");
      expect(info.capabilities).toContain("search");

      const details = await call("getSeriesDetails", ["alice"]);
      expect(details).toMatchObject({ id: "alice", title: "Title alice" });

      // The native tests send a SearchRequest object and read `items` (cursor paging: no `page`).
      const search = await call("getSearchResults", [{ text: "naruto" }]);
      expect(search.items[0].title).toBe("naruto");
      expect(search.nextCursor).toBeUndefined();

      // And the shape they used to send is rejected at the boundary, before the bridge runs.
      await expect(call("getSearchResults", ["naruto", 1])).rejects.toThrow(/rejected before calling the bridge/);
    });

    test("the tracker fixture loads and answers the calls the native test makes", async () => {
      p.install();
      const info = JSON.parse(g.comical_init_tracker(fixture(p.trackerFile, p.trackerFixture), JSON.stringify({ token: "t1" })));
      expect(info.contractVersion).toBe("2.0.0");

      const library = await callTracker("getLibrary", []);
      expect(library.items[0].title).toBe("Series t1");
      expect(library.nextCursor).toBeUndefined();

      const search = await callTracker("search", ["naruto"]);
      expect(search.items[0].title).toBe("naruto");

      // Void → the JSON text "null" (what the Swift test decodes to NSNull).
      expect(await g.comical_call_tracker("updateEntry", JSON.stringify(["1", { status: "completed" }]))).toBe("null");

      await expect(callTracker("getLibrary", [1])).rejects.toThrow(/paged request/);
    });
  });
}
