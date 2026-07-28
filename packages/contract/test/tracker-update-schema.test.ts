/**
 * Schema tests for the tracker push payload — `trackerEntryUpdateSchema` and the `trackerDateSchema`
 * it composes — plus `totalChapters` on `trackerLibraryEntrySchema`.
 *
 * These matter more than a typical shape test: the update is what leaves the host for a third-party
 * service, and the date fields are the one place the contract carries a *formatted* string rather
 * than a structured value. A wrong date reaching AniList's `FuzzyDateInput` parser or MAL's
 * `start_date` is a silently corrupted list entry, so the regex earns a rejection test of its own.
 */
import { describe, expect, test } from "bun:test";
import {
  trackerDateSchema,
  trackerEntryUpdateSchema,
  trackerLibraryEntrySchema,
} from "../src/tracker.ts";

describe("trackerDateSchema", () => {
  test("accepts a zero-padded calendar date", () => {
    expect(trackerDateSchema.parse("2026-07-04")).toBe("2026-07-04");
  });

  test("rejects an unpadded month or day — services parse fixed-width fields", () => {
    expect(() => trackerDateSchema.parse("2026-7-04")).toThrow();
    expect(() => trackerDateSchema.parse("2026-07-4")).toThrow();
  });

  test("rejects a full ISO instant — this field is a date, not a timestamp", () => {
    expect(() => trackerDateSchema.parse("2026-07-04T00:00:00.000Z")).toThrow();
  });

  test("rejects other orderings and separators", () => {
    for (const bad of ["04-07-2026", "2026/07/04", "20260704", "", "today"]) {
      expect(() => trackerDateSchema.parse(bad)).toThrow();
    }
  });
});

describe("trackerEntryUpdateSchema", () => {
  test("every field is optional — a status-only push sends no progress", () => {
    expect(trackerEntryUpdateSchema.parse({})).toEqual({});
    expect(trackerEntryUpdateSchema.parse({ status: "completed" })).toEqual({ status: "completed" });
  });

  test("parses a full payload", () => {
    const update = trackerEntryUpdateSchema.parse({
      status: "reading",
      chaptersRead: 12.5,
      score: 90,
      notes: "good",
      startedAt: "2026-07-04",
      finishedAt: "2026-07-27",
    });
    expect(update).toMatchObject({ status: "reading", chaptersRead: 12.5, startedAt: "2026-07-04" });
  });

  test("chaptersRead is decimal — chapter NUMBERS, not a count", () => {
    expect(trackerEntryUpdateSchema.parse({ chaptersRead: 3.5 }).chaptersRead).toBe(3.5);
  });

  test("rejects a status outside the enum", () => {
    expect(() => trackerEntryUpdateSchema.parse({ status: "finished" })).toThrow();
  });

  test("rejects a malformed date in either date field", () => {
    expect(() => trackerEntryUpdateSchema.parse({ startedAt: "2026-7-4" })).toThrow();
    expect(() => trackerEntryUpdateSchema.parse({ finishedAt: "yesterday" })).toThrow();
  });

  test("rejects a non-numeric chaptersRead", () => {
    expect(() => trackerEntryUpdateSchema.parse({ chaptersRead: "12" })).toThrow();
  });

  test("'rereading' is pushable — it is the status a completed entry gets on a re-read", () => {
    expect(trackerEntryUpdateSchema.parse({ status: "rereading" }).status).toBe("rereading");
  });
});

describe("trackerLibraryEntrySchema totalChapters", () => {
  test("parses an entry carrying the service's own chapter count", () => {
    const entry = trackerLibraryEntrySchema.parse({
      externalId: 111,
      title: "Series",
      status: "reading",
      chaptersRead: 65,
      totalChapters: 66,
    });
    expect(entry.totalChapters).toBe(66);
  });

  test("parses an entry without it (backward-compatible) — services often publish no total", () => {
    const entry = trackerLibraryEntrySchema.parse({ externalId: 111, title: "Series", status: "reading" });
    expect(entry.totalChapters).toBeUndefined();
  });

  test("rejects a zero or negative total — 'unknown' is expressed by omitting the field", () => {
    const base = { externalId: 111, title: "Series", status: "reading" as const };
    expect(() => trackerLibraryEntrySchema.parse({ ...base, totalChapters: 0 })).toThrow();
    expect(() => trackerLibraryEntrySchema.parse({ ...base, totalChapters: -5 })).toThrow();
  });

  test("rejects a fractional total — a count, unlike progress, is a whole number", () => {
    expect(() =>
      trackerLibraryEntrySchema.parse({ externalId: 111, title: "Series", status: "reading", totalChapters: 66.5 }),
    ).toThrow();
  });
});
