/**
 * Tests for the SDK cursor helpers. These exist so a bridge author never hand-rolls cursor encoding,
 * so the properties that matter are: a structured value survives the round trip, a *bad* cursor
 * degrades to "start over" instead of throwing at a user mid-scroll, and an oversized cursor fails
 * loudly at the author rather than silently at the host boundary.
 */
import { describe, expect, test } from "bun:test";
import { CURSOR_MAX_LENGTH, cursorSchema } from "@comical/contract";
import {
  decodeCursor,
  encodeCursor,
  nextOffsetCursor,
  nextPageCursor,
  offsetFromCursor,
  pageFromCursor,
} from "../src/cursor.ts";

describe("encodeCursor / decodeCursor", () => {
  test("round-trips a structured value", () => {
    const state = { offset: 40, section: "trending", seen: ["a", "b"] };
    // `decodeCursor` can't infer its type argument from a cursor string, so callers state it — that
    // is the whole reason a bridge's own resume shape stays typed on the way back out.
    expect(decodeCursor<typeof state>(encodeCursor(state))).toEqual(state);
  });

  test("round-trips non-ASCII content (UTF-8, not latin-1)", () => {
    // A real cursor can carry a query or a title fragment, so multi-byte characters must survive.
    const state = { q: "ダンジョン飯", tag: "café" };
    expect(decodeCursor<typeof state>(encodeCursor(state))).toEqual(state);
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

describe("offsetFromCursor / nextOffsetCursor", () => {
  test("an absent cursor is offset 0", () => {
    expect(offsetFromCursor(undefined)).toBe(0);
  });

  test("a cursor from nextOffsetCursor reads back as the next window's offset", () => {
    expect(offsetFromCursor(nextOffsetCursor(0, 20, 100)!)).toBe(20);
    expect(offsetFromCursor(nextOffsetCursor(80, 10, 100)!)).toBe(90);
  });

  test("no cursor once the window reaches the total", () => {
    expect(nextOffsetCursor(80, 20, 100)).toBeUndefined();
    // A backend that over-reports the window still terminates rather than walking past the end.
    expect(nextOffsetCursor(90, 20, 100)).toBeUndefined();
  });

  test("an empty window ends the walk even when total claims more remain", () => {
    // The alternative is a cursor equal to the one just used — the infinite scroll loop.
    expect(nextOffsetCursor(40, 0, 100)).toBeUndefined();
  });

  test("an unreadable or nonsensical offset falls back to 0", () => {
    for (const bad of [encodeCursor({}), encodeCursor({ offset: "20" }), encodeCursor({ offset: -1 }), encodeCursor({ offset: 2.5 }), "garbage"]) {
      expect(offsetFromCursor(bad)).toBe(0);
    }
  });

  test("walks an offset/total backend to the end without repeating", () => {
    const total = 25;
    const limit = 10;
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let hop = 0; hop < 10; hop++) {
      const offset = offsetFromCursor(cursor);
      const rows = Array.from({ length: Math.min(limit, total - offset) }, (_, i) => offset + i);
      seen.push(...rows);
      cursor = nextOffsetCursor(offset, rows.length, total);
      if (!cursor) break;
    }

    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i));
    expect(new Set(seen).size).toBe(total);
  });
});
