/**
 * The server host's `PageFetcher`: turns a manifest `sourceUrl` into bytes for the download engine.
 *
 * Bridges emit two URL shapes, both handled here:
 *  - server-relative (`/img-proxy?url=…`, `/bridges/…/page-image/…`) — resolved by driving THIS
 *    server's own router in-process (the same trick `@comical/host-rn` uses), so the img-proxy
 *    allowlist/Referer rules and the lazy page-image resolver are reused, never reimplemented. A
 *    page-image 302 is followed manually with the page's own fetch headers.
 *  - absolute — fetched directly with the page's headers (referer/auth from the contract).
 *
 * `getFetch` is late-bound because the router and the engine reference each other at composition
 * time (the router mounts the engine's routes; the engine resolves pages through the router).
 */
import { createRouterPageResolver, type FetchedPage, type PageFetcher, type PageResolver } from "@comical/downloads";

/** Arbitrary in-process origin — the router matches on path only; nothing leaves the host. */
const ENGINE_ORIGIN = "http://downloads.comical.local";

/**
 * The server host's `PageResolver`: resolves a lazily-enqueued chapter's page list by driving this
 * server's own `/bridges/...` routes in-process (same late-bound fetch as the page fetcher), so the
 * bridge lookup / direct-chapter mapping live in one place — the router.
 */
export function createServerPageResolver(
  getFetch: () => (req: Request) => Response | Promise<Response>,
  /** The server's bearer token, if auth is enabled — in-process requests must pass their own guard. */
  token?: string,
): PageResolver {
  return createRouterPageResolver(async (path) =>
    getFetch()(
      new Request(`${ENGINE_ORIGIN}${path}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined),
    ),
  );
}

export function createServerPageFetcher(
  getFetch: () => (req: Request) => Response | Promise<Response>,
  /** The server's bearer token, if auth is enabled — in-process requests must pass their own guard. */
  token?: string,
): PageFetcher {
  return async (_ctx, page) => {
    if (!page.sourceUrl.startsWith("/")) return fetchBytes(page.sourceUrl, page.headers);

    const routed = await getFetch()(
      new Request(`${ENGINE_ORIGIN}${page.sourceUrl}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined),
    );
    // The lazy page-image resolver 302s to the upstream CDN URL — follow it with the page's headers.
    if (routed.status >= 300 && routed.status < 400) {
      const location = routed.headers.get("Location");
      if (!location) throw new Error("page resolver redirected without a Location");
      return fetchBytes(location, page.headers);
    }
    if (!routed.ok) throw new Error(`page route failed: ${routed.status}`);
    const data = new Uint8Array(await routed.arrayBuffer());
    return withContentType({ data }, routed.headers.get("Content-Type"));
  };
}

async function fetchBytes(url: string, headers?: Record<string, string>): Promise<FetchedPage> {
  const res = await fetch(url, headers ? { headers } : undefined);
  if (!res.ok) throw new Error(`page download failed: ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  return withContentType({ data }, res.headers.get("Content-Type"));
}

function withContentType(page: FetchedPage, contentType: string | null): FetchedPage {
  if (contentType) page.contentType = contentType;
  return page;
}
