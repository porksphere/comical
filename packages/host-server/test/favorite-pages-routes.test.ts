/**
 * The `/library/favorite-pages` routes over a `FileLibraryStore` on a real temp dir, plus the
 * thumbnail-capture subsystem behind the optional `favoritePages` config.
 *
 * These are local-user-data routes for favoriting a single PAGE. They are unrelated to the
 * bridge-account per-series `favorites` capability under `/bridges/:id/favorites`, which is why they
 * live under `/library` — a fact the "namespaces stay separate" test below pins down.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BlobStore, PageFetcher } from "@comical/downloads";
import { Library } from "@comical/library";
import { ComicalRuntime } from "@comical/runtime";
import { BridgeManager } from "../src/bridge-manager.ts";
import { FileLibraryStore } from "../src/library-store.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-favorite-pages");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

/** An in-memory `BlobStore` standing in for the host's file-backed one. */
function memoryBlobStore() {
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

let baseUrl: string;
let noThumbUrl: string;
let noLibraryUrl: string;
let stop: () => void;
let blobs: ReturnType<typeof memoryBlobStore>;
/** Every `sourceUrl` the capture subsystem was asked to fetch, and a switch to make it fail. */
let fetched: string[];
let failCapture = false;

const get = (p: string) => fetch(`${baseUrl}${p}`);
const send = (method: string, p: string, body?: unknown, base = baseUrl) =>
  fetch(`${base}${p}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;

interface FavoriteBody {
  id: string;
  bridgeId: string;
  seriesId: string;
  chapterId: string;
  pageIndex: number;
  seriesTitle: string;
  chapterName?: string;
  pageCount?: number;
  favoritedAt: number;
  collectionIds: string[];
  hasThumb?: boolean;
}
interface CollectionBody {
  id: string;
  name: string;
  order: number;
}

beforeAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  const manager = new BridgeManager({
    bridgesDir: BRIDGES_DIR,
    dataDir: DATA_DIR,
    settings: new SettingsStore(DATA_DIR),
  });

  blobs = memoryBlobStore();
  fetched = [];
  const fetchPage: PageFetcher = async (_ctx, page) => {
    fetched.push(page.sourceUrl);
    if (failCapture) throw new Error("upstream exploded");
    return { data: PNG, contentType: "image/png" };
  };

  const makeLibrary = (dir: string) => {
    const library = new Library(new FileLibraryStore(join(DATA_DIR, dir)));
    return { library, runtime: new ComicalRuntime({ bridges: manager, library }) };
  };

  const main = makeLibrary("library");
  const srv = Bun.serve({
    port: 0,
    fetch: createRouter(manager, {
      library: main.library,
      runtime: main.runtime,
      favoritePages: { blobs: blobs.store, fetchPage },
    }).fetch,
  });
  baseUrl = `http://localhost:${srv.port}`;

  // A second server with a library but NO favoritePages config — capture must degrade cleanly.
  const bare = makeLibrary("library-no-thumbs");
  const noThumbSrv = Bun.serve({
    port: 0,
    fetch: createRouter(manager, { library: bare.library, runtime: bare.runtime }).fetch,
  });
  noThumbUrl = `http://localhost:${noThumbSrv.port}`;

  // ...and a third with no library at all, for the absence check.
  const noLibrarySrv = Bun.serve({ port: 0, fetch: createRouter(manager).fetch });
  noLibraryUrl = `http://localhost:${noLibrarySrv.port}`;

  stop = () => {
    srv.stop(true);
    noThumbSrv.stop(true);
    noLibrarySrv.stop(true);
  };
});

