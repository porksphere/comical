/**
 * Tests for the SDK cursor helpers. These exist so a bridge author never hand-rolls cursor encoding,
 * so the properties that matter are: a structured value survives the round trip, a *bad* cursor
 * degrades to "start over" instead of throwing at a user mid-scroll, and an oversized cursor fails
 * loudly at the author rather than silently at the host boundary.
 */
import { describe, expect, test } from "bun:test";
import { CURSOR_MAX_LENGTH, cursorSchema } from "@comical/contract";
import { decodeCursor, encodeCursor, nextPageCursor, pageFromCursor } from "../src/cursor.ts";

describe("encodeCursor / decodeCursor", () => {
  test("round-trips a structured value", () => {
    const state = { offset: 40, section: "trending", seen: ["a", "b"] };
    expect(decodeCursor(encodeCursor(state))).toEqual(state);
  });

  test("round-trips non-ASCII content (UTF-8, not latin-1)", () => {
    // A real cursor can carry a query or a title fragment, so multi-byte characters must survive.
    const state = { q: "ダンジョン飯", tag: "café" };
    expect(decodeCursor(encodeCursor(state))).toEqual(state);
  });

  test("produces a cursor the contract schema accepts", () => {
    const cursor = encodeCursor({ page: 2 });
    expect(cursorSchema.safeParse(cursor).success).toBe(true);
    // base64url + unpadded: safe in a query string with no escaping.
    expect(cursor).not.toMatch(/[+/=]/);
  });

  test("throws with actionable guidance when the value is too big to be a token", () => {
    const huge = { blob: "x".repeat(CURSOR_MAX_LENGTH) };
    expect(() => encodeCursor(huge)).toThrow(/over the 4096 limit.*host\.storage/s);
  });

  test("decodes undefined as undefined (the first page)", () => {
    expect(decodeCursor(undefined)).toBeUndefined();
  });

  test("decodes a malformed cursor as undefined rather than throwing", () => {
    // A stale or truncated cursor (an old client, a hand-edited URL) restarts the walk.
    for (const bad of ["not-base64url-!!!", "eyJwYWdl", "%%%%"]) {
      expect(decodeCursor(bad)).toBeUndefined();
    }
  });
});

describe("pageFromCursor / nextPageCursor", () => {
  test("an absent cursor is page 1", () => {
    expect(pageFromCursor(undefined)).toBe(1);
  });

  test("a cursor from nextPageCursor reads back as the following page", () => {
    const c2 = nextPageCursor(1, true)!;
    expect(pageFromCursor(c2)).toBe(2);
    expect(pageFromCursor(nextPageCursor(pageFromCursor(c2), true)!)).toBe(3);
  });

  test("nextPageCursor returns undefined on the last page", () => {
    expect(nextPageCursor(7, false)).toBeUndefined();
  });

  test("an unreadable or nonsensical page falls back to 1 instead of a bad request", () => {
    for (const bad of [encodeCursor({}), encodeCursor({ page: "2" }), encodeCursor({ page: 0 }), encodeCursor({ page: 1.5 }), encodeCursor({ page: -3 }), "garbage"]) {
      expect(pageFromCursor(bad)).toBe(1);
    }
  });

  test("walks a fixed-size backend to the end without repeating or looping", () => {
    // Models the canonical migration pattern from the `nextPageCursor` docs.
    const total = 7;
    const perPage = 3;
    const fetchPage = (page: number) => {
      const start = (page - 1) * perPage;
      return { items: Array.from({ length: Math.min(perPage, total - start) }, (_, i) => start + i), more: start + perPage < total };
    };

    const seen: number[] = [];
    let cursor: string | undefined;
    for (let hop = 0; hop < 10; hop++) {
      const page = pageFromCursor(cursor);
      const { items, more } = fetchPage(page);
      seen.push(...items);
      cursor = nextPageCursor(page, more);
      if (!cursor) break;
    }

    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(cursor).toBeUndefined();
  });
});
