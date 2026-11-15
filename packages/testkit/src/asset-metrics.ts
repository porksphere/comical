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
import { type BridgeImages, parseBridgeImagePath, type SeriesEntry } from "@comical/contract";
import { imageSize, type ImageFormat } from "@comical/core/page-images";

export type { ImageFormat };

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
/** What to send with an asset request: the headers a bridge declared for its image host. */
export interface AssetRequest {
  headers?: Record<string, string>;
}

export type AssetFetcher = (url: string, init?: AssetRequest) => Promise<AssetSample | undefined>;

/**
 * Where, and with which headers, the host's image route would fetch a thumbnail. A bridge whose images
 * need headers gets its thumbnails rewritten to the route (`/bridges/:id/image?url=…`), a relative path
 * nothing outside the host can fetch; this unwraps the original URL and adds the bridge's declared
 * `images.headers` when its host is covered, as the route does. Any other URL is returned as is.
 */
export function resolveThumbnail(url: string, images?: BridgeImages): { url: string; headers?: Record<string, string> } {
  const target = parseBridgeImagePath(url)?.url ?? url;
  let host = "";
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch {
    return { url: target };
  }
  const covered = images?.hosts.some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`));
  return covered && images?.headers ? { url: target, headers: images.headers } : { url: target };
}

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

/**
 * Parse an image's pixel dimensions + format from its header bytes — core's `imageSize`, which the
 * image route also uses to measure a page before it is laid out. Undefined for an
 * unrecognized/too-short buffer.
 */
export const parseImageSize: (b: Uint8Array) => { width: number; height: number; format: ImageFormat } | undefined = imageSize;

/** Convenience fetcher (global `fetch`) — reads the raw bytes and parses dimensions. CI/test use only. */
export const defaultAssetFetcher: AssetFetcher = async (url, init) => {
  const res = await fetch(url, { headers: { "user-agent": "comical-testkit-audit/1.0", ...(init?.headers ?? {}) } });
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
  opts: { sampleSize?: number; images?: BridgeImages } = {},
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
      const resolved = resolveThumbnail(url, opts.images);
      const s = await fetchAsset(resolved.url, resolved.headers ? { headers: resolved.headers } : undefined);
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
