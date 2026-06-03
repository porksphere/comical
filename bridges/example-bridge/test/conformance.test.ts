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
    const results = await bridge.getSearchResults!("", 1);
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
      genres: details.genres,
    }).toMatchSnapshot("sherlock-details");

    const chapters = await bridge.getChapters("sherlock");
    expect(chapters.map((c) => ({ id: c.id, name: c.name, number: c.number }))).toMatchSnapshot(
      "sherlock-chapters",
    );

    const pages = await bridge.getChapterPages("sherlock", "sherlock-1");
    expect(pages).toMatchSnapshot("sherlock-1-pages");
  });

  test("lists catalog + items (presentation-as-data)", async () => {
    const bridge = load();
    const lists = await bridge.getLists!();
    expect(lists.length).toBeGreaterThan(0);
    expect(lists[0]!.id).toBeTruthy();
    expect(lists[0]!.layout).toBe("carousel");
    expect(lists[0]!.featured).toBe(true);

    const items = await bridge.getListItems!(lists[0]!.id, 1);
    expect(items.items.length).toBeGreaterThan(0);
    expect(items.items[0]!.title).toBeTruthy();
  });

  test("search within a list narrows that list's items", async () => {
    const bridge = load();
    const lists = await bridge.getLists!();
    const popular = lists.find((l) => l.id === "popular")!;
    expect(popular.searchable).toBe(true);

    const all = await bridge.getListItems!("popular", 1);
    const scoped = await bridge.getListItems!("popular", 1, { query: "sherlock" });
    expect(scoped.items.length).toBeGreaterThan(0);
    expect(scoped.items.length).toBeLessThan(all.items.length);
    expect(scoped.items.every((i) => i.id === "sherlock")).toBe(true);
  });

  test("filters narrow results; sort (separate) orders them", async () => {
    const bridge = load();
    const filters = await bridge.getFilters!();
    expect(filters.find((f) => f.key === "genre")?.type).toBe("multiselect");
    const sorts = await bridge.getSortOptions!();
    expect(sorts.map((s) => s.key)).toContain("title");

    // Unfiltered returns the whole catalog; a genre filter narrows it (Sherlock is Mystery).
    const all = await bridge.getSearchResults!("", 1);
    const mystery = await bridge.getSearchResults!("", 1, { filters: [{ key: "genre", value: ["Mystery"] }] });
    expect(mystery.items.length).toBeGreaterThan(0);
    expect(mystery.items.length).toBeLessThan(all.items.length);
    expect(mystery.items.some((i) => i.id === "sherlock")).toBe(true);

    // Sort by title descending flips the order (sort lives in options.sort, not filters).
    const asc = await bridge.getSearchResults!("", 1, { sort: { key: "title", ascending: true } });
    const desc = await bridge.getSearchResults!("", 1, { sort: { key: "title", ascending: false } });
    expect(asc.items.map((i) => i.id).join()).toBe([...desc.items].reverse().map((i) => i.id).join());
  });

  test("favorites: round-trip add → list → remove (authenticated)", async () => {
    const backend = new FixtureBackend();
    const bridge = loadBridge({
      code: BUNDLE,
      capabilities: fixtureHost(backend, { sessionToken: "demo" }),
      expectedId: "example",
    });
    expect((await bridge.getFavorites!(1)).items.length).toBe(0);

    await bridge.addFavorite!("dracula");
    const after = await bridge.getFavorites!(1);
    expect(after.items.map((i) => i.id)).toContain("dracula");

    await bridge.removeFavorite!("dracula");
    expect((await bridge.getFavorites!(1)).items.map((i) => i.id)).not.toContain("dracula");
  });

  test("favorites require authentication (no sessionToken → throws)", async () => {
    const bridge = load(); // load() wires baseUrl but no sessionToken
    await expect(bridge.getFavorites!(1)).rejects.toThrow();
  });
});
