/**
 * Schema tests for `creditSchema` and the `authors`/`artists` arrays on `seriesInfoSchema` — the
 * additive multi-credit form. Each credit is a name with an optional bridge-namespaced id (the
 * precise filter value when present). `author`/`artist` (+ `*Id`) remain the single-value
 * convenience form; the arrays are optional and additive, so older bridges that omit them still parse.
 */
import { describe, expect, test } from "bun:test";
import { creditSchema, seriesInfoSchema } from "../src/models.ts";

describe("creditSchema", () => {
  test("parses a credit with name + id", () => {
    expect(creditSchema.parse({ name: "Ada", id: "auth-1" })).toEqual({ name: "Ada", id: "auth-1" });
  });

  test("id is optional (name alone is valid)", () => {
    expect(creditSchema.parse({ name: "Ada" })).toEqual({ name: "Ada" });
  });

  test("rejects an empty name", () => {
    expect(() => creditSchema.parse({ name: "" })).toThrow();
  });

  test("rejects an empty id (omit it instead)", () => {
    expect(() => creditSchema.parse({ name: "Ada", id: "" })).toThrow();
  });
});

describe("seriesInfoSchema authors/artists", () => {
  test("parses multi-credit authors and artists with ids", () => {
    const info = seriesInfoSchema.parse({
      id: "s1",
      title: "S",
      author: "Ada, Bram",
      authorId: "auth-1",
      authors: [{ name: "Ada", id: "auth-1" }, { name: "Bram", id: "auth-2" }],
      artists: [{ name: "Cora" }],
    });
    expect(info.authors).toHaveLength(2);
    expect(info.authors?.[1]).toEqual({ name: "Bram", id: "auth-2" });
    expect(info.artists?.[0]).toEqual({ name: "Cora" });
  });

  test("parses detail with the arrays omitted (backward-compatible single-value form)", () => {
    const info = seriesInfoSchema.parse({ id: "s1", title: "S", author: "Solo", authorId: "x" });
    expect(info.authors).toBeUndefined();
    expect(info.artists).toBeUndefined();
    expect(info.author).toBe("Solo");
  });

  test("rejects a malformed credit inside the array", () => {
    expect(() =>
      seriesInfoSchema.parse({ id: "s1", title: "S", authors: [{ name: "" }] }),
    ).toThrow();
  });
});
