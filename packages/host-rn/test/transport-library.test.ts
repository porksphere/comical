/**
 * The embedded transport's optional on-device library: when `createEmbeddedTransport` is given a
 * `{ library, runtime }` pair (built by `installEmbeddedTransport` from an injected `LibraryStore`),
 * the reused `@comical/host-server` router mounts the `/library*` endpoints and resolves them
 * in-process against that store — so the app's Library/History/Activity work on-device with no server.
 * Without the pair, those endpoints are unmounted (404), which is what makes the app degrade to a
 * "needs a library" state in the absence of a store.
 */
import { describe, expect, test } from "bun:test";
import { createRouter } from "@comical/host-server/router";
import { InMemoryLibraryStore, Library } from "@comical/library";
import { ComicalRuntime } from "@comical/runtime";
import { createEmbeddedTransport } from "../src/transport.ts";
import type { BridgeProvider, CreateRouter } from "../src/types.ts";

// The `/library*` routes exercised here never touch a bridge (entries are added with a title
// snapshot, so `addToLibrary` skips the bridge fetch), so a stub provider that throws is enough —
// it proves the library endpoints resolve purely from the injected store.
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

function withLibraryTransport() {
  const library = new Library(new InMemoryLibraryStore());
  const runtime = new ComicalRuntime({ bridges: stubProvider, library });
  return createEmbeddedTransport(stubProvider, makeCreate(), undefined, { library, runtime });
}

describe("embedded transport — on-device library", () => {
  test("mounts /library* when a library + runtime are supplied", async () => {
    const t = withLibraryTransport();

    // Empty to start.
    const empty = await t("/library");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    // Add a series with a title snapshot (no bridge fetch needed).
    const added = await t("/library/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bridgeId: "b1", seriesId: "s1", title: "On-Device Series" }),
    });
    expect(added.status).toBe(201);

    // Now the library lists it, with a derived unreadCount the grid renders.
    const listed = await t("/library");
    const entries = (await listed.json()) as Array<{ seriesId: string; title: string; unreadCount: number }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.seriesId).toBe("s1");
    expect(entries[0]!.title).toBe("On-Device Series");
    expect(entries[0]!.unreadCount).toBe(0);

    // Membership check the series screen uses (200 = in library).
    const member = await t("/library/entries/b1/s1");
    expect(member.status).toBe(200);

    // A non-library read lands in reading history.
    const rec = await t("/reading-history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bridgeId: "b1", seriesId: "s2", title: "Log Series", chapterId: "c1", lastPage: 2, pageCount: 10 }),
    });
    expect(rec.status).toBe(200);

    const history = await t("/library/history");
    const rows = (await history.json()) as Array<{ seriesId: string }>;
    expect(rows.map((r) => r.seriesId).sort()).toEqual(["s2"]);

    // Activity feed is present (empty until a sync detects new chapters).
    const activity = await t("/library/activity");
    expect(activity.status).toBe(200);
    expect(await activity.json()).toEqual([]);
  });

  test("leaves /library* unmounted (404) when no library is supplied", async () => {
    const t = createEmbeddedTransport(stubProvider, makeCreate());
    const res = await t("/library");
    expect(res.status).toBe(404);
  });
});
