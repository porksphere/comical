/**
 * `installEmbeddedTransport` + the embedded download engine: when the app supplies `downloadsStore`
 * AND `downloadsEngine` seams, install builds a `DownloadEngine` behind the router and exposes it via
 * `getEmbeddedDownloadEngine()`; uninstall stops and clears it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createRouter } from "@comical/host-server/router";
import { InMemoryDownloadsStore, type BlobStore } from "@comical/downloads";
import { getEmbeddedDownloadEngine, installEmbeddedTransport, uninstallEmbeddedTransport } from "../src/install.ts";
import { setNativeBridgeRuntime } from "../src/native-runtime.ts";
import type { CreateRouter, EmbeddedTransport, NativeBridgeRuntime } from "../src/types.ts";

const stubNative: NativeBridgeRuntime = {
  initBridge: async () => JSON.stringify({ info: { id: "stub" } }),
  callBridge: async () => "null",
  disposeBridge: () => {},
};

const memStores = () => ({
  installed: { all: async () => [], get: async () => null, add: async () => {}, remove: async () => {} },
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

describe("installEmbeddedTransport — download engine", () => {
  test("exposes the engine while installed; uninstall clears it", async () => {
    setNativeBridgeRuntime(stubNative);
    expect(getEmbeddedDownloadEngine()).toBeNull();

    const blobs = new Map<string, Uint8Array>();
    const blobStore: BlobStore = {
      write: async (relPath, data) => {
        blobs.set(relPath, data);
        return { bytes: data.byteLength };
      },
      remove: async (relPaths) => {
        for (const p of relPaths) blobs.delete(p);
      },
    };
    let transport: EmbeddedTransport | null = null;
    const ok = installEmbeddedTransport({
      createRouter: createRouter as unknown as CreateRouter,
      ...memStores(),
      downloadsStore: new InMemoryDownloadsStore(),
      downloadsEngine: {
        blobs: blobStore,
        fetchPage: async () => ({ data: new Uint8Array(3), contentType: "image/jpeg" }),
      },
      setTransport: (t) => {
        transport = t;
      },
    });
    expect(ok).toBe(true);
    const engine = getEmbeddedDownloadEngine();
    expect(engine).not.toBeNull();

    // The transport's downloads routes are engine-managed: enqueue → in-process drain → blobs land.
    const enq = await transport!("/downloads/entries/b1/s1/chapters/c1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "S", pages: [{ index: 0, sourceUrl: "/img/0" }] }),
    });
    expect(enq.status).toBe(201);
    await engine!.drain();
    expect(blobs.get("b1/s1/c1/0.jpg")?.byteLength).toBe(3);

    uninstallEmbeddedTransport();
    expect(getEmbeddedDownloadEngine()).toBeNull();
  });

  test("no engine without the seams (manifest-only embedded mode)", () => {
    setNativeBridgeRuntime(stubNative);
    installEmbeddedTransport({
      createRouter: createRouter as unknown as CreateRouter,
      ...memStores(),
      downloadsStore: new InMemoryDownloadsStore(),
      setTransport: () => {},
    });
    expect(getEmbeddedDownloadEngine()).toBeNull();
  });
});
