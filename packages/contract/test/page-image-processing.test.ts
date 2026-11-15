/**
 * The page-image processing shapes: byte transforms, layouts, the `images.process` declaration, and
 * the image route's `process` parameter.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_PAGE_IMAGE_OPS,
  bridgeImagePath,
  bridgeImagesSchema,
  decodePageLayout,
  encodePageLayout,
  pageByteTransformSchema,
  pageImageLayoutSchema,
  parseBridgeImagePath,
} from "../src/index.ts";

describe("pageByteTransformSchema", () => {
  test("xor and aes-ctr, with an optional range", () => {
    expect(pageByteTransformSchema.safeParse({ kind: "xor", key: "AAEC" }).success).toBe(true);
    expect(pageByteTransformSchema.safeParse({ kind: "xor", key: "AAEC", offset: 4, length: 100 }).success).toBe(true);
    expect(pageByteTransformSchema.safeParse({ kind: "aes-ctr", key: "AAAAAAAAAAAAAAAAAAAAAA==", counter: "AAAAAAAAAAAAAAAAAAAAAA==" }).success).toBe(true);
  });
  test("rejects unknown kinds, empty or non-base64 keys, negative ranges", () => {
    for (const bad of [
      { kind: "rot13" },
      { kind: "xor", key: "" },
      { kind: "xor", key: "not base64!" },
      { kind: "xor", key: "AA==", offset: -1 },
      { kind: "aes-ctr", key: "AA==" },
    ]) {
      expect(pageByteTransformSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("pageImageLayoutSchema", () => {
  const copy = { op: "copy", src: { x: 0, y: 0, w: 10, h: 10 }, dst: { x: 10, y: 0, w: 10, h: 10 } };
  test("a size and copy operations", () => {
    expect(pageImageLayoutSchema.safeParse({ width: 20, height: 10, ops: [copy] }).success).toBe(true);
    expect(pageImageLayoutSchema.safeParse({ width: 20, height: 10, ops: [] }).success).toBe(true);
  });
  test("rejects unknown operations, fractional or empty rects, oversized outputs and op lists", () => {
    for (const bad of [
      { width: 20, height: 10, ops: [{ ...copy, op: "rotate" }] },
      { width: 20, height: 10, ops: [{ ...copy, src: { x: 0.5, y: 0, w: 10, h: 10 } }] },
      { width: 20, height: 10, ops: [{ ...copy, dst: { x: 0, y: 0, w: 0, h: 10 } }] },
      { width: 40_000, height: 10, ops: [] },
      { width: 20, height: 10, ops: Array.from({ length: MAX_PAGE_IMAGE_OPS + 1 }, () => copy) },
    ]) {
      expect(pageImageLayoutSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("images.process", () => {
  test("declares bytes, layout or both — never neither", () => {
    expect(bridgeImagesSchema.safeParse({ hosts: ["cdn.example"], process: { layout: true } }).success).toBe(true);
    expect(bridgeImagesSchema.safeParse({ hosts: ["cdn.example"], process: { bytes: true, layout: true } }).success).toBe(true);
    expect(bridgeImagesSchema.safeParse({ hosts: ["cdn.example"], process: {} }).success).toBe(false);
  });
});

describe("image route process parameter", () => {
  test("round-trips a page's context", () => {
    const path = bridgeImagePath("b", "https://cdn.example/1.webp", { context: { k: "v&w" } });
    expect(parseBridgeImagePath(path)).toEqual({ bridgeId: "b", url: "https://cdn.example/1.webp", process: { context: { k: "v&w" } } });
  });
  test("no context is an empty one; no mark is no processing", () => {
    expect(parseBridgeImagePath(bridgeImagePath("b", "https://x/1", {}))?.process).toEqual({ context: {} });
    expect(parseBridgeImagePath(bridgeImagePath("b", "https://x/1"))?.process).toBeUndefined();
  });
  test("a malformed parameter is ignored, the path still parses", () => {
    expect(parseBridgeImagePath("/bridges/b/image?url=https%3A%2F%2Fx%2F1&process=%7Bnope")).toEqual({ bridgeId: "b", url: "https://x/1" });
  });
});

describe("layout header", () => {
  const layout = {
    width: 20,
    height: 10,
    ops: [
      { op: "copy" as const, src: { x: 10, y: 0, w: 10, h: 10 }, dst: { x: 0, y: 0, w: 10, h: 10 } },
      { op: "copy" as const, src: { x: 0, y: 0, w: 10, h: 10 }, dst: { x: 10, y: 0, w: 10, h: 10 } },
    ],
  };
  test("round-trips", () => {
    expect(encodePageLayout(layout)).toBe("20,10;c:10,0,10,10,0,0,10,10;c:0,0,10,10,10,0,10,10");
    expect(decodePageLayout(encodePageLayout(layout))).toEqual(layout);
    expect(decodePageLayout(encodePageLayout({ width: 5, height: 5, ops: [] }))).toEqual({ width: 5, height: 5, ops: [] });
  });
  test("a maximal layout stays well under a 16 KB header budget", () => {
    const big = { width: 32_000, height: 32_000, ops: Array.from({ length: MAX_PAGE_IMAGE_OPS }, () => ({ op: "copy" as const, src: { x: 31_000, y: 31_000, w: 999, h: 999 }, dst: { x: 31_000, y: 31_000, w: 999, h: 999 } })) };
    expect(encodePageLayout(big).length).toBeLessThan(12_000);
  });
  test("malformed or unknown operations decode to nothing", () => {
    for (const bad of [null, "", "20", "20,10;x:1,2,3,4,5,6,7,8", "20,10;c:1,2,3", "20,10;c:-1,0,1,1,0,0,1,1", "0,10"]) {
      expect(decodePageLayout(bad)).toBeUndefined();
    }
  });
});
