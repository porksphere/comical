/**
 * Schema tests for the descriptive metadata on `seriesInfoSchema` beyond the core fields:
 * `altTitles`, the normalized `rating`, and the print-only `infoCells`. All three are additive, so
 * each also checks that a detail without it still parses.
 */
import { describe, expect, test } from "bun:test";
import { infoCellSchema, seriesInfoSchema, seriesRatingSchema } from "../src/models.ts";

const BASE = { id: "s1", title: "Series One" };

describe("seriesInfoSchema altTitles", () => {
  test("parses a list of other names, in any script", () => {
    const info = seriesInfoSchema.parse({ ...BASE, altTitles: ["Series Un", "シリーズ・ワン"] });
    expect(info.altTitles).toEqual(["Series Un", "シリーズ・ワン"]);
  });

  test("parses with no altTitles (backward-compatible)", () => {
    expect(seriesInfoSchema.parse(BASE).altTitles).toBeUndefined();
  });

  test("accepts an empty list", () => {
    expect(seriesInfoSchema.parse({ ...BASE, altTitles: [] }).altTitles).toEqual([]);
  });

  test("rejects an empty name", () => {
    expect(() => seriesInfoSchema.parse({ ...BASE, altTitles: ["Series Un", ""] })).toThrow();
  });

  test("rejects a bare string", () => {
    expect(() => seriesInfoSchema.parse({ ...BASE, altTitles: "Series Un" })).toThrow();
  });
});

describe("seriesRatingSchema", () => {
  test("accepts a score with a vote count", () => {
    expect(seriesRatingSchema.parse({ score: 0.79, votes: 312 })).toEqual({ score: 0.79, votes: 312 });
  });

  test("accepts a score alone", () => {
    expect(seriesRatingSchema.parse({ score: 0.5 }).votes).toBeUndefined();
  });

  test("accepts both ends of the scale", () => {
    expect(seriesRatingSchema.parse({ score: 0 }).score).toBe(0);
    expect(seriesRatingSchema.parse({ score: 1 }).score).toBe(1);
  });

  test("rejects a score left on its source's scale", () => {
    for (const score of [7.9, 4, 80, -0.1]) {
      expect(() => seriesRatingSchema.parse({ score })).toThrow();
    }
  });

  test("rejects a missing or non-finite score", () => {
    expect(() => seriesRatingSchema.parse({ votes: 3 })).toThrow();
    expect(() => seriesRatingSchema.parse({ score: Number.NaN })).toThrow();
  });

  test("accepts zero votes, rejects negative or fractional counts", () => {
    expect(seriesRatingSchema.parse({ score: 0.5, votes: 0 }).votes).toBe(0);
    expect(() => seriesRatingSchema.parse({ score: 0.5, votes: -1 })).toThrow();
    expect(() => seriesRatingSchema.parse({ score: 0.5, votes: 1.5 })).toThrow();
  });
});

describe("seriesInfoSchema rating", () => {
  test("parses series detail with a rating", () => {
    const info = seriesInfoSchema.parse({ ...BASE, rating: { score: 0.8, votes: 10 } });
    expect(info.rating).toEqual({ score: 0.8, votes: 10 });
  });

  test("parses with no rating (backward-compatible, and how an unrated series is sent)", () => {
    expect(seriesInfoSchema.parse(BASE).rating).toBeUndefined();
  });

  test("rejects a bare number", () => {
    expect(() => seriesInfoSchema.parse({ ...BASE, rating: 0.8 })).toThrow();
  });

  test("is independent of contentRating", () => {
    const info = seriesInfoSchema.parse({ ...BASE, rating: { score: 0.8 }, contentRating: "mature" });
    expect(info.rating?.score).toBe(0.8);
    expect(info.contentRating).toBe("mature");
  });
});

describe("infoCellSchema", () => {
  test("accepts a label/value pair", () => {
    expect(infoCellSchema.parse({ label: "Year", value: "2023" })).toEqual({ label: "Year", value: "2023" });
  });

  test("rejects an empty label or value", () => {
    expect(() => infoCellSchema.parse({ label: "", value: "2023" })).toThrow();
    expect(() => infoCellSchema.parse({ label: "Year", value: "" })).toThrow();
  });

  test("rejects a non-string value — the bridge formats, the client prints", () => {
    expect(() => infoCellSchema.parse({ label: "Year", value: 2023 })).toThrow();
  });

  test("caps label and value length", () => {
    expect(infoCellSchema.parse({ label: "x".repeat(32), value: "y".repeat(80) }).label).toHaveLength(32);
    expect(() => infoCellSchema.parse({ label: "x".repeat(33), value: "y" })).toThrow();
    expect(() => infoCellSchema.parse({ label: "x", value: "y".repeat(81) })).toThrow();
  });
});

describe("seriesInfoSchema infoCells", () => {
  test("parses cells and keeps the bridge's order", () => {
    const infoCells = [
      { label: "Year", value: "2023" },
      { label: "Views", value: "716.5K" },
    ];
    expect(seriesInfoSchema.parse({ ...BASE, infoCells }).infoCells).toEqual(infoCells);
  });

  test("parses with no infoCells (backward-compatible)", () => {
    expect(seriesInfoSchema.parse(BASE).infoCells).toBeUndefined();
  });

  test("allows a repeated label", () => {
    const infoCells = [
      { label: "Publisher", value: "One" },
      { label: "Publisher", value: "Two" },
    ];
    expect(seriesInfoSchema.parse({ ...BASE, infoCells }).infoCells).toHaveLength(2);
  });

  test("caps the list at twelve cells", () => {
    const cells = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `L${i}`, value: `V${i}` }));
    expect(seriesInfoSchema.parse({ ...BASE, infoCells: cells(12) }).infoCells).toHaveLength(12);
    expect(() => seriesInfoSchema.parse({ ...BASE, infoCells: cells(13) })).toThrow();
  });

  test("rejects a malformed cell", () => {
    expect(() => seriesInfoSchema.parse({ ...BASE, infoCells: [{ label: "Year" }] })).toThrow();
  });
});
