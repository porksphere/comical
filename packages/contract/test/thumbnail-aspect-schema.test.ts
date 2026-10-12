/**
 * Schema tests for `thumbnailAspect` — the optional cover width / height a bridge sends next to
 * `thumbnailUrl` (on both `SeriesEntry` and `SeriesInfo`) so clients can size card rows before any
 * image loads. Additive: entries without it must still parse, and a nonsense ratio is dropped
 * without failing the entry it rode in on (it's only a layout hint).
 */
import { describe, expect, test } from "bun:test";
import { seriesEntrySchema, seriesInfoSchema, thumbnailAspectSchema } from "../src/models.ts";

describe("thumbnailAspect", () => {
  test("accepts portrait and landscape ratios on an entry and on series info", () => {
    expect(seriesEntrySchema.parse({ id: "1", title: "T", thumbnailUrl: "http://x/a.jpg", thumbnailAspect: 250 / 353 }).thumbnailAspect).toBeCloseTo(0.708, 3);
    expect(seriesInfoSchema.parse({ id: "1", title: "T", thumbnailUrl: "http://x/a.jpg", thumbnailAspect: 250 / 176 }).thumbnailAspect).toBeCloseTo(1.42, 2);
  });

  test("is optional (backward-compatible)", () => {
    expect(seriesEntrySchema.parse({ id: "1", title: "T", thumbnailUrl: "http://x/a.jpg" }).thumbnailAspect).toBeUndefined();
  });

  test("rejects zero, negative, infinite and non-numeric ratios — by dropping them, not the entry", () => {
    for (const bad of [0, -0.7, Infinity, Number.NaN, "0.7"]) {
      expect(thumbnailAspectSchema.safeParse(bad).success).toBe(false);
      const entry = seriesEntrySchema.parse({ id: "1", title: "T", thumbnailUrl: "http://x/a.jpg", thumbnailAspect: bad });
      expect(entry.thumbnailAspect).toBeUndefined();
      expect(entry.thumbnailUrl).toBe("http://x/a.jpg");
      expect(seriesInfoSchema.parse({ id: "1", title: "T", thumbnailAspect: bad }).thumbnailAspect).toBeUndefined();
    }
  });
});
