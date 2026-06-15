/**
 * Schema tests for `relatedSeriesGroups` on `seriesInfoSchema` — the additive container for related
 * series surfaced on a detail page (sequels, spin-offs, "same universe", algorithmic similar /
 * recommended rails). Each group is a labeled, optionally-kinded list of full `SeriesEntry` cards.
 * The field is optional and additive — older bridges that omit it must still parse.
 */
import { describe, expect, test } from "bun:test";
import {
  relatedKindSchema,
  relatedSeriesGroupSchema,
  seriesInfoSchema,
} from "../src/models.ts";

describe("relatedSeriesGroupSchema", () => {
  test("parses a labeled, kinded group of series cards", () => {
    const grp = relatedSeriesGroupSchema.parse({
      label: "Spin-offs",
      kind: "spin-off",
      series: [{ id: "a", title: "Side Story" }],
    });
    expect(grp.label).toBe("Spin-offs");
    expect(grp.kind).toBe("spin-off");
    expect(grp.series).toHaveLength(1);
  });

  test("kind is optional (label drives display)", () => {
    const grp = relatedSeriesGroupSchema.parse({ label: "More", series: [{ id: "b", title: "B" }] });
    expect(grp.kind).toBeUndefined();
  });

  test("rejects an empty series array (omit the group instead)", () => {
    expect(() => relatedSeriesGroupSchema.parse({ label: "Empty", series: [] })).toThrow();
  });

  test("rejects an empty label", () => {
    expect(() => relatedSeriesGroupSchema.parse({ label: "", series: [{ id: "c", title: "C" }] })).toThrow();
  });

  test("rejects an unknown kind", () => {
    expect(() =>
      relatedSeriesGroupSchema.parse({ label: "x", kind: "totally-made-up", series: [{ id: "d", title: "D" }] }),
    ).toThrow();
  });

  test("known kinds are recognized", () => {
    for (const k of ["sequel", "prequel", "same-universe", "similar", "recommended", "other"] as const) {
      expect(relatedKindSchema.parse(k)).toBe(k);
    }
  });
});

describe("seriesInfoSchema relatedSeriesGroups", () => {
  test("accepts multiple related groups (happy path)", () => {
    const info = seriesInfoSchema.parse({
      id: "s1",
      title: "Series One",
      relatedSeriesGroups: [
        { label: "Sequels", kind: "sequel", series: [{ id: "s2", title: "Series Two" }] },
        { label: "Similar", kind: "similar", series: [{ id: "s3", title: "Series Three", thumbnailUrl: "https://x/y.jpg" }] },
      ],
    });
    expect(info.relatedSeriesGroups).toHaveLength(2);
  });

  test("parses detail with the field omitted (backward-compatible)", () => {
    const info = seriesInfoSchema.parse({ id: "s1", title: "Series One" });
    expect(info.relatedSeriesGroups).toBeUndefined();
  });

  test("rejects a malformed group inside the array", () => {
    expect(() =>
      seriesInfoSchema.parse({
        id: "s1",
        title: "Series One",
        relatedSeriesGroups: [{ label: "Bad", series: [] }],
      }),
    ).toThrow();
  });
});
