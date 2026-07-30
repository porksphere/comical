/**
 * Schema tests for the `shareUrl` field on `seriesInfoSchema`.
 */
import { describe, expect, test } from "bun:test";
import { seriesInfoSchema } from "../src/models.ts";

describe("seriesInfoSchema shareUrl", () => {
  test("parses series detail with a shareUrl", () => {
    const info = seriesInfoSchema.parse({ id: "1", title: "T", shareUrl: "https://example.test/series/1" });
    expect(info.shareUrl).toBe("https://example.test/series/1");
  });

  test("parses series detail with no shareUrl (backward-compatible)", () => {
    expect(seriesInfoSchema.parse({ id: "1", title: "T" }).shareUrl).toBeUndefined();
  });

  test("rejects an empty shareUrl", () => {
    expect(() => seriesInfoSchema.parse({ id: "1", title: "T", shareUrl: "" })).toThrow();
  });
});
