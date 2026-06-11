/**
 * Schema tests for the per-page `thumbnailUrl` (the cheaper preview variant). The field is optional
 * and additive — older bridges that omit it must still parse.
 */
import { describe, expect, test } from "bun:test";
import { pageSchema } from "../src/models.ts";

describe("pageSchema thumbnailUrl", () => {
  test("accepts a valid absolute thumbnailUrl", () => {
    const page = pageSchema.parse({
      index: 0,
      imageUrl: "https://i.example.test/galleries/1/1.jpg",
      thumbnailUrl: "https://t.example.test/galleries/1/1t.jpg",
    });
    expect(page.thumbnailUrl).toBe("https://t.example.test/galleries/1/1t.jpg");
  });

  test("parses when thumbnailUrl is omitted (backward-compatible)", () => {
    const page = pageSchema.parse({ index: 3, imageUrl: "https://i.example.test/3.jpg" });
    expect(page.thumbnailUrl).toBeUndefined();
  });

  test("rejects a non-URL thumbnailUrl", () => {
    expect(() =>
      pageSchema.parse({ index: 0, imageUrl: "https://i.example.test/0.jpg", thumbnailUrl: "not-a-url" }),
    ).toThrow();
  });
});