afterAll(() => {
  stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("favoriting pages", () => {
  test("PUT favorites a page, captures its thumbnail, and DELETE removes both", async () => {
    const put = await send("PUT", "/library/favorite-pages/demo/s1/c1/3", {
      seriesTitle: "Series One",
      chapterName: "Ch 1",
      pageCount: 20,
      sourceUrl: "https://cdn.example/3.png",
    });
    expect(put.status).toBe(200);
    const page = await json<FavoriteBody>(put);
    expect(page).toMatchObject({
      bridgeId: "demo",
      seriesId: "s1",
      chapterId: "c1",
      pageIndex: 3,
      seriesTitle: "Series One",
      chapterName: "Ch 1",
      pageCount: 20,
      collectionIds: [],
      hasThumb: true,
    });
    expect(fetched).toContain("https://cdn.example/3.png");

    // The captured bytes are served back at the thumb route.
    const thumb = await get(`/library/favorite-pages/${encodeURIComponent(page.id)}/thumb`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await thumb.arrayBuffer())).toEqual(PNG);

    expect((await send("DELETE", "/library/favorite-pages/demo/s1/c1/3")).status).toBe(200);
    expect(await json<FavoriteBody[]>(await get("/library/favorite-pages"))).toEqual([]);
    // The blob is unlinked with the favorite — no orphaned bytes.
    expect(blobs.files.size).toBe(0);
    expect((await get(`/library/favorite-pages/${encodeURIComponent(page.id)}/thumb`)).status).toBe(404);
  });

  test("PUT is idempotent — re-favoriting overwrites rather than duplicating", async () => {
    const first = await json<FavoriteBody>(
      await send("PUT", "/library/favorite-pages/demo/s1/c1/0", { seriesTitle: "Old", sourceUrl: "https://cdn/0.png" }),
    );
    const second = await json<FavoriteBody>(
      await send("PUT", "/library/favorite-pages/demo/s1/c1/0", { seriesTitle: "New", sourceUrl: "https://cdn/0.png" }),
    );

    expect(second.id).toBe(first.id);
    expect(second.favoritedAt).toBe(first.favoritedAt); // the original favorite date survives
    expect(second.seriesTitle).toBe("New"); // ...but the snapshot refreshes
    expect(await json<FavoriteBody[]>(await get("/library/favorite-pages"))).toHaveLength(1);

    await send("DELETE", "/library/favorite-pages/demo/s1/c1/0");
  });

  test("survives a restart — favorites round-trip through the FileLibraryStore on disk", async () => {
    await send("PUT", "/library/favorite-pages/demo/s1/c1/1", { seriesTitle: "Persisted" });
    // A fresh store over the same dir reads what the first one wrote.
    const reopened = new Library(new FileLibraryStore(join(DATA_DIR, "library")));
    const pages = await reopened.getFavoritePages();
    expect(pages.map((p) => p.seriesTitle)).toEqual(["Persisted"]);
    await send("DELETE", "/library/favorite-pages/demo/s1/c1/1");
  });

  test("rejects a missing seriesTitle and a non-integer pageIndex", async () => {
    expect((await send("PUT", "/library/favorite-pages/demo/s1/c1/0", {})).status).toBe(400);
    expect((await send("PUT", "/library/favorite-pages/demo/s1/c1/abc", { seriesTitle: "S" })).status).toBe(400);
    expect((await send("PUT", "/library/favorite-pages/demo/s1/c1/-1", { seriesTitle: "S" })).status).toBe(400);
    expect((await send("DELETE", "/library/favorite-pages/demo/s1/c1/abc")).status).toBe(400);
  });

  test("URL-encoded id segments round-trip, including the chapterless sentinel", async () => {
    const page = await json<FavoriteBody>(
      await send("PUT", `/library/favorite-pages/demo/${encodeURIComponent("s/2?x")}/__direct__/5`, {
        seriesTitle: "Direct",
      }),
    );
    expect(page).toMatchObject({ seriesId: "s/2?x", chapterId: "__direct__", pageIndex: 5 });

    const indices = await json<number[]>(
      await get(`/library/favorite-pages/chapter/demo/${encodeURIComponent("s/2?x")}/__direct__`),
    );
    expect(indices).toEqual([5]);

    await send("DELETE", `/library/favorite-pages/demo/${encodeURIComponent("s/2?x")}/__direct__/5`);
  });

  test("DELETE of a page that was never favorited is a no-op, not a 404", async () => {
    expect((await send("DELETE", "/library/favorite-pages/demo/ghost/c1/0")).status).toBe(200);
  });
});

describe("chapter indices route", () => {
  test("returns just that chapter's favorited indices, ascending", async () => {
    for (const i of [4, 1, 2]) {
      await send("PUT", `/library/favorite-pages/demo/s1/c1/${i}`, { seriesTitle: "S" });
    }
    await send("PUT", "/library/favorite-pages/demo/s1/c2/8", { seriesTitle: "S" });

    expect(await json<number[]>(await get("/library/favorite-pages/chapter/demo/s1/c1"))).toEqual([1, 2, 4]);
    expect(await json<number[]>(await get("/library/favorite-pages/chapter/demo/s1/c2"))).toEqual([8]);
    expect(await json<number[]>(await get("/library/favorite-pages/chapter/demo/s1/nope"))).toEqual([]);

    for (const i of [4, 1, 2]) await send("DELETE", `/library/favorite-pages/demo/s1/c1/${i}`);
    await send("DELETE", "/library/favorite-pages/demo/s1/c2/8");
  });

  test("'chapter' resolves as a literal segment, not as a favorite id", async () => {
    // Guards the route ordering: `chapter` and `collections` share their first segment with the
    // `:id`/coordinate patterns, so any future route that widens those must keep the literals
    // winning. This fails the moment `chapter` starts being parsed as an id.
    const res = await get("/library/favorite-pages/chapter/demo/s1/c1");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

describe("collections", () => {
  test("CRUD + reorder, and 'collections' is never parsed as a favorite id", async () => {
    const created = await send("POST", "/library/favorite-pages/collections", { name: "Panels" });
    expect(created.status).toBe(201);
    const panels = await json<CollectionBody>(created);
    const splashes = await json<CollectionBody>(
      await send("POST", "/library/favorite-pages/collections", { name: "Splashes" }),
    );

    // The literal segment wins over the `:id/thumb` and `:id/collections` patterns.
    const list = await get("/library/favorite-pages/collections");
    expect(list.status).toBe(200);
    expect((await json<CollectionBody[]>(list)).map((c) => c.name)).toEqual(["Panels", "Splashes"]);

    expect(
      (await send("PATCH", `/library/favorite-pages/collections/${panels.id}`, { name: "Best Panels" })).status,
    ).toBe(200);

    await send("POST", "/library/favorite-pages/collections/reorder", { ids: [splashes.id, panels.id] });
    expect((await json<CollectionBody[]>(await get("/library/favorite-pages/collections"))).map((c) => c.name)).toEqual([
      "Splashes",
      "Best Panels",
    ]);

    await send("DELETE", `/library/favorite-pages/collections/${panels.id}`);
    await send("DELETE", `/library/favorite-pages/collections/${splashes.id}`);
    expect(await json<CollectionBody[]>(await get("/library/favorite-pages/collections"))).toEqual([]);
  });

  test("validates bodies and 404s an unknown rename", async () => {
    expect((await send("POST", "/library/favorite-pages/collections", {})).status).toBe(400);
    expect((await send("POST", "/library/favorite-pages/collections/reorder", {})).status).toBe(400);
    expect((await send("PATCH", "/library/favorite-pages/collections/ghost", {})).status).toBe(400);
    expect((await send("PATCH", "/library/favorite-pages/collections/ghost", { name: "X" })).status).toBe(404);
  });

  test("membership: assign, filter, and cascade on collection delete", async () => {
    const panels = await json<CollectionBody>(
      await send("POST", "/library/favorite-pages/collections", { name: "Panels" }),
    );
    const p1 = await json<FavoriteBody>(
      await send("PUT", "/library/favorite-pages/demo/s1/c1/0", { seriesTitle: "Alpha" }),
    );
    const p2 = await json<FavoriteBody>(
      await send("PUT", "/library/favorite-pages/demo/s2/c1/0", { seriesTitle: "Beta" }),
    );

    const assigned = await send("PUT", `/library/favorite-pages/${encodeURIComponent(p1.id)}/collections`, {
      collectionIds: [panels.id],
    });
    expect(assigned.status).toBe(200);
    expect((await json<FavoriteBody>(assigned)).collectionIds).toEqual([panels.id]);

    const inPanels = await json<FavoriteBody[]>(await get(`/library/favorite-pages?collection=${panels.id}`));
    expect(inPanels.map((p) => p.id)).toEqual([p1.id]);
    const uncollected = await json<FavoriteBody[]>(await get("/library/favorite-pages?collection=uncollected"));
    expect(uncollected.map((p) => p.id)).toEqual([p2.id]);

    // Deleting the collection un-files its members but must NOT delete the favorites.
    await send("DELETE", `/library/favorite-pages/collections/${panels.id}`);
    expect(await json<FavoriteBody[]>(await get("/library/favorite-pages"))).toHaveLength(2);
    expect((await json<FavoriteBody[]>(await get("/library/favorite-pages?collection=uncollected"))).length).toBe(2);

    await send("DELETE", "/library/favorite-pages/demo/s1/c1/0");
    await send("DELETE", "/library/favorite-pages/demo/s2/c1/0");
  });

  test("assigning collections to an unknown favorite 404s; a missing body 400s", async () => {
    expect((await send("PUT", "/library/favorite-pages/demo%3Aghost%3Ac1%3A0/collections", {})).status).toBe(400);
    expect(
      (await send("PUT", "/library/favorite-pages/demo%3Aghost%3Ac1%3A0/collections", { collectionIds: [] })).status,
    ).toBe(404);
  });
});

describe("listing", () => {
  test("filters and sorts through the query string", async () => {
    await send("PUT", "/library/favorite-pages/demo/s1/c2/1", { seriesTitle: "Alpha Comic", chapterName: "Ch 2" });
    await send("PUT", "/library/favorite-pages/demo/s2/c9/4", { seriesTitle: "Zebra Tales", chapterName: "Ch 9" });
    await send("PUT", "/library/favorite-pages/demo/s1/c1/7", { seriesTitle: "Alpha Comic", chapterName: "Ch 1" });

    const bySeries = await json<FavoriteBody[]>(await get("/library/favorite-pages?series=demo:s1"));
    expect(bySeries.every((p) => p.seriesId === "s1")).toBe(true);
    expect(bySeries).toHaveLength(2);

    const search = await json<FavoriteBody[]>(await get("/library/favorite-pages?q=zebra"));
    expect(search.map((p) => p.seriesTitle)).toEqual(["Zebra Tales"]);

    // Reading order beats favorite date: Ch 1 was favorited last but sorts first.
    const reading = await json<FavoriteBody[]>(await get("/library/favorite-pages?sort=chapter&series=demo:s1"));
    expect(reading.map((p) => p.chapterName)).toEqual(["Ch 1", "Ch 2"]);

    // An unrecognised sort falls back to the default rather than erroring.
    expect((await get("/library/favorite-pages?sort=bogus")).status).toBe(200);

    await send("DELETE", "/library/favorite-pages/demo/s1/c2/1");
    await send("DELETE", "/library/favorite-pages/demo/s2/c9/4");
    await send("DELETE", "/library/favorite-pages/demo/s1/c1/7");
  });
});

describe("thumbnail capture is best-effort", () => {
  test("a capture failure still favorites the page, with hasThumb false", async () => {
    failCapture = true;
    try {
      const res = await send("PUT", "/library/favorite-pages/demo/s1/c5/2", {
        seriesTitle: "S",
        sourceUrl: "https://cdn.example/boom.png",
      });
      expect(res.status).toBe(200);
      const page = await json<FavoriteBody>(res);
      expect(page.hasThumb).toBeUndefined();
      expect((await get(`/library/favorite-pages/${encodeURIComponent(page.id)}/thumb`)).status).toBe(404);
    } finally {
      failCapture = false;
    }
    await send("DELETE", "/library/favorite-pages/demo/s1/c5/2");
  });

  test("no sourceUrl means no capture attempt, and the favorite still lands", async () => {
    const before = fetched.length;
    const page = await json<FavoriteBody>(
      await send("PUT", "/library/favorite-pages/demo/s1/c6/0", { seriesTitle: "S" }),
    );
    expect(page.hasThumb).toBeUndefined();
    expect(fetched.length).toBe(before);
    await send("DELETE", "/library/favorite-pages/demo/s1/c6/0");
  });

  test("with no favoritePages config the routes still work and the thumb route is absent", async () => {
    const put = await send(
      "PUT",
      "/library/favorite-pages/demo/s1/c1/0",
      { seriesTitle: "S", sourceUrl: "https://cdn.example/0.png" },
      noThumbUrl,
    );
    expect(put.status).toBe(200);
    const page = await json<FavoriteBody>(put);
    expect(page.hasThumb).toBeUndefined();
    // The thumb route only mounts when a readable blob store is configured.
    expect((await fetch(`${noThumbUrl}/library/favorite-pages/${encodeURIComponent(page.id)}/thumb`)).status).toBe(404);
    expect((await fetch(`${noThumbUrl}/library/favorite-pages`)).status).toBe(200);
  });

  test("captured thumbnail bytes count toward /library/usage", async () => {
    const empty = await json<{ diskBytes: number }>(await get("/library/usage"));
    await send("PUT", "/library/favorite-pages/demo/s1/c7/0", {
      seriesTitle: "S",
      sourceUrl: "https://cdn.example/7.png",
    });
    const withThumb = await json<{ diskBytes: number }>(await get("/library/usage"));
    expect(withThumb.diskBytes).toBeGreaterThanOrEqual(empty.diskBytes + PNG.byteLength);
    await send("DELETE", "/library/favorite-pages/demo/s1/c7/0");
  });
});

describe("absence and namespace separation", () => {
  test("every favorite-pages route 404s when no library is mounted", async () => {
    for (const [method, path] of [
      ["GET", "/library/favorite-pages"],
      ["GET", "/library/favorite-pages/chapter/demo/s1/c1"],
      ["GET", "/library/favorite-pages/collections"],
      ["POST", "/library/favorite-pages/collections"],
      ["PUT", "/library/favorite-pages/demo/s1/c1/0"],
      ["DELETE", "/library/favorite-pages/demo/s1/c1/0"],
    ] as const) {
      const res = await send(method, path, method === "GET" ? undefined : {}, noLibraryUrl);
      expect(`${method} ${path} → ${res.status}`).toBe(`${method} ${path} → 404`);
    }
  });

  test("page favorites never touch the bridge-account /bridges/:id/favorites namespace", async () => {
    // The two features share a word and nothing else: favoriting a page is local user data and must
    // not appear on (or require) a bridge's own favorites capability.
    await send("PUT", "/library/favorite-pages/example/alice/c1/0", { seriesTitle: "Alice" });
    const bridgeFavorites = await get("/bridges/example/favorites");
    // The example bridge has no `favorites` capability — a page favorite must not have created one.
    expect(bridgeFavorites.status).not.toBe(200);
    expect(await json<FavoriteBody[]>(await get("/library/favorite-pages"))).toHaveLength(1);
    await send("DELETE", "/library/favorite-pages/example/alice/c1/0");
  });
});
