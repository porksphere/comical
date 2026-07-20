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

describe("seriesEntrySchema thumbnailUrl", () => {
  test("accepts an absolute URL", () => {
    const entry = seriesEntrySchema.parse({ id: "1", title: "T", thumbnailUrl: "https://cdn/x.jpg" });
    expect(entry.thumbnailUrl).toBe("https://cdn/x.jpg");
  });

  test("accepts a server-relative path (e.g. an /img-proxy cover for a Referer-gated CDN)", () => {
    const entry = seriesEntrySchema.parse({ id: "1", title: "T", thumbnailUrl: "/img-proxy?url=https%3A%2F%2Fx%2Fy.webp" });
    expect(entry.thumbnailUrl).toBe("/img-proxy?url=https%3A%2F%2Fx%2Fy.webp");
  });

  test("still rejects an empty thumbnailUrl", () => {
    expect(() => seriesEntrySchema.parse({ id: "1", title: "T", thumbnailUrl: "" })).toThrow();
  });
});

describe("seriesEntrySchema card badges", () => {
  test("parses badges with text, position and tone", () => {
    const entry = seriesEntrySchema.parse({
      id: "1",
      title: "T",
      badges: [{ text: "EN", position: "top-right", tone: "info" }],
    });
    expect(entry.badges).toEqual([{ text: "EN", position: "top-right", tone: "info" }]);
  });

  test("position and tone are optional (text alone is valid)", () => {
    const entry = seriesEntrySchema.parse({ id: "1", title: "T", badges: [{ text: "NEW" }] });
    expect(entry.badges?.[0]).toEqual({ text: "NEW" });
  });

  test("parses an entry with no badges (backward-compatible)", () => {
    expect(seriesEntrySchema.parse({ id: "1", title: "T" }).badges).toBeUndefined();
  });

  test("rejects an empty badge label", () => {
    expect(() => seriesEntrySchema.parse({ id: "1", title: "T", badges: [{ text: "" }] })).toThrow();
  });

  test("rejects an unknown badge position", () => {
    expect(() =>
      seriesEntrySchema.parse({ id: "1", title: "T", badges: [{ text: "x", position: "middle" }] }),
    ).toThrow();
  });

  test("caps the number of badges at four", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ text: `b${i}` }));
    expect(() => seriesEntrySchema.parse({ id: "1", title: "T", badges: five })).toThrow();
  });
});

describe("exclusion plumbing exports", () => {
  test('the reserved settings key is "excludedTags"', () => {
    expect(EXCLUDED_TAGS_KEY).toBe("excludedTags");
  });

  test('"exclude-tags" is a recognized capability', () => {
    expect(bridgeCapabilitySchema.parse("exclude-tags")).toBe("exclude-tags");
  });

  test('"resolve-tags" is a recognized capability', () => {
    expect(bridgeCapabilitySchema.parse("resolve-tags")).toBe("resolve-tags");
  });
});
