/**
 * The standard `PageResolver` for engines that run BEHIND the comical router (the standalone server
 * and the embedded RN host alike): resolve a chapter's page list by driving the host's own
 * `/bridges/...` routes in-process — the same late-bound-fetch trick the hosts' `PageFetcher`s use —
 * so bridge lookup, configuration checks, and the reserved direct-chapter mapping are reused, never
 * reimplemented. Platform-agnostic: the host supplies the fetch; nothing here touches the network.
 */
import type { DownloadPageInput } from "./downloads.ts";
import type { PageResolver } from "./engine.ts";
import { DIRECT_CHAPTER_ID } from "./paths.ts";

/** The slice of a fetch response the resolver needs (satisfied by `Response` and the RN transport). */
export interface ResolverResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** The wire shape of the router's page routes (`Page.imageUrl` + optional fetch headers). */
interface WirePage {
  index: number;
  imageUrl: string;
  headers?: Record<string, string>;
}

/**
 * Build a {@link PageResolver} over a host-supplied path fetch. `fetchPath` receives a
 * server-relative path (`/bridges/...`) and must answer with the host router's response — late-bind
 * it when the router and engine reference each other at composition time.
 */
export function createRouterPageResolver(
  fetchPath: (path: string) => Promise<ResolverResponse>,
): PageResolver {
  return async ({ bridgeId, seriesId, chapterId }) => {
    const base = `/bridges/${encodeURIComponent(bridgeId)}/series/${encodeURIComponent(seriesId)}`;
    const path =
      chapterId === DIRECT_CHAPTER_ID
        ? `${base}/pages`
        : `${base}/chapters/${encodeURIComponent(chapterId)}/pages`;
    const res = await fetchPath(path);
    if (!res.ok) throw new Error(`page resolution failed: ${res.status}`);
    const pages = (await res.json()) as WirePage[];
    if (!Array.isArray(pages) || pages.length === 0) {
      throw new Error("page resolution returned no pages");
    }
    return [...pages]
      .sort((a, b) => a.index - b.index)
      .map(
        (p): DownloadPageInput => ({
          index: p.index,
          sourceUrl: p.imageUrl,
          ...(p.headers && { headers: p.headers }),
        }),
      );
  };
}
