/**
 * Schema tests for the `excluded` flag on `seriesEntrySchema` and the reserved exclusion plumbing
 * (`EXCLUDED_TAGS_KEY`, the `"exclude-tags"` capability). A bridge with the capability redacts an
 * entry that matched the user's persistent tag exclusions by setting `excluded: true` with a neutral
 * placeholder title and no cover. The field is optional and additive — older bridges that omit it
 * must still parse.
 */
import { describe, expect, test } from "bun:test";
import {
  EXCLUDED_TAGS_KEY,
  bridgeCapabilitySchema,
  genreExclusionsSchema,
  seriesEntrySchema,
} from "../src/models.ts";

describe("seriesEntrySchema excluded flag", () => {
  test("accepts a redacted placeholder entry (excluded, no cover, placeholder title)", () => {
    const entry = seriesEntrySchema.parse({ id: "1", title: "Hidden", excluded: true });
    expect(entry.excluded).toBe(true);
    expect(entry.thumbnailUrl).toBeUndefined();
  });

  test("parses a normal entry when excluded is omitted (backward-compatible)", () => {
    const entry = seriesEntrySchema.parse({ id: "2", title: "Real Title" });
    expect(entry.excluded).toBeUndefined();
  });

  test("still requires a non-empty title even for a redacted entry", () => {
    expect(() => seriesEntrySchema.parse({ id: "3", title: "", excluded: true })).toThrow();
  });

  test("rejects a non-boolean excluded", () => {
    expect(() => seriesEntrySchema.parse({ id: "4", title: "x", excluded: "yes" })).toThrow();
  });
});

describe("exclusion plumbing exports", () => {
  test('the reserved settings key is "excludedTags"', () => {
    expect(EXCLUDED_TAGS_KEY).toBe("excludedTags");
  });

  test('"exclude-tags" is a recognized capability', () => {
    expect(bridgeCapabilitySchema.parse("exclude-tags")).toBe("exclude-tags");
  });

  test('"exclude-genres" is a recognized capability', () => {
    expect(bridgeCapabilitySchema.parse("exclude-genres")).toBe("exclude-genres");
  });

  test('"resolve-tags" is a recognized capability', () => {
    expect(bridgeCapabilitySchema.parse("resolve-tags")).toBe("resolve-tags");
  });
});

describe("genreExclusionsSchema", () => {
  test("parses available genres + the excluded subset", () => {
    const state = genreExclusionsSchema.parse({
      available: [{ id: "39", label: "Action" }, { id: "44", label: "Horror" }],
      excluded: ["44"],
    });
    expect(state.available).toHaveLength(2);
    expect(state.excluded).toEqual(["44"]);
  });

  test("accepts an empty exclusion set", () => {
    expect(genreExclusionsSchema.parse({ available: [], excluded: [] }).excluded).toEqual([]);
  });

  test("rejects a malformed available entry", () => {
    expect(() => genreExclusionsSchema.parse({ available: [{ id: "1" }], excluded: [] })).toThrow();
  });
});
