import { describe, expect, test } from "bun:test";
import { pageImageLayoutSchema } from "@comical/contract";
import { stripLayout, tileLayout } from "../src/index.ts";

describe("tileLayout", () => {
  test("order[dest] is the source tile; the remainder is copied through first", () => {
    // 101 × 51 in 2 × 2: tiles are 50 × 25, with a 1 px column and row left over.
    const layout = tileLayout(101, 51, 2, 2, [3, 2, 1, 0]);
    expect(layout.width).toBe(101);
    expect(layout.height).toBe(51);
    expect(layout.ops).toEqual([
      { op: "copy", src: { x: 100, y: 0, w: 1, h: 51 }, dst: { x: 100, y: 0, w: 1, h: 51 } },
      { op: "copy", src: { x: 0, y: 50, w: 100, h: 1 }, dst: { x: 0, y: 50, w: 100, h: 1 } },
      { op: "copy", src: { x: 50, y: 25, w: 50, h: 25 }, dst: { x: 0, y: 0, w: 50, h: 25 } },
      { op: "copy", src: { x: 0, y: 25, w: 50, h: 25 }, dst: { x: 50, y: 0, w: 50, h: 25 } },
      { op: "copy", src: { x: 50, y: 0, w: 50, h: 25 }, dst: { x: 0, y: 25, w: 50, h: 25 } },
      { op: "copy", src: { x: 0, y: 0, w: 50, h: 25 }, dst: { x: 50, y: 25, w: 50, h: 25 } },
    ]);
    expect(pageImageLayoutSchema.safeParse(layout).success).toBe(true);
  });

  test("without keepEdges, exact grids, and too-small images", () => {
    expect(tileLayout(101, 51, 2, 2, [0, 1, 2, 3], { keepEdges: false }).ops).toHaveLength(4);
    expect(tileLayout(100, 50, 2, 2, [0, 1, 2, 3]).ops).toHaveLength(4);
    expect(tileLayout(1, 1, 2, 2, [0, 1, 2, 3]).ops).toEqual([]);
  });

  test("rejects an order that isn't a permutation", () => {
    expect(() => tileLayout(10, 10, 2, 2, [0, 1, 2])).toThrow(RangeError);
    expect(() => tileLayout(10, 10, 2, 2, [0, 1, 2, 2])).toThrow(RangeError);
  });
});

describe("stripLayout", () => {
  test("the last source strip takes the remainder and keeps it when moved", () => {
    const layout = stripLayout(10, 103, [3, 2, 1, 0]);
    expect(layout.ops.map((o) => [o.src.y, o.src.h, o.dst.y])).toEqual([
      [75, 28, 0],
      [50, 25, 28],
      [25, 25, 53],
      [0, 25, 78],
    ]);
    expect(layout.ops.reduce((n, o) => n + o.dst.h, 0)).toBe(103);
    expect(pageImageLayoutSchema.safeParse(layout).success).toBe(true);
  });

  test("rejects a bad order; too many strips for the height draws nothing", () => {
    expect(() => stripLayout(10, 10, [1, 1])).toThrow(RangeError);
    expect(stripLayout(10, 2, [2, 1, 0]).ops).toEqual([]);
  });
});
