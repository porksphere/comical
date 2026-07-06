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
