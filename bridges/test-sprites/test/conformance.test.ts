/**
 * Verifies the sprite-test bridge's page geometry. It makes no network requests (a `direct` gallery
 * of two host-served sprite sheets), so it runs against a bare `mockHost` — the assertions pin the
 * uniform + variable sprite-thumbnail metadata that the sheets in host-server's router encode.
 */
import { describe, expect, test } from "bun:test";
import type { Bridge } from "@comical/contract";
import { mockHost } from "@comical/testkit";
import factory from "../src/index.ts";

function load(): Bridge {
  return factory(mockHost({ handle: () => { throw new Error("test-sprites makes no requests"); } }));
}

describe("test-sprites", () => {
  test("getLists → a single gallery list", async () => {
    const lists = await load().getLists!();
    expect(lists).toEqual([{ id: "all", name: "Test Gallery" }]);
  });

  test("getSeriesPages → 40 pages, all sprite thumbnails (20 uniform + 20 variable)", async () => {
    const pages = await load().getSeriesPages!("test-series");
    expect(pages.length).toBe(40);
    expect(pages.map((p) => p.index)).toEqual(Array.from({ length: 40 }, (_, i) => i));
    for (const p of pages) expect(p.thumbnail?.kind).toBe("sprite");

    // Uniform cell 0: 200×289 at x=0, sheet 20 cells wide.
    const u0 = pages[0]!.thumbnail;
    expect(u0?.kind === "sprite" && u0).toMatchObject({
      sheetUrl: "/test-sprite.svg", x: 0, w: 200, h: 289, sheetWidth: 4000, sheetHeight: 289,
    });

    // Variable tile 0 (page 20): 120×300 at x=0. Tile 1 (page 21): 160×250 at x=120 (prev width).
    const v0 = pages[20]!.thumbnail;
    expect(v0?.kind === "sprite" && v0).toMatchObject({ sheetUrl: "/test-sprite-var.svg", x: 0, w: 120, h: 300 });
    const v1 = pages[21]!.thumbnail;
    expect(v1?.kind === "sprite" && v1).toMatchObject({ x: 120, w: 160, h: 250 });
  });

  test("getSeriesDetails → the sprite test gallery", async () => {
    const info = await load().getSeriesDetails!("test-series");
    expect(info.title).toBe("Sprite Test Gallery");
  });
});
