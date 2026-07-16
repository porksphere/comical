/**
 * The embedded transport's optional on-device downloads: when `createEmbeddedTransport` is given a
 * `Downloads` service (built by `installEmbeddedTransport` from an injected `DownloadsStore`), the
 * reused `@comical/host-server` router mounts the `/downloads*` endpoints and resolves them in-process
 * against that store — so the app's offline-download manifest works on-device with no server. Without
 * it, those endpoints are unmounted (404).
 */
import { describe, expect, test } from "bun:test";
import { createRouter } from "@comical/host-server/router";
import { DownloadEngine, Downloads, InMemoryDownloadsStore, type BlobStore } from "@comical/downloads";
import { createEmbeddedTransport } from "../src/transport.ts";
import type { BridgeProvider, CreateRouter } from "../src/types.ts";

// The `/downloads*` routes never touch a bridge (the manifest is client-supplied), so a stub provider
// that throws is enough — it proves the endpoints resolve purely from the injected store.
const stubProvider = {
  list: async () => [],
  get: async () => {
    throw new Error("bridge not found");
  },
  missingRequired: async () => [],
  storedSettings: async () => ({}),
  updateSettings: async () => ({}),
  invalidate: () => {},
  refresh: () => {},
} as unknown as BridgeProvider;

const makeCreate = () => createRouter as unknown as CreateRouter;

describe("embedded transport — on-device downloads", () => {
  test("mounts /downloads* when a Downloads service is supplied", async () => {
    const downloads = new Downloads(new InMemoryDownloadsStore());
    const t = createEmbeddedTransport(stubProvider, makeCreate(), undefined, undefined, downloads);

    // Empty to start.
    const empty = await t("/downloads");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ totalBytes: 0, seriesCount: 0 });

    // Enqueue a one-page chapter and record its bytes.
    const enq = await t("/downloads/entries/b1/s1/chapters/c1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "On-Device Series", pages: [{ index: 0, sourceUrl: "/img/0" }] }),
    });
    expect(enq.status).toBe(201);

    const rec = await t("/downloads/entries/b1/s1/chapters/c1/pages/0", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "b1/s1/c1/0.jpg", bytes: 4242 }),
    });
    expect(((await rec.json()) as { state: string }).state).toBe("complete");

    // Storage tree reflects it.
    const usage = (await (await t("/downloads")).json()) as { totalBytes: number; seriesCount: number };
    expect(usage).toMatchObject({ totalBytes: 4242, seriesCount: 1 });

    // Offline manifest page list carries the local file.
    const manifest = (await (await t("/downloads/entries/b1/s1/chapters/c1/pages")).json()) as Array<{ file: string }>;
    expect(manifest[0]?.file).toBe("b1/s1/c1/0.jpg");
  });

  test("leaves /downloads* unmounted (404) when no Downloads service is supplied", async () => {
    const t = createEmbeddedTransport(stubProvider, makeCreate());
    expect((await t("/downloads")).status).toBe(404);
  });

  test("with a DownloadEngine, the router goes host-managed: enqueue drains in-process to the injected blob store", async () => {
    const downloads = new Downloads(new InMemoryDownloadsStore());
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
    const engine = new DownloadEngine({
      downloads,
      blobs: blobStore,
      fetchPage: async () => ({ data: new Uint8Array(7), contentType: "image/png" }),
    });
    const t = createEmbeddedTransport(stubProvider, makeCreate(), undefined, undefined, downloads, engine);

    // Enqueue with an explicit page list (the stub provider has no bridges to resolve pages from);
    // the ENGINE fetches the bytes — no recordPage round-trip from the client.
    const enq = await t("/downloads/entries/b1/s1/chapters/c1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Engine Series", pages: [{ index: 0, sourceUrl: "/img/0" }] }),
    });
    expect(enq.status).toBe(201);
    await engine.drain(); // join the enqueue-kicked drain

    expect(blobs.get("b1/s1/c1/0.png")?.byteLength).toBe(7);
    const usage = (await (await t("/downloads")).json()) as { totalBytes: number };
    expect(usage.totalBytes).toBe(7);

    // Deletion unlinks host-side and reports no client work.
    const del = (await (await t("/downloads/entries/b1/s1/chapters/c1", { method: "DELETE" })).json()) as { files: string[] };
    expect(del.files).toEqual([]);
    expect(blobs.size).toBe(0);
  });
});
