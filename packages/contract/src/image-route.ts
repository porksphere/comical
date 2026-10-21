/**
 * The host protocol's image route: `/bridges/:id/image?url=<original>`. Hosts rewrite a bridge's
 * image URL into it when loading the image needs something a client can't do on its own (see
 * `BridgeInfo.images`); the route then applies the bridge's headers and interceptor at fetch time.
 *
 * The original URL rides in the path, so the path is as stable as the bridge's own URL: it can be
 * persisted (library covers, download manifests) and re-intercepted on every later fetch.
 */

/** The server-relative image-route path serving `url` on behalf of bridge `bridgeId`. */
export function bridgeImagePath(bridgeId: string, url: string): string {
  return `/bridges/${encodeURIComponent(bridgeId)}/image?url=${encodeURIComponent(url)}`;
}

/** The bridge and original URL behind an image-route path (absolute or server-relative), or undefined. */
export function parseBridgeImagePath(path: string): { bridgeId: string; url: string } | undefined {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/?#]*)?\/bridges\/([^/?#]+)\/image\?(?:[^#]*&)?url=([^&#]+)/i.exec(path);
  if (!m) return undefined;
  try {
    return { bridgeId: decodeURIComponent(m[1]!), url: decodeURIComponent(m[2]!) };
  } catch {
    return undefined;
  }
}
