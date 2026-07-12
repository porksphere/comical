import { describe, expect, test } from "bun:test";
import type { BridgeInfo } from "@comical/contract";
import { filterBridgesByNsfw } from "../src/discover.ts";

// The `registry publish --nsfw <true|false>` flag threads a `nsfwFilter` boolean into
// `filterBridgesByNsfw`, which is what actually decides which bridges land in a rating-specific
// registry. These cases pin that contract: SFW-only, NSFW-only, and no-filter (default).

function bridge(id: string, nsfw: boolean): { info: Pick<BridgeInfo, "nsfw">; id: string } {
  return { id, info: { nsfw } };
}

const MIXED = [
  bridge("sfw-one", false),
  bridge("sfw-two", false),
  bridge("nsfw-one", true),
  bridge("nsfw-two", true),
];

describe("filterBridgesByNsfw", () => {
  test("--nsfw false keeps only SFW bridges", () => {
    expect(filterBridgesByNsfw(MIXED, false).map((b) => b.id)).toEqual(["sfw-one", "sfw-two"]);
  });

  test("--nsfw true keeps only NSFW bridges", () => {
    expect(filterBridgesByNsfw(MIXED, true).map((b) => b.id)).toEqual(["nsfw-one", "nsfw-two"]);
  });

  test("no filter keeps every bridge (default publish behavior)", () => {
    expect(filterBridgesByNsfw(MIXED, undefined)).toBe(MIXED);
    expect(filterBridgesByNsfw(MIXED, undefined).map((b) => b.id)).toEqual([
      "sfw-one",
      "sfw-two",
      "nsfw-one",
      "nsfw-two",
    ]);
  });

  test("returns empty when no bridge matches the requested rating", () => {
    const sfwOnly = [bridge("sfw-one", false), bridge("sfw-two", false)];
    expect(filterBridgesByNsfw(sfwOnly, true)).toEqual([]);
  });
});
