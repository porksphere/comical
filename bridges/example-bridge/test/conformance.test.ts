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
    expect(results.items[0]!.thumbnailUrl).toStartWith("http://fixture.local/img/");
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
});
