/**
 * Verifies the reference bridge end-to-end through the real runtime: the built bundle is loaded
 * into the core sandbox, wired to the testkit fixture backend, and run against the reusable
 * conformance suite plus output snapshots. All offline and deterministic.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadBridge } from "@comical/core";
import { FixtureBackend, fixtureHost, runConformance } from "@comical/testkit";

const BUNDLE = readFileSync(join(import.meta.dir, "..", "dist", "bridge.js"), "utf8");

function load() {
  const backend = new FixtureBackend();
  return loadBridge({
    code: BUNDLE,
    capabilities: fixtureHost(backend),
    expectedId: "example",
  });
}

describe("example-bridge", () => {
  test("cheerio parsing runs inside the sandbox (search returns entries)", async () => {
    const bridge = load();
    const results = await bridge.getSearchResults!({ text: "" });
    expect(results.items.length).toBeGreaterThan(0);
    expect(results.items[0]!.title).toBeTruthy();
    expect(results.items[0]!.thumbnailUrl).toStartWith("https://picsum.photos/seed/");
  });

  test("passes the full conformance suite", async () => {
    const report = await runConformance(load(), { searchQuery: "" });
    expect(report.sampledSeriesId).toBeTruthy();
    expect(report.sampledChapterId).toBeTruthy();
  });

  test("search → details → chapters → pages snapshot", async () => {
    const bridge = load();
    const details = await bridge.getSeriesDetails("sherlock");
    expect({
      id: details.id,
      title: details.title,
      author: details.author,
      status: details.status,
      genres: details.tagGroups?.find((g) => g.kind === "genre")?.tags,
    }).toMatchSnapshot("sherlock-details");

    const chapters = await bridge.getChapters!("sherlock");
    expect(chapters.map((c) => ({ id: c.id, name: c.name, number: c.number }))).toMatchSnapshot(
      "sherlock-chapters",
    );

    const pages = await bridge.getChapterPages!("sherlock", "sherlock-1");
    expect(pages).toMatchSnapshot("sherlock-1-pages");
  });

  test("parses bridge-defined card badges from search/list results", async () => {
    const bridge = load();
    const results = await bridge.getSearchResults!({ text: "" });
    // Every fixture card carries a language badge anchored top-right.
    for (const item of results.items) {
      const en = item.badges?.find((b) => b.text === "EN");
      expect(en).toEqual({ text: "EN", position: "top-right", tone: "info" });
    }
    // Still-running series additionally get a "NEW" badge — proves multiple badges + positions parse.
    const withNew = results.items.find((i) => i.badges?.some((b) => b.text === "NEW"));
    expect(withNew?.badges).toContainEqual({ text: "NEW", position: "top-left", tone: "success" });

    // The same parsing path feeds list results.
    const list = await bridge.getListItems!("latest");
    expect(list.items[0]!.badges?.some((b) => b.text === "EN")).toBe(true);
  });

  test("parses related-series rails into labeled, kinded groups", async () => {
    const bridge = load();
    const details = await bridge.getSeriesDetails("dracula");
    const groups = details.relatedSeriesGroups ?? [];
    expect(groups.length).toBe(2);

    const gothic = groups.find((g) => g.label === "Gothic Horror");
    expect(gothic?.kind).toBe("similar");
    expect(gothic?.series.map((s) => s.id)).toEqual(["frankenstein", "jekyll", "wuthering"]);
    // Cards carry real titles + resolved covers so the host can render tappable rails.
    expect(gothic?.series[0]!.title).toBe("Frankenstein");
    expect(gothic?.series[0]!.thumbnailUrl).toStartWith("https://picsum.photos/seed/");

    const recommended = groups.find((g) => g.label === "Recommended");
    expect(recommended?.kind).toBe("recommended");
    expect(recommended?.series.length).toBe(3);
  });

  test("omits relatedSeriesGroups when a series has no related rails", async () => {
    const bridge = load();
    const details = await bridge.getSeriesDetails("sherlock");
    expect(details.relatedSeriesGroups).toBeUndefined();
  });

  test("lists catalog + items (presentation-as-data)", async () => {
    const bridge = load();
    const lists = await bridge.getLists!();
    expect(lists.length).toBeGreaterThan(0);
    expect(lists[0]!.id).toBeTruthy();
    expect(lists[0]!.layout).toBe("carousel");
    expect(lists[0]!.featured).toBe(true);

    const items = await bridge.getListItems!(lists[0]!.id);
    expect(items.items.length).toBeGreaterThan(0);
    expect(items.items[0]!.title).toBeTruthy();
  });

  test("list items paginate by cursor: distinct pages, last page omits nextCursor", async () => {
    const bridge = load();
    const p1 = await bridge.getListItems!("latest");
    expect(p1.items.length).toBeGreaterThan(0);
    // More catalog remains, so the bridge hands back a token for the following page.
    expect(typeof p1.nextCursor).toBe("string");

    const p2 = await bridge.getListItems!("latest", { cursor: p1.nextCursor! });
    // Page 2 is a different slice of the catalog — no id overlap with page 1.
    const p1ids = new Set(p1.items.map((i) => i.id));
    expect(p2.items.every((i) => !p1ids.has(i.id))).toBe(true);

    // Walk the cursor chain to the end; the terminal page has no nextCursor at all.
    const seen = new Set<string>();
    let last = p1;
    for (let hop = 0; last.nextCursor && hop < 50; hop++) {
      for (const item of last.items) seen.add(item.id);
      last = await bridge.getListItems!("latest", { cursor: last.nextCursor });
    }
    expect(last.nextCursor).toBeUndefined();
    // The walk visited real, non-repeating items rather than looping on one page.
    expect(seen.size).toBeGreaterThan(p1.items.length);
  });

  test("a malformed cursor restarts the walk instead of throwing", async () => {
    const bridge = load();
    // A stale/corrupted cursor must not surface as an error mid-scroll — it degrades to page 1.
    const garbage = await bridge.getListItems!("latest", { cursor: "not-a-real-cursor" });
    const first = await bridge.getListItems!("latest");
    expect(garbage.items.map((i) => i.id)).toEqual(first.items.map((i) => i.id));
  });

  test("search within a list narrows that list's items", async () => {
    const bridge = load();
    const lists = await bridge.getLists!();
    const popular = lists.find((l) => l.id === "popular")!;
    expect(popular.searchable).toBe(true);

    const all = await bridge.getListItems!("popular");
    const scoped = await bridge.getListItems!("popular", { query: "sherlock" });
    expect(scoped.items.length).toBeGreaterThan(0);
    expect(scoped.items.length).toBeLessThan(all.items.length);
    expect(scoped.items.every((i) => i.id === "sherlock")).toBe(true);
  });

  test("filters narrow results; sort (separate) orders them", async () => {
    const bridge = load();
    const filters = await bridge.getFilters!();
    expect(filters.find((f) => f.key === "genre")?.type).toBe("multiselect");
    expect(filters.find((f) => f.key === "author")?.type).toBe("text");
    const sorts = await bridge.getSortOptions!();
    expect(sorts.map((s) => s.key)).toContain("title");

    // Unfiltered returns the whole catalog; a genre filter narrows it (Sherlock is Mystery).
    const all = await bridge.getSearchResults!({ text: "" });
    const mystery = await bridge.getSearchResults!({ text: "",  filters: [{ key: "genre", value: ["Mystery"] }] });
    expect(mystery.items.length).toBeGreaterThan(0);
    expect(mystery.items.length).toBeLessThan(all.items.length);
    expect(mystery.items.some((i) => i.id === "sherlock")).toBe(true);

    // Sort by title descending flips the order (sort lives in options.sort, not filters).
    const asc = await bridge.getSearchResults!({ text: "",  sort: { key: "title", ascending: true } });
    const desc = await bridge.getSearchResults!({ text: "",  sort: { key: "title", ascending: false } });
    expect(asc.items.map((i) => i.id).join()).toBe([...desc.items].reverse().map((i) => i.id).join());
  });

  test("author filter returns only that author's series", async () => {
    const bridge = load();
    const all = await bridge.getSearchResults!({ text: "" });

    // Lewis Carroll only wrote Alice in the fixture catalog.
    const carroll = await bridge.getSearchResults!({ text: "", 
      filters: [{ key: "author", value: "Lewis Carroll" }],
    });
    expect(carroll.items.length).toBeGreaterThan(0);
    expect(carroll.items.length).toBeLessThan(all.items.length);
    expect(carroll.items.every((i) => i.id === "alice")).toBe(true);

    // Partial name match (case-insensitive) should also work.
    const partial = await bridge.getSearchResults!({ text: "", 
      filters: [{ key: "author", value: "carroll" }],
    });
    expect(partial.items.map((i) => i.id)).toEqual(carroll.items.map((i) => i.id));
  });

  test("author filter with no matches returns empty results", async () => {
    const bridge = load();
    const results = await bridge.getSearchResults!({ text: "", 
      filters: [{ key: "author", value: "Nonexistent Author XYZ" }],
    });
    expect(results.items.length).toBe(0);
  });

  test("ongoing filter narrows both search and list results to running series", async () => {
    const bridge = load();
    const filters = await bridge.getFilters!();
    expect(filters.find((f) => f.key === "ongoing")).toEqual({
      type: "toggle",
      key: "ongoing",
      label: "Ongoing only",
    });

    const all = await bridge.getSearchResults!({ text: "" });
    const ongoing = await bridge.getSearchResults!({ text: "",  filters: [{ key: "ongoing", value: true }] });
    expect(ongoing.items.length).toBeGreaterThan(0);
    expect(ongoing.items.length).toBeLessThan(all.items.length);

    const allList = await bridge.getListItems!("latest");
    const ongoingList = await bridge.getListItems!("latest", { filters: [{ key: "ongoing", value: true }] });
    expect(ongoingList.items.length).toBeGreaterThan(0);
    expect(ongoingList.items.length).toBeLessThan(allList.items.length);

    // Explicitly false behaves the same as unset — no narrowing.
    const explicitFalse = await bridge.getSearchResults!({ text: "",  filters: [{ key: "ongoing", value: false }] });
    expect(explicitFalse.items.length).toBe(all.items.length);
  });

  test("favorites: round-trip add → list → remove (authenticated)", async () => {
    const backend = new FixtureBackend();
    const bridge = loadBridge({
      code: BUNDLE,
      capabilities: fixtureHost(backend, { sessionToken: "demo" }),
      expectedId: "example",
    });
    expect((await bridge.getFavorites!()).items.length).toBe(0);

    await bridge.addFavorite!("dracula");
    const after = await bridge.getFavorites!();
    expect(after.items.map((i) => i.id)).toContain("dracula");

    await bridge.removeFavorite!("dracula");
    expect((await bridge.getFavorites!()).items.map((i) => i.id)).not.toContain("dracula");
  });

  test("favorites require authentication (no sessionToken → throws)", async () => {
    const bridge = load(); // load() wires baseUrl but no sessionToken
    await expect(bridge.getFavorites!()).rejects.toThrow();
  });

  describe("checkForUpdates (batch update check)", () => {
    test("answers many series in one request, matching what getChapters would report", async () => {
      const bridge = load();
      const ids = ["sherlock", "dracula", "alice"];
      const revisions = await bridge.checkForUpdates!(ids);

      expect(Object.keys(revisions).sort()).toEqual([...ids].sort());
      for (const id of ids) {
        const chapters = await bridge.getChapters!(id);
        expect(revisions[id]).toEqual({
          latestChapterId: chapters[chapters.length - 1]!.id,
          chapterCount: chapters.length,
        });
      }
    });

    test("omits ids the backend doesn't know rather than guessing", async () => {
      const bridge = load();
      const revisions = await bridge.checkForUpdates!(["dracula", "no-such-series"]);
      expect(Object.keys(revisions)).toEqual(["dracula"]);
    });

    test("the fingerprint moves when the series gains a chapter", async () => {
      const catalog = [
        {
          id: "solo",
          title: "Solo",
          author: "A",
          description: "d",
          genres: ["Drama"],
          status: "ongoing" as const,
          chapters: [{ id: "solo-1", name: "One", number: 1, pages: 2 }],
        },
      ];
      const backend = new FixtureBackend(catalog);
      const bridge = loadBridge({ code: BUNDLE, capabilities: fixtureHost(backend), expectedId: "example" });

      const before = await bridge.checkForUpdates!(["solo"]);
      expect(before.solo).toEqual({ latestChapterId: "solo-1", chapterCount: 1 });

      catalog[0]!.chapters.push({ id: "solo-2", name: "Two", number: 2, pages: 2 });
      const after = await bridge.checkForUpdates!(["solo"]);
      expect(after.solo).toEqual({ latestChapterId: "solo-2", chapterCount: 2 });
    });
  });
});
