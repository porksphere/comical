/**
 * Schema tests for the per-page `thumbnail` descriptor (the cheaper preview variant). The field is
 * optional and additive — bridges that omit it must still parse — and is a discriminated union of
 * an `image` URL or `sprite` slice-metadata.
 */
import { describe, expect, test } from "bun:test";
import { pageSchema, pageThumbnailSchema } from "../src/models.ts";

describe("pageSchema thumbnail", () => {
  test("accepts an image thumbnail (absolute or server-relative url)", () => {
    const page = pageSchema.parse({
      index: 0,
      imageUrl: "https://i.example.test/galleries/1/1.jpg",
      thumbnail: { kind: "image", url: "https://t.example.test/1t.jpg" },
    });
    expect(page.thumbnail).toEqual({ kind: "image", url: "https://t.example.test/1t.jpg" });
  });

  test("accepts a sprite thumbnail (slice metadata) and defaults y to 0", () => {
    const page = pageSchema.parse({
      index: 0,
      imageUrl: "https://i.example.test/0.jpg",
      thumbnail: {
        kind: "sprite",
        sheetUrl: "/img-proxy?url=https%3A%2F%2Fcdn.example.net%2Ft%2Fsheet.webp",
        x: 400,
        w: 200,
        h: 289,
        sheetWidth: 4000,
        sheetHeight: 289,
      },
    });
    expect(page.thumbnail).toMatchObject({ kind: "sprite", x: 400, w: 200, h: 289, sheetWidth: 4000, y: 0 });
  });

  test("parses when thumbnail is omitted (backward-compatible)", () => {
    const page = pageSchema.parse({ index: 3, imageUrl: "https://i.example.test/3.jpg" });
    expect(page.thumbnail).toBeUndefined();
  });

  test("rejects an unknown thumbnail kind", () => {
    expect(() => pageThumbnailSchema.parse({ kind: "video", url: "x" })).toThrow();
  });

  test("rejects a sprite with non-positive tile dimensions", () => {
    expect(() =>
      pageThumbnailSchema.parse({ kind: "sprite", sheetUrl: "/s.webp", x: 0, w: 0, h: 289, sheetWidth: 4000 }),
    ).toThrow();
  });
});

describe("pageSchema scramble", () => {
  const page = (scramble: unknown) => pageSchema.safeParse({ index: 0, imageUrl: "https://i.example.test/0.webp", scramble });

  test("accepts a tile grid whose order is a permutation", () => {
    const r = page({ kind: "tiles", cols: 2, rows: 2, order: [3, 2, 1, 0] });
    expect(r.success).toBe(true);
    expect(r.success && r.data.scramble).toEqual({ kind: "tiles", cols: 2, rows: 2, order: [3, 2, 1, 0] });
  });

  test("accepts strips", () => {
    expect(page({ kind: "strips", order: [2, 1, 0] }).success).toBe(true);
  });

  test("parses when scramble is omitted (backward-compatible)", () => {
    expect(pageSchema.parse({ index: 0, imageUrl: "https://i.example.test/0.webp" }).scramble).toBeUndefined();
  });

  test("rejects an order that isn't a permutation", () => {
    for (const bad of [
      { kind: "tiles", cols: 2, rows: 2, order: [0, 1, 2] }, // too short
      { kind: "tiles", cols: 2, rows: 2, order: [0, 1, 2, 2] }, // repeat
      { kind: "tiles", cols: 2, rows: 2, order: [0, 1, 2, 4] }, // out of range
      { kind: "strips", order: [1, 1] },
      { kind: "strips", order: [] },
    ]) {
      expect(page(bad).success).toBe(false);
    }
  });

  test("rejects unknown kinds and absurd grids", () => {
    expect(page({ kind: "spiral", order: [0] }).success).toBe(false);
    expect(page({ kind: "tiles", cols: 0, rows: 2, order: [] }).success).toBe(false);
    expect(page({ kind: "tiles", cols: 100, rows: 1, order: Array.from({ length: 100 }, (_, i) => i) }).success).toBe(false);
  });
});
