/**
 * A series the source says no longer exists. A bridge throws `seriesGoneMessage(reason)`; the router
 * answers 410 `{ error, gone: { reason } }`, records the answer on a collected entry, and — since the
 * whole point of keeping it is that the user can still read what they saved — keeps serving the
 * saved detail (flagged with the `removal`) and chapter list.
 */
import { describe, expect, test } from "bun:test";
import { seriesGoneMessage, type BridgeInfo, type Chapter, type Page, type SeriesInfo } from "@comical/contract";
import { entryKey, InMemoryLibraryStore, Library } from "@comical/library";
import type { BridgeProvider } from "../src/bridge-provider.ts";
import { createRouter } from "../src/router.ts";

const INFO: BridgeInfo = {
  id: "src",
  name: "Source",
  version: "1.0.0",
  contractVersion: "2.0.0",
  languages: ["en"],
  nsfw: false,
  capabilities: [],
};

/**
 * A bridge whose `gone` set of series answer with the series-gone marker — on every call for an id,
 * or on one call for `"<id>:<surface>"` (the shape of a source whose metadata API still describes a
 * taken-down gallery, only the page reader hits the notice); `down` throws a plain error.
 */
function setup() {
  const gone = new Set<string>();
  const down = new Set<string>();
  const fail = (id: string, surface: "details" | "chapters" | "pages") => {
    if (gone.has(id) || gone.has(`${id}:${surface}`)) throw new Error(`${surface} threw: ${seriesGoneMessage("Taken down by the source")}`);
    if (down.has(id)) throw new Error(`${surface} threw: network unreachable`);
  };
  const bridge = {
    info: INFO,
    getSeriesDetails: async (id: string): Promise<SeriesInfo> => {
      fail(id, "details");
      return { id, title: `Series ${id}` };
    },
    getChapters: async (id: string): Promise<Chapter[]> => {
      fail(id, "chapters");
      return [{ id: "c1", name: "Chapter 1", number: 1 }];
    },
    getChapterPages: async (id: string): Promise<Page[]> => {
      fail(id, "pages");
      return [{ index: 0, imageUrl: "https://example.test/1.jpg" }];
    },
    getSeriesPages: async (id: string): Promise<Page[]> => {
      fail(id, "pages");
      return [{ index: 0, imageUrl: "https://example.test/1.jpg" }];
    },
  };
  const manager: BridgeProvider = {
    list: async () => [{ info: INFO, settings: [], configured: true, secretsSet: [], missingRequired: [], source: "registry" as const }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: async (id: string): Promise<any> => {
      if (id !== "src") throw new Error(`bridge not found: ${id}`);
      return bridge;
    },
    missingRequired: async () => [],
    storedSettings: async () => ({}),
    updateSettings: async () => ({}),
    invalidate: () => {},
    refresh: () => {},
  };
  let clock = 1_000_000;
  const library = new Library(new InMemoryLibraryStore(), { now: () => clock });
  const app = createRouter(manager, { library });
  const get = (p: string) => app.fetch(new Request(`http://embedded${p}`));
  const advance = (ms: number) => (clock += ms);
  return { gone, down, library, get, advance };
}

describe("series removed from the source", () => {
  test("an uncollected series answers 410 with the reason", async () => {
    const { gone, get } = setup();
    gone.add("x");
    const res = await get("/bridges/src/series/x");
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string; gone: { reason: string } };
    expect(body.gone).toEqual({ reason: "Taken down by the source" });
    expect((await get("/bridges/src/series/x/chapters")).status).toBe(410);
  });

  test("a missing bridge is still a 404, not a 410", async () => {
    const { get } = setup();
    expect((await get("/bridges/nope/series/x")).status).toBe(404);
  });

  test("a collected series keeps serving its saved detail and chapters, flagged with the removal", async () => {
    const { gone, library, get } = setup();
    await library.collectSeries({ bridgeId: "src", seriesId: "a" }, { seriesTitle: "Series a" });
    expect((await get("/bridges/src/series/a")).status).toBe(200); // live → cached detail
    expect((await get("/bridges/src/series/a/chapters")).status).toBe(200); // live → saved chapters

    gone.add("a");
    const first = await get("/bridges/src/series/a");
    expect(first.status).toBe(200);
    const detail = (await first.json()) as {
      title: string;
      cached?: boolean;
      removal?: { reason: string; firstSeenAt: number; confirmedAt?: number; via?: string };
    };
    expect(detail.title).toBe("Series a");
    expect(detail.cached).toBe(true);
    expect(detail.removal).toMatchObject({ reason: "Taken down by the source", confirmedAt: 1_000_000, via: "details" }); // one answer confirms it

    const chapters = await get("/bridges/src/series/a/chapters");
    expect(chapters.status).toBe(200);
    expect(((await chapters.json()) as Chapter[]).map((c) => c.id)).toEqual(["c1"]);

    expect((await library.getLibrary({ removed: true })).map((v) => v.seriesId)).toEqual(["a"]);
    const listed = (await (await get("/library?removed=true")).json()) as Array<{ seriesId: string; removal?: unknown }>;
    expect(listed.map((v) => v.seriesId)).toEqual(["a"]);
    expect(listed[0]?.removal).toBeDefined(); // the list rows carry it, so cards can badge it
  });

  test("an ordinary failure still reports a removal recorded earlier, without adding to it", async () => {
    const { gone, down, library, get, advance } = setup();
    await library.collectSeries({ bridgeId: "src", seriesId: "a" }, { seriesTitle: "Series a" });
    await get("/bridges/src/series/a");
    gone.add("a");
    await get("/bridges/src/series/a");
    gone.delete("a");
    down.add("a");
    advance(1);
    const res = (await (await get("/bridges/src/series/a")).json()) as {
      cached?: boolean;
      removal?: { reason: string; lastSeenAt: number };
    };
    expect(res.cached).toBe(true);
    expect(res.removal?.reason).toBe("Taken down by the source");
    expect(res.removal?.lastSeenAt).toBe(1_000_000); // a network error is no gone answer
  });

  test("a live detail reports a removal the pages call heard; only the pages coming back clears it", async () => {
    const { gone, library, get } = setup();
    await library.collectSeries({ bridgeId: "src", seriesId: "a" }, { seriesTitle: "Series a" });
    expect((await get("/bridges/src/series/a")).status).toBe(200);

    gone.add("a:pages");
    expect((await get("/bridges/src/series/a/pages")).status).toBe(410);
    const res = (await (await get("/bridges/src/series/a")).json()) as {
      title: string;
      cached?: boolean;
      removal?: { reason: string; via?: string };
    };
    expect(res.title).toBe("Series a");
    expect(res.cached).toBeUndefined(); // the live answer…
    expect(res.removal).toMatchObject({ reason: "Taken down by the source", via: "pages" }); // …still says removed
    expect((await library.getSeries(entryKey("src", "a")))?.removal?.via).toBe("pages");
    // A chapter list coming back doesn't disprove it either.
    expect((await get("/bridges/src/series/a/chapters")).status).toBe(200);
    expect((await library.getSeries(entryKey("src", "a")))?.removal?.via).toBe("pages");

    gone.delete("a:pages");
    expect((await get("/bridges/src/series/a/pages")).status).toBe(200);
    expect((await library.getSeries(entryKey("src", "a")))?.removal).toBeUndefined();
    const after = (await (await get("/bridges/src/series/a")).json()) as { removal?: unknown };
    expect(after.removal).toBeUndefined();
  });

  test("an uncollected series' live detail carries no removal field", async () => {
    const { get } = setup();
    const res = (await (await get("/bridges/src/series/x")).json()) as { removal?: unknown };
    expect("removal" in res).toBe(false);
  });

  test("the chapters route records a gone answer too", async () => {
    const { gone, library, get } = setup();
    await library.collectSeries({ bridgeId: "src", seriesId: "a" }, { seriesTitle: "Series a" });
    gone.add("a");
    await get("/bridges/src/series/a/chapters");
    expect((await library.getSeries(entryKey("src", "a")))?.removal?.reason).toBe("Taken down by the source");
  });

  test("the pages routes record a gone answer too, and still answer 410", async () => {
    for (const path of ["/chapters/c1/pages", "/pages"]) {
      const { gone, library, get } = setup();
      await library.collectSeries({ bridgeId: "src", seriesId: "a" }, { seriesTitle: "Series a" });
      gone.add("a");
      expect((await get(`/bridges/src/series/a${path}`)).status).toBe(410);
      expect((await library.getSeries(entryKey("src", "a")))?.removal?.reason).toBe("Taken down by the source");
    }
  });

  test("a pages failure that isn't gone records nothing", async () => {
    const { down, library, get } = setup();
    await library.collectSeries({ bridgeId: "src", seriesId: "a" }, { seriesTitle: "Series a" });
    down.add("a");
    expect((await get("/bridges/src/series/a/chapters/c1/pages")).ok).toBe(false);
    expect((await library.getSeries(entryKey("src", "a")))?.removal).toBeUndefined();
  });

  test("the series coming back clears the removal", async () => {
    const { gone, library, get } = setup();
    await library.collectSeries({ bridgeId: "src", seriesId: "a" }, { seriesTitle: "Series a" });
    gone.add("a");
    await get("/bridges/src/series/a");
    gone.delete("a");
    const res = (await (await get("/bridges/src/series/a")).json()) as { cached?: boolean; removal?: unknown };
    expect(res.cached).toBeUndefined();
    expect(res.removal).toBeUndefined();
    expect((await library.getSeries(entryKey("src", "a")))?.removal).toBeUndefined();
  });
});
