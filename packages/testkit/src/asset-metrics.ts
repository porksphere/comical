/**
 * Thumbnail/asset metrics for the bridge audit: fetch a sample of cover/page-thumbnail images and
 * measure their byte size + pixel dimensions, so a nightly run can surface (and regress-check)
 * "average cover size" per bridge — the thing that would have caught a bridge silently serving
 * full-res originals per card.
 *
 * The image-size PARSER (`parseImageSize`) is pure (bytes in, dimensions out) so it's fully unit
 * testable with no network. Fetching is injected (`AssetFetcher`) so `conformance.ts` stays free of
 * `fetch` and can be pointed at any transport; `defaultAssetFetcher` is a convenience that uses the
 * global `fetch` (fine in a test/CI tool, unlike `@comical/core`). Byte size can't come through the
 * host's `network.request` capability — its `body` is decoded TEXT, which would corrupt binary — so
 * the fetcher reads the raw `ArrayBuffer` itself.
 */
import type { SeriesEntry } from "@comical/contract";

export type ImageFormat = "jpeg" | "png" | "webp" | "gif";

/** One measured asset. `width`/`height` are absent when the bytes couldn't be parsed. */
export interface AssetSample {
  url: string;
  bytes: number;
  contentType?: string;
  width?: number;
  height?: number;
  format?: ImageFormat;
}

/** Fetch a single asset and report its size. Return `undefined` on a non-OK / failed fetch. */
export type AssetFetcher = (url: string) => Promise<AssetSample | undefined>;

export interface AssetMetrics {
  /** URLs we successfully fetched + measured. */
  sampled: number;
  /** URLs that failed to fetch (network/non-OK) — distinct from fetched-but-unparseable. */
  failed: number;
  bytes: { min: number; max: number; avg: number; median: number; total: number };
  /** Present when at least one sample's dimensions parsed. */
  dimensions?: { avgWidth: number; avgHeight: number; maxWidth: number; maxHeight: number };
  /** Aspect = width/height, over the samples whose dimensions parsed. */
  aspect?: { min: number; max: number; avg: number };
  /** Raw samples, for a detailed report / debugging. */
  samples: AssetSample[];
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;

/**
 * Read an image's pixel dimensions straight from its header bytes — JPEG, PNG, WebP (lossy/lossless/
 * extended) and GIF. Returns `undefined` for an unrecognized/too-short buffer. Pure; no allocation
 * beyond a couple of reads.
 */
export function parseImageSize(b: Uint8Array): { width: number; height: number; format: ImageFormat } | undefined {
  if (b.length < 24) return undefined;

  // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR width@16 height@20 (big-endian).
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: u32be(b, 16), height: u32be(b, 20), format: "png" };
  }

  // GIF: "GIF", logical screen width@6 height@8 (little-endian).
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8), format: "gif" };
  }

  // WebP: RIFF....WEBP, then a VP8 / VP8L / VP8X chunk.
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    const fmt = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (fmt === "VP8 ") {
      // lossy: 14-bit width/height (little-endian) at 26/28.
      return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff, format: "webp" };
    }
    if (fmt === "VP8L") {
      // lossless: after the 0x2f byte at 20, 14-bit (w-1) then 14-bit (h-1).
      const b0 = b[21]!, b1 = b[22]!, b2 = b[23]!, b3 = b[24]!;
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width, height, format: "webp" };
    }
    if (fmt === "VP8X") {
      // extended: 24-bit (canvas w-1) @24, (h-1) @27 (little-endian).
      const width = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
      const height = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
      return { width, height, format: "webp" };
    }
  }

  // JPEG: FF D8, then scan for a Start-Of-Frame marker (SOF0..SOFn, excluding DHT/JPG/DAC/RSTn).
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: u16be(b, i + 5), width: u16be(b, i + 7), format: "jpeg" };
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2; // standalone markers (no length)
        continue;
      }
      i += 2 + u16be(b, i + 2); // skip this segment
    }
  }

  return undefined;
}

/** Convenience fetcher (global `fetch`) — reads the raw bytes and parses dimensions. CI/test use only. */
export const defaultAssetFetcher: AssetFetcher = async (url) => {
  const res = await fetch(url, { headers: { "user-agent": "comical-testkit-audit/1.0" } });
  if (!res.ok) return undefined;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const dim = parseImageSize(bytes);
  const sample: AssetSample = { url, bytes: bytes.byteLength };
  const ct = res.headers.get("content-type");
  if (ct) sample.contentType = ct;
  if (dim) {
    sample.width = dim.width;
    sample.height = dim.height;
    sample.format = dim.format;
  }
  return sample;
};

const median = (nums: number[]): number => {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};
const avg = (nums: number[]): number => (nums.length ? Math.round(nums.reduce((a, c) => a + c, 0) / nums.length) : 0);

/**
 * Fetch + measure the first `sampleSize` distinct `thumbnailUrl`s across `items` and aggregate their
 * byte size / dimensions / aspect. Deduped so a repeated cover isn't double-counted.
 */
export async function measureThumbnails(
  items: readonly SeriesEntry[],
  fetchAsset: AssetFetcher,
  opts: { sampleSize?: number } = {},
): Promise<AssetMetrics> {
  const sampleSize = opts.sampleSize ?? 8;
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const url = it.thumbnailUrl;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= sampleSize) break;
  }

  const samples: AssetSample[] = [];
  let failed = 0;
  for (const url of urls) {
    try {
      const s = await fetchAsset(url);
      if (s) samples.push(s);
      else failed++;
    } catch {
      failed++;
    }
  }

  const sizes = samples.map((s) => s.bytes);
  const dims = samples.filter((s) => s.width && s.height) as (AssetSample & { width: number; height: number })[];
  const metrics: AssetMetrics = {
    sampled: samples.length,
    failed,
    bytes: {
      min: sizes.length ? Math.min(...sizes) : 0,
      max: sizes.length ? Math.max(...sizes) : 0,
      avg: avg(sizes),
      median: median(sizes),
      total: sizes.reduce((a, c) => a + c, 0),
    },
    samples,
  };
  if (dims.length) {
    metrics.dimensions = {
      avgWidth: avg(dims.map((d) => d.width)),
      avgHeight: avg(dims.map((d) => d.height)),
      maxWidth: Math.max(...dims.map((d) => d.width)),
      maxHeight: Math.max(...dims.map((d) => d.height)),
    };
    const aspects = dims.map((d) => d.width / d.height);
    metrics.aspect = {
      min: Math.min(...aspects),
      max: Math.max(...aspects),
      avg: Number(avg(aspects.map((a) => a * 100)) / 100),
    };
  }
  return metrics;
}
