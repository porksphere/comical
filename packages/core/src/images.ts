/**
 * A bridge's image requests (`BridgeInfo.images`, contract 2.1), the two halves every host shares:
 *
 *  - {@link createImageRouter} — applied by the loader to what a bridge returns: an image URL whose
 *    host needs headers or interception becomes the host's image route (`bridgeImagePath`), every
 *    other URL is left for the client to load directly.
 *  - {@link resolveImageRequest} — run by that route at fetch time: refuses anything off the
 *    bridge's declared hosts, runs the interceptor where declared, and merges the headers.
 */
import {
  bridgeImagePath,
  type BridgeImages,
  type BridgeInfo,
  type ImageRequest,
  type Page,
  type PageThumbnail,
} from "@comical/contract";
import { ComicalError } from "./errors.ts";
import { findHostRule, hostOf } from "./net/url-match.ts";

/** An image request the bridge's `images` declaration doesn't allow — never fetched (SSRF boundary). */
export class ImageRequestRefusedError extends ComicalError {
  override readonly name = "ImageRequestRefusedError";
}

/** The http(s) host of `url` when it is on one of `images.hosts`, else undefined. */
function allowedHost(images: BridgeImages, url: string): string | undefined {
  if (!/^https?:\/\//i.test(url)) return undefined;
  const host = hostOf(url);
  return host !== undefined && findHostRule(host, images.hosts) !== -1 ? host : undefined;
}

function intercepts(images: BridgeImages, host: string): boolean {
  return images.intercept !== undefined && findHostRule(host, images.intercept) !== -1;
}

/** Whether a client can't load `url` by itself: it is on a declared host that needs headers or interception. */
export function needsImageRoute(images: BridgeImages | undefined, url: string): boolean {
  if (!images) return false;
  const host = allowedHost(images, url);
  if (host === undefined) return false;
  return intercepts(images, host) || Object.keys(images.headers ?? {}).length > 0;
}

/** Rewrites the image URLs in a bridge's results, in place. */
export interface ImageRouter {
  url(url: string): string;
  entry<T extends { thumbnailUrl?: string | undefined }>(item: T): T;
  pages(pages: Page[]): Page[];
  thumbnail(thumbnail: PageThumbnail): PageThumbnail;
}

/** The router for a bridge's results, or undefined when it declares no `images` (nothing to rewrite). */
export function createImageRouter(info: Pick<BridgeInfo, "id" | "images">): ImageRouter | undefined {
  const images = info.images;
  if (!images) return undefined;
  const url = (u: string) => (needsImageRoute(images, u) ? bridgeImagePath(info.id, u) : u);
  const thumbnail = (t: PageThumbnail): PageThumbnail => {
    if (t.kind === "image") t.url = url(t.url);
    else t.sheetUrl = url(t.sheetUrl);
    return t;
  };
  return {
    url,
    entry(item) {
      if (item.thumbnailUrl !== undefined) item.thumbnailUrl = url(item.thumbnailUrl);
      return item;
    },
    pages(pages) {
      for (const p of pages) {
        p.imageUrl = url(p.imageUrl);
        if (p.thumbnail) thumbnail(p.thumbnail);
      }
      return pages;
    },
    thumbnail,
  };
}

/** The request a host makes for one image: where to fetch it, and with which headers. */
export interface ResolvedImageRequest {
  url: string;
  /** Static `images.headers`, overridden by the interceptor's. Empty when the image needs none. */
  headers: Record<string, string>;
}

/**
 * Resolve an image URL a bridge emitted into the request to make for it. `intercept` is the
 * bridge's `interceptImageRequest`; it is only called for an intercepted host, so a host can pass
 * a function that loads the bridge lazily and skip that load for every other image.
 *
 * Throws {@link ImageRequestRefusedError} for a URL — original or intercepted — off the declared
 * hosts. Whatever the interceptor throws (a rate-limited error included) propagates as is.
 */
export async function resolveImageRequest(
  info: Pick<BridgeInfo, "id" | "images">,
  url: string,
  intercept?: (url: string) => Promise<ImageRequest>,
): Promise<ResolvedImageRequest> {
  const images = info.images;
  if (!images) throw new ImageRequestRefusedError(`bridge "${info.id}" declares no image hosts`);
  const host = allowedHost(images, url);
  if (host === undefined) {
    throw new ImageRequestRefusedError(`${hostOf(url) ?? "url"} is not an image host of bridge "${info.id}"`);
  }
  let target = url;
  let extra: Record<string, string> = {};
  if (intercepts(images, host)) {
    if (!intercept) throw new ImageRequestRefusedError(`bridge "${info.id}" intercepts ${host} but has no interceptImageRequest`);
    const req = await intercept(url);
    if (allowedHost(images, req.url) === undefined) {
      throw new ImageRequestRefusedError(
        `bridge "${info.id}" intercepted ${host} to ${hostOf(req.url) ?? "a url"}, which is not one of its image hosts`,
      );
    }
    target = req.url;
    extra = req.headers ?? {};
  }
  return { url: target, headers: mergeHeaders(images.headers ?? {}, extra) };
}

/** `base` overridden by `over`, matching names case-insensitively (HTTP header names are). */
function mergeHeaders(base: Record<string, string>, over: Record<string, string>): Record<string, string> {
  const overridden = new Set(Object.keys(over).map((k) => k.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (!overridden.has(k.toLowerCase())) out[k] = v;
  return Object.assign(out, over);
}
