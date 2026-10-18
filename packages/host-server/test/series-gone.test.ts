/**
 * A series the source says no longer exists. A bridge throws `seriesGoneMessage(reason)`; the router
 * answers 410 `{ error, gone: { reason } }`, records the answer on a collected entry, and — since the
 * whole point of keeping it is that the user can still read what they saved — keeps serving the
 * saved detail (flagged with the `removal`) and chapter list.
 */
import { describe, expect, test } from "bun:test";
import { seriesGoneMessage, type BridgeInfo, type Chapter, type Page, type SeriesInfo } from "@comical/contract";
import { entryKey, InMemoryLibraryStore, Library, REMOVAL_CONFIRM_MS } from "@comical/library";
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

/** A bridge whose `gone` set of series answer with the series-gone marker; `down` throws a plain error. */
function setup() {
  const gone = new Set<string>();
  const down = new Set<string>();
  const fail = (id: string) => {
    if (gone.has(id)) throw new Error(`getSeriesDetails threw: ${seriesGoneMessage("Taken down by the source")}`);
    if (down.has(id)) throw new Error("getSeriesDetails threw: network unreachable");
  };
  const bridge = {
    info: INFO,
    getSeriesDetails: async (id: string): Promise<SeriesInfo> => {
      fail(id);
      return { id, title: `Series ${id}` };
    },
    getChapters: async (id: string): Promise<Chapter[]> => {
      fail(id);
      return [{ id: "c1", name: "Chapter 1", number: 1 }];
    },
    getChapterPages: async (id: string): Promise<Page[]> => {
      fail(id);
      return [{ index: 0, imageUrl: "https://example.test/1.jpg" }];
    },
    getSeriesPages: async (id: string): Promise<Page[]> => {
      fail(id);
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
    const { gone, library, get, advance } = setup();
    await library.collectSeries({ bridgeId: "src", seriesId: "a" }, { seriesTitle: "Series a" });
    expect((await get("/bridges/src/series/a")).status).toBe(200); // live → cached detail
    expect((await get("/bridges/src/series/a/chapters")).status).toBe(200); // live → saved chapters

    gone.add("a");
    const first = await get("/bridges/src/series/a");
    expect(first.status).toBe(200);
    const detail = (await first.json()) as {
      title: string;
      cached?: boolean;
      removal?: { reason: string; firstSeenAt: number; confirmedAt?: number };
    };
    expect(detail.title).toBe("Series a");
    expect(detail.cached).toBe(true);
    expect(detail.removal?.reason).toBe("Taken down by the source");
    expect(detail.removal?.confirmedAt).toBeUndefined(); // one answer is only a suspicion

    const chapters = await get("/bridges/src/series/a/chapters");
    expect(chapters.status).toBe(200);
    expect(((await chapters.json()) as Chapter[]).map((c) => c.id)).toEqual(["c1"]);

    advance(REMOVAL_CONFIRM_MS + 1);
    const second = (await (await get("/bridges/src/series/a")).json()) as { removal?: { confirmedAt?: number } };
    expect(second.removal?.confirmedAt).toBeDefined();
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
    advance(REMOVAL_CONFIRM_MS + 1);
    const res = (await (await get("/bridges/src/series/a")).json()) as {
      cached?: boolean;
      removal?: { reason: string; confirmedAt?: number };
    };
    expect(res.cached).toBe(true);
    expect(res.removal?.reason).toBe("Taken down by the source");
    expect(res.removal?.confirmedAt).toBeUndefined(); // a network error is no second answer
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
