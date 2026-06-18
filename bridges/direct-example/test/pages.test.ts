/**
 * Unit tests for the direct-read bridge's page parsing. Drives the bridge factory against the
 * `DirectFixtureBackend` through a mock host (no bundle), focusing on the new per-page thumbnail.
 */
import { describe, expect, test } from "bun:test";
import type { Bridge } from "@comical/contract";
import { DirectFixtureBackend, mockHost } from "@comical/testkit";
import factory from "../src/index.ts";

function load(backend = new DirectFixtureBackend()): Bridge {
  return factory(
    mockHost({
      handle: (req) => backend.handle(req),
      settings: { baseUrl: "http://fixture.local" },
    }),
  );
}

describe("direct-example getSeriesPages", () => {
  test("returns one page per image with an absolute imageUrl", async () => {
    const bridge = load();
    const pages = await bridge.getSeriesPages!("raven"); // catalog: 6 pages
    expect(pages.length).toBe(6);
    expect(pages.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const p of pages) expect(p.imageUrl).toStartWith("https://picsum.photos/seed/");
  });

  test("parses a cheaper image thumbnail distinct from the full imageUrl", async () => {
    const bridge = load();
    const pages = await bridge.getSeriesPages!("raven");
    for (const p of pages) {
      expect(p.thumbnail?.kind).toBe("image");
      const url = p.thumbnail?.kind === "image" ? p.thumbnail.url : "";
      expect(url).toStartWith("https://picsum.photos/seed/");
      // Thumb is the small variant; the full page image is 700x1000.
      expect(url).toContain("/160/220");
      expect(p.imageUrl).toContain("/700/1000");
      expect(url).not.toBe(p.imageUrl);
    }
  });

  test("omits thumbnail when the backend exposes no data-thumb", async () => {
    // A backend whose pages carry no data-thumb attribute (legacy bridges / no thumb CDN).
    const noThumb = new DirectFixtureBackend();
    const orig = noThumb.handle.bind(noThumb);
    noThumb.handle = (req) => {
      const res = orig(req);
      if (typeof res.body === "string" && res.body.includes("data-thumb")) {
        res.body = res.body.replace(/\sdata-thumb="[^"]*"/g, "");
      }
      return res;
    };
    const bridge = load(noThumb);
    const pages = await bridge.getSeriesPages!("raven");
    expect(pages.length).toBe(6);
    for (const p of pages) expect(p.thumbnail).toBeUndefined();
  });
});
