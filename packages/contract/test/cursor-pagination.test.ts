/**
 * Schema tests for cursor pagination — `cursorSchema`, `pagedResultsSchema`, `pagedRequestSchema`.
 *
 * The contract deliberately carries no page number and no `hasNextPage`: a cursor either exists (there
 * is more, and this is how to get it) or it doesn't (that was the last page), so the two can never
 * disagree. These tests pin that shape plus the `CURSOR_MAX_LENGTH` ceiling, which is what keeps a
 * bridge from smuggling bulk resume state through the host.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  CURSOR_MAX_LENGTH,
  cursorSchema,
  pagedRequestSchema,
  pagedResultsSchema,
  seriesEntrySchema,
} from "../src/models.ts";

const entryPage = pagedResultsSchema(seriesEntrySchema);
const entry = { id: "s1", title: "First" };

describe("cursorSchema", () => {
  test("accepts an opaque non-empty string of any shape", () => {
    // The host never interprets a cursor, so base64url, JSON, an offset, or a signed token all pass.
    for (const c of ["2", "eyJwYWdlIjoyfQ", "offset:40|section:trending", "a-_~."]) {
      expect(cursorSchema.parse(c)).toBe(c);
    }
  });

  test("rejects an empty string — absence is expressed by omitting the field, not by \"\"", () => {
    expect(cursorSchema.safeParse("").success).toBe(false);
  });

  test("accepts exactly CURSOR_MAX_LENGTH and rejects one char more", () => {
    expect(cursorSchema.safeParse("x".repeat(CURSOR_MAX_LENGTH)).success).toBe(true);
    expect(cursorSchema.safeParse("x".repeat(CURSOR_MAX_LENGTH + 1)).success).toBe(false);
  });

  test("rejects non-strings", () => {
    for (const bad of [2, null, {}, ["2"]]) expect(cursorSchema.safeParse(bad).success).toBe(false);
  });
});

describe("pagedResultsSchema", () => {
  test("a last page is just items — no nextCursor, no page number, no hasNextPage", () => {
    const parsed = entryPage.parse({ items: [entry] });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.nextCursor).toBeUndefined();
    expect("page" in parsed).toBe(false);
    expect("hasNextPage" in parsed).toBe(false);
  });

  test("a non-last page carries the token for the following page", () => {
    expect(entryPage.parse({ items: [entry], nextCursor: "2" }).nextCursor).toBe("2");
  });

  test("an empty page is legal (a search with no hits)", () => {
    expect(entryPage.parse({ items: [] }).items).toEqual([]);
  });

  test("strips the retired page/hasNextPage fields instead of carrying them through", () => {
    // A bridge built against the old contract must not have stale pagination smuggled to the host.
    const parsed = entryPage.parse({ items: [entry], page: 1, hasNextPage: true });
    expect(parsed).toEqual({ items: [entry] });
  });

  test("rejects an unusable nextCursor (empty or over the ceiling)", () => {
    expect(entryPage.safeParse({ items: [], nextCursor: "" }).success).toBe(false);
    expect(entryPage.safeParse({ items: [], nextCursor: "x".repeat(CURSOR_MAX_LENGTH + 1) }).success).toBe(false);
  });

  test("rejects a missing items array", () => {
    expect(entryPage.safeParse({ nextCursor: "2" }).success).toBe(false);
  });

  test("validates the item type it was built with", () => {
    const numbers = pagedResultsSchema(z.number());
    expect(numbers.parse({ items: [1, 2] }).items).toEqual([1, 2]);
    expect(numbers.safeParse({ items: ["1"] }).success).toBe(false);
  });
});

describe("pagedRequestSchema", () => {
  test("an absent cursor means \"start from the beginning\"", () => {
    expect(pagedRequestSchema.parse({}).cursor).toBeUndefined();
  });

  test("round-trips a cursor the bridge previously emitted", () => {
    expect(pagedRequestSchema.parse({ cursor: "eyJwYWdlIjozfQ" }).cursor).toBe("eyJwYWdlIjozfQ");
  });

  test("rejects an over-long cursor at the request boundary too", () => {
    expect(pagedRequestSchema.safeParse({ cursor: "x".repeat(CURSOR_MAX_LENGTH + 1) }).success).toBe(false);
  });
});
