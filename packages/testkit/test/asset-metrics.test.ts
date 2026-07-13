/**
 * Unit tests for the thumbnail-metrics probe: the pure image-size parser (header bytes → dimensions),
 * the aggregation (dedupe/skip/failures), and the evaluateBridge integration (metrics only when a
 * fetcher is injected). No network — fetching is mocked.
 */
import { describe, expect, test } from "bun:test";
import type { Bridge, BridgeInfo, SeriesEntry } from "@comical/contract";
import { evaluateBridge } from "../src/conformance.ts";
import { measureThumbnails, parseImageSize, type AssetFetcher } from "../src/asset-metrics.ts";

// Minimal header fixtures, all encoding 100×150.
function png(): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8); // IHDR len + tag
  b.set([0, 0, 0, 100], 16); // width BE
  b.set([0, 0, 0, 150], 20); // height BE
  return b;
}
function jpeg(): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0); // SOI, SOF0, len, precision
  b.set([0, 150], 7); // height BE @7
  b.set([0, 100], 9); // width BE @9
  return b;
}
function gif(): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
  b.set([100, 0], 6); // width LE
  b.set([150, 0], 8); // height LE
  return b;
}
function webpVP8X(): Uint8Array {
  const b = new Uint8Array(32);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  b.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  b.set([99, 0, 0], 24); // (width-1) LE
  b.set([149, 0, 0], 27); // (height-1) LE
  return b;
}

describe("parseImageSize", () => {
  test("PNG", () => expect(parseImageSize(png())).toEqual({ width: 100, height: 150, format: "png" }));
  test("JPEG", () => expect(parseImageSize(jpeg())).toEqual({ width: 100, height: 150, format: "jpeg" }));
  test("GIF", () => expect(parseImageSize(gif())).toEqual({ width: 100, height: 150, format: "gif" }));
  test("WebP (VP8X)", () => expect(parseImageSize(webpVP8X())).toEqual({ width: 100, height: 150, format: "webp" }));
  test("too short / unrecognized → undefined", () => {
    expect(parseImageSize(new Uint8Array(10))).toBeUndefined();
    expect(parseImageSize(new Uint8Array(40))).toBeUndefined(); // long enough but no signature
  });
});

describe("measureThumbnails", () => {
  const items: SeriesEntry[] = [
    { id: "a", title: "A", thumbnailUrl: "https://x/a.webp" },
    { id: "b", title: "B", thumbnailUrl: "https://x/b.webp" },
    { id: "c", title: "C", thumbnailUrl: "https://x/a.webp" }, // duplicate URL → deduped
    { id: "d", title: "D" }, // no thumbnail → skipped
  ];
  const fetcher: AssetFetcher = async (url) =>
    url.endsWith("a.webp") ? { url, bytes: 1000, width: 100, height: 150 } : { url, bytes: 3000, width: 200, height: 300 };

  test("aggregates bytes + dimensions, dedupes URLs, skips missing thumbnails", async () => {
    const m = await measureThumbnails(items, fetcher);
    expect(m.sampled).toBe(2); // a + b only
    expect(m.failed).toBe(0);
    expect(m.bytes).toMatchObject({ min: 1000, max: 3000, avg: 2000, total: 4000 });
    expect(m.dimensions).toMatchObject({ maxWidth: 200, maxHeight: 300 });
    expect(m.aspect?.avg).toBeCloseTo(0.667, 1);
  });

  test("counts fetch failures (non-OK ⇒ undefined)", async () => {
    const m = await measureThumbnails(items, async () => undefined);
    expect(m.sampled).toBe(0);
    expect(m.failed).toBe(2);
    expect(m.dimensions).toBeUndefined();
  });

  test("honours sampleSize", async () => {
    const m = await measureThumbnails(items, fetcher, { sampleSize: 1 });
    expect(m.sampled).toBe(1);
  });
});

describe("evaluateBridge — metrics integration", () => {
  const info: BridgeInfo = {
    id: "t",
    name: "T",
    version: "0.0.0",
    contractVersion: "1.0.0",
    languages: ["en"],
    nsfw: false,
    capabilities: ["search"],
  };
  const bridge = {
    info,
    getSearchResults: async (_q: string, page: number) => ({
      items: [{ id: "a", title: "A", thumbnailUrl: "https://x/a.png" }],
      page,
      hasNextPage: false,
    }),
    getSeriesDetails: async (id: string) => ({ id, title: "A", author: "x", description: "d", genres: ["g"], status: "completed" }),
    getChapters: async () => [{ id: "c1", name: "C1", number: 1 }],
    getChapterPages: async () => [{ index: 0, imageUrl: "https://x/0.png" }],
  } as unknown as Bridge;

  test("no fetchAsset ⇒ no metrics", async () => {
    const r = await evaluateBridge(bridge);
    expect(r.metrics).toBeUndefined();
  });

  test("fetchAsset ⇒ metrics measured over the exercised items", async () => {
    const r = await evaluateBridge(bridge, { fetchAsset: async (url) => ({ url, bytes: 500, width: 100, height: 150 }) });
    expect(r.metrics?.sampled).toBe(1);
    expect(r.metrics?.bytes.avg).toBe(500);
    expect(r.summary.verdict).toBe("pass"); // metrics never affect the conformance verdict
  });
});
