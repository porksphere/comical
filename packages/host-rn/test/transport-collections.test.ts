/**
 * The embedded transport's favorites surface: with an on-device library the reused
 * `@comical/host-server` router mounts `/library/collected*` + `/library/collections*` and resolves
 * them in-process, so favoriting works with no server.
 *
 * Favorites store no page bytes on device — only coordinates, a display snapshot, and the two
 * re-anchor keys (`sourceUrl`, plus a `contentHash` the client computes from bytes it already
 * holds). The reconcile route is what keeps page favorites pointing at the right page when a source
 * shifts a chapter underneath them.
 */
import { describe, expect, test } from "bun:test";
import { createRouter } from "@comical/host-server/router";
import { InMemoryLibraryStore, Library } from "@comical/library";
import { ComicalRuntime } from "@comical/runtime";
import { createEmbeddedTransport } from "../src/transport.ts";
import type { BridgeProvider, CreateRouter } from "../src/types.ts";

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
function makeTransport() {
  const library = new Library(new InMemoryLibraryStore());
  const runtime = new ComicalRuntime({ bridges: stubProvider, library });
  return createEmbeddedTransport(stubProvider, makeCreate(), undefined, { library, runtime });
}

const put = (t: ReturnType<typeof makeTransport>, path: string, body: unknown) =>
  t(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("embedded transport — page favorites", () => {
  test("mounts /library/collected* and /library/collections* when a library is supplied", async () => {
    const t = makeTransport();

    const empty = await t("/library/collected");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    const collections = await t("/library/collections");
    expect(collections.status).toBe(200);
    expect(await collections.json()).toEqual([]);
  });

  test("leaves the favorites surface unmounted (404) when no library is supplied", async () => {
    const t = createEmbeddedTransport(stubProvider, makeCreate());
    expect((await t("/library/collected")).status).toBe(404);
    expect((await t("/library/collections")).status).toBe(404);
  });

  test("favoriting round-trips in-process, and the chapter route serves the reader's indices", async () => {
    const t = makeTransport();
    expect((await put(t, "/library/collected/page/demo/s1/c1/3", { seriesTitle: "Series One" })).status).toBe(200);
    expect((await put(t, "/library/collected/page/demo/s1/c1/1", { seriesTitle: "Series One" })).status).toBe(200);

    const indices = await t("/library/collected/page/demo/s1/c1/indices");
    expect(indices.status).toBe(200);
    expect(await indices.json()).toEqual([1, 3]);

    const list = (await (await t("/library/collected")).json()) as { id: string }[];
    expect(list).toHaveLength(2);
  });

  test("reconcile reaches the router in-process and repairs a shifted favorite", async () => {
    const t = makeTransport();
    await put(t, "/library/collected/page/demo/s1/c1/2", {
      seriesTitle: "Series One",
      pageCount: 4,
      sourceUrl: "https://cdn/p2.png",
    });

    const res = await t("/library/collected/page/demo/s1/c1/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pages: [{ url: "https://cdn/new.png" }, { url: "https://cdn/p2.png" }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ indices: [1], repaired: 1, stale: 0 });

    // The reader's zero-request path agrees with the repair.
    expect(await (await t("/library/collected/page/demo/s1/c1/indices")).json()).toEqual([1]);
  });

  test("favorites carry no stored bytes — only coordinates, snapshot and re-anchor signals", async () => {
    const t = makeTransport();
    const res = await put(t, "/library/collected/page/demo/s1/c1/0", {
      seriesTitle: "Series One",
      sourceUrl: "https://cdn.example/0.png",
      contentHash: "sha-0",
    });
    const page = (await res.json()) as Record<string, unknown>;
    expect(page).toMatchObject({ sourceUrl: "https://cdn.example/0.png", contentHash: "sha-0" });
    // Nothing thumbnail-shaped survived the redesign.
    expect(page.hasThumb).toBeUndefined();
    expect(page.thumbFile).toBeUndefined();
    expect((await t(`/library/collected/${encodeURIComponent(String(page.id))}/thumb`)).status).toBe(404);
  });
});
