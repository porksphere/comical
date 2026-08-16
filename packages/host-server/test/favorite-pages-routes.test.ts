/**
 * The `/library/favorite-pages` routes over a `FileLibraryStore` on a real temp dir.
 *
 * These are local-user-data routes for favoriting a single PAGE. They are unrelated to the
 * bridge-account per-series `favorites` capability under `/bridges/:id/favorites`, which is why they
 * live under `/library` — a fact the "namespaces stay separate" test below pins down.
 *
 * No page bytes are stored anywhere: a favorite is coordinates plus a display snapshot plus the two
 * re-anchor keys (`sourceUrl` and a client-supplied `contentHash`) that let a drifted chapter be
 * repaired.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Library } from "@comical/library";
import { ComicalRuntime } from "@comical/runtime";
import { BridgeManager } from "../src/bridge-manager.ts";
import { FileLibraryStore } from "../src/library-store.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-favorite-pages");

let baseUrl: string;
let noLibraryUrl: string;
let stop: () => void;

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
  sourceUrl?: string;
  contentHash?: string;
  stale?: boolean;
  favoritedAt: number;
  collectionIds: string[];
}
interface CollectionBody {
  id: string;
  name: string;
  order: number;
}
interface ReconcileBody {
  indices: number[];
  repaired: number;
  stale: number;
}

beforeAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  const manager = new BridgeManager({
    bridgesDir: BRIDGES_DIR,
    dataDir: DATA_DIR,
    settings: new SettingsStore(DATA_DIR),
  });

  const library = new Library(new FileLibraryStore(join(DATA_DIR, "library")));
  const runtime = new ComicalRuntime({ bridges: manager, library });
  const srv = Bun.serve({ port: 0, fetch: createRouter(manager, { library, runtime }).fetch });
  baseUrl = `http://localhost:${srv.port}`;

  // A second server with no library at all, for the absence check.
  const noLibrarySrv = Bun.serve({ port: 0, fetch: createRouter(manager).fetch });
  noLibraryUrl = `http://localhost:${noLibrarySrv.port}`;

  stop = () => {
    srv.stop(true);
    noLibrarySrv.stop(true);
  };
});

afterAll(() => {
  stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("favoriting pages", () => {
  test("PUT favorites a page with both re-anchor keys, DELETE removes it", async () => {
    const put = await send("PUT", "/library/favorite-pages/demo/s1/c1/3", {
      seriesTitle: "Series One",
      chapterName: "Ch 1",
      pageCount: 20,
      sourceUrl: "https://cdn.example/3.png",
      contentHash: "sha256-of-page-3",
    });
    expect(put.status).toBe(200);
    expect(await json<FavoriteBody>(put)).toMatchObject({
      bridgeId: "demo",
      seriesId: "s1",
      chapterId: "c1",
      pageIndex: 3,
      seriesTitle: "Series One",
      chapterName: "Ch 1",
      pageCount: 20,
      sourceUrl: "https://cdn.example/3.png",
      contentHash: "sha256-of-page-3",
      collectionIds: [],
    });

    expect((await send("DELETE", "/library/favorite-pages/demo/s1/c1/3")).status).toBe(200);
    expect(await json<FavoriteBody[]>(await get("/library/favorite-pages"))).toEqual([]);
  });

  test("PUT is idempotent — re-favoriting overwrites rather than duplicating", async () => {
    const first = await json<FavoriteBody>(
      await send("PUT", "/library/favorite-pages/demo/s1/c1/0", { seriesTitle: "Old" }),
    );
    const second = await json<FavoriteBody>(
      await send("PUT", "/library/favorite-pages/demo/s1/c1/0", { seriesTitle: "New" }),
    );

    expect(second.id).toBe(first.id);
    expect(second.favoritedAt).toBe(first.favoritedAt); // the original favorite date survives
    expect(second.seriesTitle).toBe("New"); // ...but the snapshot refreshes
    expect(await json<FavoriteBody[]>(await get("/library/favorite-pages"))).toHaveLength(1);

    await send("DELETE", "/library/favorite-pages/demo/s1/c1/0");
  });

  test("the two-PUT flow: favorite on tap, then send the hash, without losing anything", async () => {
    // The client can't hash before the first PUT — SHA-256 over a ~1MB page on Hermes' JS crypto
    // shim would visibly lag the tap. So it favorites immediately and follows up. The follow-up
    // carries only what it has, and must not erase the rest.
    const first = await json<FavoriteBody>(
      await send("PUT", "/library/favorite-pages/demo/twoput/c1/4", {
        seriesTitle: "Two Put",
        chapterName: "Ch 1",
        pageCount: 18,
        sourceUrl: "https://cdn/p4.png",
      }),
    );
    expect(first.contentHash).toBeUndefined();

    const second = await json<FavoriteBody>(
      await send("PUT", "/library/favorite-pages/demo/twoput/c1/4", {
        seriesTitle: "Two Put",
        contentHash: "sha-p4",
      }),
    );
    expect(second).toMatchObject({
      chapterName: "Ch 1",
      pageCount: 18,
      sourceUrl: "https://cdn/p4.png",
      contentHash: "sha-p4",
      favoritedAt: first.favoritedAt,
    });

    // And it is the persisted record, not just the response body.
    const listed = await json<FavoriteBody[]>(await get("/library/favorite-pages?series=demo:twoput"));
    expect(listed[0]).toMatchObject({ pageCount: 18, sourceUrl: "https://cdn/p4.png", contentHash: "sha-p4" });

    await send("DELETE", "/library/favorite-pages/demo/twoput/c1/4");
  });

  test("survives a restart — favorites round-trip through the FileLibraryStore on disk", async () => {
    await send("PUT", "/library/favorite-pages/demo/s1/c1/1", { seriesTitle: "Persisted" });
    // A fresh store over the same dir reads what the first one wrote.
    const reopened = new Library(new FileLibraryStore(join(DATA_DIR, "library")));
    expect((await reopened.getFavoritePages()).map((p) => p.seriesTitle)).toEqual(["Persisted"]);
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

describe("reconcile route — chapter drift", () => {
  test("repairs a shifted favorite and returns the indices to trust", async () => {
    await send("PUT", "/library/favorite-pages/demo/drift/c1/2", {
      seriesTitle: "Drifty",
      pageCount: 4,
      sourceUrl: "https://cdn/p2.png",
    });

    // A bare URL array — position is the page index.
    const res = await send("POST", "/library/favorite-pages/chapter/demo/drift/c1/reconcile", {
      pages: [{ url: "https://cdn/new.png" }, { url: "https://cdn/p0.png" }, { url: "https://cdn/p1.png" }, { url: "https://cdn/p2.png" }],
    });
    expect(res.status).toBe(200);
    expect(await json<ReconcileBody>(res)).toEqual({ indices: [3], repaired: 1, stale: 0 });

    // The plain GET now agrees — the repair is persisted, not just reported.
    expect(await json<number[]>(await get("/library/favorite-pages/chapter/demo/drift/c1"))).toEqual([3]);
    await send("DELETE", "/library/favorite-pages/demo/drift/c1/3");
  });

  test("an unlocatable favorite is marked stale, kept, and dropped from the indices", async () => {
    await send("PUT", "/library/favorite-pages/demo/gone/c1/1", {
      seriesTitle: "Replaced",
      pageCount: 3,
      sourceUrl: "https://cdn/old-1.png",
    });

    const res = await json<ReconcileBody>(
      await send("POST", "/library/favorite-pages/chapter/demo/gone/c1/reconcile", {
        pages: [{ url: "https://cdn/v2-0.png" }, { url: "https://cdn/v2-1.png" }],
      }),
    );
    expect(res).toEqual({ indices: [], repaired: 0, stale: 1 });

    // Still in the grid — the user favorited it deliberately — but flagged.
    const all = await json<FavoriteBody[]>(await get("/library/favorite-pages?series=demo:gone"));
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ stale: true, seriesTitle: "Replaced" });
    expect(await json<number[]>(await get("/library/favorite-pages/chapter/demo/gone/c1"))).toEqual([]);

    await send("DELETE", "/library/favorite-pages/demo/gone/c1/1");
  });

  test("a content hash relocates a favorite whose URLs have rotated", async () => {
    await send("PUT", "/library/favorite-pages/demo/rot/c1/2", {
      seriesTitle: "Rotated",
      pageCount: 3,
      sourceUrl: "https://cdn/old-p2.png?sig=OLD",
      contentHash: "sha-p2",
    });

    // Every URL re-signed, and the reader only had bytes for the page it was showing — one hash.
    const res = await json<ReconcileBody>(
      await send("POST", "/library/favorite-pages/chapter/demo/rot/c1/reconcile", {
        pages: [
          { url: "https://cdn/new-a.png?sig=NEW" },
          { url: "https://cdn/new-b.png?sig=NEW", contentHash: "sha-p2" },
          { url: "https://cdn/new-c.png?sig=NEW" },
        ],
      }),
    );
    expect(res).toEqual({ indices: [1], repaired: 1, stale: 0 });
    expect(await json<number[]>(await get("/library/favorite-pages/chapter/demo/rot/c1"))).toEqual([1]);
    await send("DELETE", "/library/favorite-pages/demo/rot/c1/1");
  });

  test("an empty page list is a no-op, so a failed fetch can't stale a whole chapter", async () => {
    await send("PUT", "/library/favorite-pages/demo/safe/c1/0", { seriesTitle: "S", pageCount: 2 });
    expect(
      await json<ReconcileBody>(await send("POST", "/library/favorite-pages/chapter/demo/safe/c1/reconcile", { pages: [] })),
    ).toEqual({ indices: [0], repaired: 0, stale: 0 });
    await send("DELETE", "/library/favorite-pages/demo/safe/c1/0");
  });

  test("requires a pages array, and tolerates junk entries within it", async () => {
    expect((await send("POST", "/library/favorite-pages/chapter/demo/s1/c1/reconcile", {})).status).toBe(400);
    expect((await send("POST", "/library/favorite-pages/chapter/demo/s1/c1/reconcile", { pages: "nope" })).status).toBe(400);
    // One odd element must not reject an entire chapter's reconcile — non-strings become "",
    // which still counts toward the length.
    const ok = await send("POST", "/library/favorite-pages/chapter/demo/s1/c1/reconcile", {
      pages: [null, 5, { url: "https://cdn/ok.png" }, { contentHash: 9 }, { url: "https://cdn/x.png", contentHash: "sha-x" }],
    });
    expect(ok.status).toBe(200);
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

    // The literal segment wins over the `:id/collections` pattern.
    const list = await get("/library/favorite-pages/collections");
    expect(list.status).toBe(200);
    expect((await json<CollectionBody[]>(list)).map((c) => c.name)).toEqual(["Panels", "Splashes"]);

    expect(
      (await send("PATCH", `/library/favorite-pages/collections/${panels.id}`, { name: "Best Panels" })).status,
    ).toBe(200);

    await send("POST", "/library/favorite-pages/collections/reorder", { orderedIds: [splashes.id, panels.id] });
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

    // Addressed by coordinates, like every other favorite route — no id in the URL.
    const assigned = await send("PUT", "/library/favorite-pages/demo/s1/c1/0/collections", {
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

  test("assigning collections to an unknown favorite 404s; a bad body or index 400s", async () => {
    expect((await send("PUT", "/library/favorite-pages/demo/ghost/c1/0/collections", {})).status).toBe(400);
    expect((await send("PUT", "/library/favorite-pages/demo/ghost/c1/x/collections", { collectionIds: [] })).status).toBe(400);
    expect(
      (await send("PUT", "/library/favorite-pages/demo/ghost/c1/0/collections", { collectionIds: [] })).status,
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
    const reading = await json<FavoriteBody[]>(await get("/library/favorite-pages?sort=chapter&dir=asc&series=demo:s1"));
    expect(reading.map((p) => p.chapterName)).toEqual(["Ch 1", "Ch 2"]);

    // An unrecognised sort falls back to the default rather than erroring.
    expect((await get("/library/favorite-pages?sort=bogus")).status).toBe(200);

    await send("DELETE", "/library/favorite-pages/demo/s1/c2/1");
    await send("DELETE", "/library/favorite-pages/demo/s2/c9/4");
    await send("DELETE", "/library/favorite-pages/demo/s1/c1/7");
  });

  test("favorites store no page bytes, so they add nothing to /library/usage beyond their document", async () => {
    const before = await json<{ diskBytes: number }>(await get("/library/usage"));
    await send("PUT", "/library/favorite-pages/demo/s1/c7/0", {
      seriesTitle: "S",
      sourceUrl: "https://cdn.example/7.png",
    });
    const after = await json<{ diskBytes: number }>(await get("/library/usage"));
    // A JSON record, not a page image: kilobytes at most, never the hundreds of KB a page runs to.
    expect(after.diskBytes - before.diskBytes).toBeLessThan(4096);
    await send("DELETE", "/library/favorite-pages/demo/s1/c7/0");
  });
});

describe("absence and namespace separation", () => {
  test("every favorite-pages route 404s when no library is mounted", async () => {
    for (const [method, path] of [
      ["GET", "/library/favorite-pages"],
      ["GET", "/library/favorite-pages/chapter/demo/s1/c1"],
      ["POST", "/library/favorite-pages/chapter/demo/s1/c1/reconcile"],
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
