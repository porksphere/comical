/**
 * Schema tests for per-item content rating: `contentRatingSchema`/`CONTENT_RATING_ORDER`, the
 * `contentRating` field on `seriesEntrySchema`/`seriesInfoSchema`, the reserved
 * `MAX_CONTENT_RATING_KEY` settings key, and the `"content-rating"` capability.
 */
import { describe, expect, test } from "bun:test";
import {
  CONTENT_RATING_ORDER,
  MAX_CONTENT_RATING_KEY,
  bridgeCapabilitySchema,
  contentRatingSchema,
  seriesEntrySchema,
  seriesInfoSchema,
} from "../src/models.ts";

describe("contentRatingSchema", () => {
  test("accepts the three tiers", () => {
    expect(contentRatingSchema.parse("everyone")).toBe("everyone");
    expect(contentRatingSchema.parse("mature")).toBe("mature");
    expect(contentRatingSchema.parse("adult")).toBe("adult");
  });

  test("rejects an unknown tier", () => {
    expect(() => contentRatingSchema.parse("explicit")).toThrow();
  });
});

describe("CONTENT_RATING_ORDER", () => {
  test("orders everyone < mature < adult", () => {
    expect(CONTENT_RATING_ORDER.everyone).toBeLessThan(CONTENT_RATING_ORDER.mature);
    expect(CONTENT_RATING_ORDER.mature).toBeLessThan(CONTENT_RATING_ORDER.adult);
  });
});

describe("seriesEntrySchema contentRating", () => {
  test("parses an entry with a contentRating", () => {
    const entry = seriesEntrySchema.parse({ id: "1", title: "T", contentRating: "mature" });
    expect(entry.contentRating).toBe("mature");
  });

  test("parses an entry with no contentRating (backward-compatible)", () => {
    expect(seriesEntrySchema.parse({ id: "1", title: "T" }).contentRating).toBeUndefined();
  });

  test("rejects an unknown contentRating", () => {
    expect(() => seriesEntrySchema.parse({ id: "1", title: "T", contentRating: "explicit" })).toThrow();
  });
});

describe("seriesInfoSchema contentRating", () => {
  test("parses series detail with a contentRating", () => {
    const info = seriesInfoSchema.parse({ id: "1", title: "T", contentRating: "adult" });
    expect(info.contentRating).toBe("adult");
  });

  test("parses series detail with no contentRating (backward-compatible)", () => {
    expect(seriesInfoSchema.parse({ id: "1", title: "T" }).contentRating).toBeUndefined();
  });
});

describe("content-rating plumbing exports", () => {
  test('the reserved settings key is "maxContentRating"', () => {
    expect(MAX_CONTENT_RATING_KEY).toBe("maxContentRating");
  });

  test('"content-rating" is a recognized capability', () => {
    expect(bridgeCapabilitySchema.parse("content-rating")).toBe("content-rating");
  });
});
