/**
 * The embedded transport's page-favorites surface: with an on-device library the reused
 * `@comical/host-server` router mounts `/library/favorite-pages*` and resolves it in-process, and
 * with the optional `favoritePages` device seams it also captures and serves page thumbnails.
 *
 * That capture is not a nicety on-device: the bridge-side per-page thumbnail endpoint is
 * series-level with no chapter component, so without it a favorites grid is blank for every
 * chaptered series. These lock that the config reaches the router, and that omitting it degrades to
 * "no thumbnail" rather than breaking favorites.
 */
import { describe, expect, test } from "bun:test";
import { createRouter } from "@comical/host-server/router";
import { InMemoryLibraryStore, Library } from "@comical/library";
import { ComicalRuntime } from "@comical/runtime";
import { createEmbeddedTransport } from "../src/transport.ts";
import type { BlobStore, BridgeProvider, CreateRouter, EmbeddedFavoritePagesConfig, PageFetcher } from "../src/types.ts";

// Favorites never touch a bridge — a stub that throws proves they resolve purely from the store.
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
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);

/** A device-shaped blob store (an expo-file-system one in the app) — crucially WITH `read`. */
function deviceBlobs() {
  const files = new Map<string, Uint8Array>();
  const store: BlobStore = {
    async write(path, data) {
      files.set(path, data);
      return { bytes: data.byteLength };
    },
    async read(path) {
      return files.get(path);
    },
    async remove(paths) {
      for (const p of paths) files.delete(p);
    },
    async removeAll() {
      files.clear();
    },
    async usage() {
      return [...files.values()].reduce((n, d) => n + d.byteLength, 0);
    },
  };
  return { store, files };
}

function makeTransport(favoritePages?: EmbeddedFavoritePagesConfig) {
  const library = new Library(new InMemoryLibraryStore());
  const runtime = new ComicalRuntime({ bridges: stubProvider, library });
  return createEmbeddedTransport(
    stubProvider,
    makeCreate(),
    undefined,
    { library, runtime },
    undefined,
    undefined,
    undefined,
    favoritePages,
  );
}

const put = (t: ReturnType<typeof makeTransport>, path: string, body: unknown) =>
  t(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("embedded transport — page favorites", () => {
  test("mounts /library/favorite-pages* when a library is supplied", async () => {
    const t = makeTransport();

    const empty = await t("/library/favorite-pages");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    const collections = await t("/library/favorite-pages/collections");
    expect(collections.status).toBe(200);
    expect(await collections.json()).toEqual([]);
  });

  test("leaves /library/favorite-pages* unmounted (404) when no library is supplied", async () => {
    const t = createEmbeddedTransport(stubProvider, makeCreate());
    expect((await t("/library/favorite-pages")).status).toBe(404);
    expect((await t("/library/favorite-pages/collections")).status).toBe(404);
  });

  test("favoriting round-trips in-process, and the chapter route serves the reader's indices", async () => {
    const t = makeTransport();
    expect((await put(t, "/library/favorite-pages/demo/s1/c1/3", { seriesTitle: "Series One" })).status).toBe(200);
    expect((await put(t, "/library/favorite-pages/demo/s1/c1/1", { seriesTitle: "Series One" })).status).toBe(200);

    const indices = await t("/library/favorite-pages/chapter/demo/s1/c1");
    expect(indices.status).toBe(200);
    expect(await indices.json()).toEqual([1, 3]);

    const list = (await (await t("/library/favorite-pages")).json()) as { id: string }[];
    expect(list).toHaveLength(2);
  });

  test("the favoritePages seams reach the router: capture on favorite, serve at /thumb", async () => {
    const blobs = deviceBlobs();
    const seen: string[] = [];
    const fetchPage: PageFetcher = async (_ctx, page) => {
      seen.push(page.sourceUrl);
      return { data: PNG, contentType: "image/png" };
    };
    const t = makeTransport({ blobs: blobs.store, fetchPage });

    const res = await put(t, "/library/favorite-pages/demo/s1/c1/0", {
      seriesTitle: "Series One",
      sourceUrl: "https://cdn.example/0.png",
    });
    const page = (await res.json()) as { id: string; hasThumb?: boolean };
    expect(page.hasThumb).toBe(true);
    expect(seen).toEqual(["https://cdn.example/0.png"]);

    const thumb = await t(`/library/favorite-pages/${encodeURIComponent(page.id)}/thumb`);
    expect(thumb.status).toBe(200);
    // The buffering transport must hand back the raw bytes, not a lossy text decode.
    expect(new Uint8Array(await thumb.arrayBuffer())).toEqual(PNG);

    // Unfavoriting unlinks the device blob rather than orphaning it in app storage.
    await t("/library/favorite-pages/demo/s1/c1/0", { method: "DELETE" });
    expect(blobs.files.size).toBe(0);
  });

  test("without the favoritePages seams, favorites still work and carry no thumbnail", async () => {
    const t = makeTransport();
    const res = await put(t, "/library/favorite-pages/demo/s1/c1/0", {
      seriesTitle: "Series One",
      sourceUrl: "https://cdn.example/0.png",
    });
    expect(res.status).toBe(200);
    const page = (await res.json()) as { id: string; hasThumb?: boolean };
    expect(page.hasThumb).toBeUndefined();
    expect((await t(`/library/favorite-pages/${encodeURIComponent(page.id)}/thumb`)).status).toBe(404);
  });
});
