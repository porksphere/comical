/** Pure tracker-import matching helpers — the title rules, without a bridge or a library. */
import { describe, expect, test } from "bun:test";
import { MAX_IMPORT_CANDIDATES, matchSearchResults } from "@comical/runtime";
import { sharesName, trackerEntryNames } from "../src/tracker-import.ts";

const entry = (id: string, title: string) => ({ id, title });

describe("trackerEntryNames", () => {
  test("folds the title and every alternate title; drops names that fold to nothing", () => {
    const names = trackerEntryNames({ title: "Berserk!", altTitles: ["ベルセルク", "BERSERK", "..."] });
    expect(names.has("berserk")).toBe(true);
    expect(names.has("")).toBe(false);
    expect(names.size).toBe(2);
  });
});

describe("sharesName", () => {
  test("matches on the series' title or any alternate title", () => {
    const names = trackerEntryNames({ title: "Record of a Yokohama Shopping Trip" });
    expect(sharesName(names, { title: "Yokohama Kaidashi Kikou", altTitles: ["Record of a Yokohama Shopping Trip"] })).toBe(true);
    expect(sharesName(names, { title: "Yokohama Kaidashi Kikou" })).toBe(false);
  });
});

describe("matchSearchResults", () => {
  const names = trackerEntryNames({ title: "Berserk", altTitles: ["Berserk Max"] });

  test("the first exact-after-folding hit is `exact`; later exact hits ride along as candidates", () => {
    const results = [entry("a", "Berserk Colored"), entry("b", "BERSERK"), entry("c", "Berserk Max"), entry("d", "Berserk Guide")];
    const { exact, candidates } = matchSearchResults(names, results);
    expect(exact?.id).toBe("b");
    expect(candidates.map((r) => r.id)).toEqual(["a", "c", "d"]);
  });

  test("candidates keep the bridge's order and are capped", () => {
    const results = Array.from({ length: 10 }, (_, i) => entry(`r${i}`, `Berserk ${i}`));
    const { exact, candidates } = matchSearchResults(names, results);
    expect(exact).toBeUndefined();
    expect(candidates.length).toBe(MAX_IMPORT_CANDIDATES);
    expect(candidates.map((r) => r.id)).toEqual(["r0", "r1", "r2"]);
  });

  test("a confirmed result is taken as exact without a title test", () => {
    const results = [entry("a", "Something Else"), entry("b", "Another")];
    const { exact, candidates } = matchSearchResults(names, results, results[0]);
    expect(exact?.id).toBe("a");
    expect(candidates.map((r) => r.id)).toEqual(["b"]);
  });

  test("no results → no exact, no candidates", () => {
    expect(matchSearchResults(names, [])).toEqual({ candidates: [] });
  });
});
