/**
 * Blob path conventions shared by every download host. The manifest's `file` field is a path
 * RELATIVE to a per-host blob root (device documents dir, server data dir) so manifests survive the
 * root moving (iOS container paths change across app updates; a server's dataDir is configurable).
 * These helpers are the single source of truth for that layout — a host that derives paths any other
 * way orphans bytes.
 *
 * Layout: `<bridge>/<series>/<chapter>/<index>.<ext>`, every id segment sanitized.
 */

/**
 * A "direct" (chapterless) series' pages are filed under this reserved chapter id — readers model
 * directness as a boolean, so the sentinel never leaks into UI.
 */
export const DIRECT_CHAPTER_ID = "__direct__";

/** Filesystem-safe path segment. Bridge/series/chapter ids can contain arbitrary characters. */
export function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** The relative manifest path for a page: `<bridge>/<series>/<chapter>/<index>.<ext>`. */
export function relPathFor(bridgeId: string, seriesId: string, chapterId: string, index: number, ext: string): string {
  return `${sanitizeSegment(bridgeId)}/${sanitizeSegment(seriesId)}/${sanitizeSegment(chapterId)}/${index}.${ext}`;
}

/**
 * Guess a file extension from a `data:` URI's media type, a bare mime type (e.g. a response
 * `Content-Type`), or a URL's path — defaulting to `img` when nothing matches.
 */
export function extFor(resolvedOrMime: string): string {
  const mime = resolvedOrMime.startsWith("data:")
    ? resolvedOrMime.slice(5, resolvedOrMime.indexOf(";"))
    : /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(resolvedOrMime.split(";")[0]?.trim() ?? "")
      ? resolvedOrMime
      : "";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("avif")) return "avif";
  const m = resolvedOrMime.split("?")[0]?.match(/\.([a-zA-Z0-9]{1,5})$/);
  return m?.[1]?.toLowerCase() ?? "img";
}

/** The mime type to serve a stored blob with, from its manifest `file` extension. */
export function contentTypeFor(relPath: string): string {
  const ext = relPath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "avif":
      return "image/avif";
    default:
      return "application/octet-stream";
  }
}
