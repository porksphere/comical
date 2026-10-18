/**
 * `@comical/host-rn/bridges` — the bridges-only entry: installs the embedded transport with the
 * product routes unmounted, refuses the options it can't honor, and (the point of the split) its
 * import graph never reaches `@comical/library`, `@comical/runtime`, or `@comical/downloads` at
 * runtime.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createRouter } from "@comical/host-server/router";
import { InMemoryLibraryStore } from "@comical/library";
import { installEmbeddedBridges, setNativeBridgeRuntime, uninstallEmbeddedTransport } from "../src/bridges.ts";
import { installEmbeddedTransportWith } from "../src/install-core.ts";
import type { CreateRouter, EmbeddedTransport, NativeBridgeRuntime } from "../src/types.ts";

const stubNative: NativeBridgeRuntime = {
  initBridge: async () => JSON.stringify({ info: { id: "stub" } }),
  callBridge: async () => "null",
  disposeBridge: () => {},
};

const memStores = () => ({
  installed: { all: async () => [], get: async () => null, add: async () => {}, remove: async () => {} },
  installedTrackers: { all: async () => [], get: async () => null, add: async () => {}, remove: async () => {} },
  registries: { all: async () => [], get: async () => null, add: async () => {}, remove: async () => {} },
  settings: { get: async () => ({}), set: async () => {} },
  fetcher: {
    fetchIndex: async () => {
      throw new Error("no registry in this test");
    },
    downloadBundle: async () => {
      throw new Error("no registry in this test");
    },
  },
});

afterEach(() => {
  uninstallEmbeddedTransport();
  setNativeBridgeRuntime(null);
});

describe("@comical/host-rn/bridges", () => {
  test("installs the transport with the product routes unmounted", async () => {
    setNativeBridgeRuntime(stubNative);
    let transport: EmbeddedTransport | null = null;
    const ok = installEmbeddedBridges({
      createRouter: createRouter as unknown as CreateRouter,
      ...memStores(),
      setTransport: (t) => {
        transport = t;
      },
    });
    expect(ok).toBe(true);
    expect(transport).not.toBeNull();
    expect((await transport!("/health")).status).toBe(200);
    expect((await transport!("/bridges")).status).toBe(200);
    expect((await transport!("/library/collected")).status).toBe(404);
    expect((await transport!("/downloads")).status).toBe(404);
  });

  test("stays remote when no native runtime is registered", () => {
    expect(installEmbeddedBridges({ createRouter: createRouter as unknown as CreateRouter, ...memStores(), setTransport: () => {} })).toBe(false);
  });

  test("a store that needs a module the entry didn't supply is a clear error", () => {
    setNativeBridgeRuntime(stubNative);
    expect(() =>
      installEmbeddedTransportWith(
        { createRouter: createRouter as unknown as CreateRouter, ...memStores(), setTransport: () => {}, libraryStore: new InMemoryLibraryStore() },
        {},
      ),
    ).toThrow(/libraryStore.*@comical\/library/);
  });

  test("its import graph has no runtime import of the product packages", () => {
    const SRC = resolve(import.meta.dir, "..", "src");
    const seen = new Set<string>();
    const queue = [join(SRC, "bridges.ts")];
    const offenders: string[] = [];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/^(?:import|export)\s+(type\s+)?(?:[^;'"]*?\s+from\s+)?["']([^"']+)["'];?$/gm)) {
        const [, typeOnly, spec] = m;
        if (typeOnly) continue;
        if (spec!.startsWith(".")) {
          queue.push(resolve(dirname(file), spec!));
        } else if (/^@comical\/(library|runtime|downloads)(\/|$)/.test(spec!)) {
          offenders.push(`${file.slice(SRC.length + 1)} → ${spec}`);
        }
      }
    }
    expect(seen.size).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });
});
