/**
 * The host protocol's image route: `/bridges/:id/image?url=<original>`. Hosts rewrite a bridge's
 * image URL into it when loading the image needs something a client can't do on its own (see
 * `BridgeInfo.images`); the route then applies the bridge's headers and interceptor at fetch time.
 *
 * The original URL rides in the path, so the path is as stable as the bridge's own URL: it can be
 * persisted (library covers, download manifests) and re-intercepted on every later fetch.
 */
import { type PageImageLayout, type PageProcess, pageImageLayoutSchema } from "./models.ts";

/**
 * The server-relative image-route path serving `url` on behalf of bridge `bridgeId`. `process` (a
 * page marked `Page.process`) asks the route to process the image and carries the page's context.
 */
export function bridgeImagePath(bridgeId: string, url: string, process?: PageProcess): string {
  const path = `/bridges/${encodeURIComponent(bridgeId)}/image?url=${encodeURIComponent(url)}`;
  return process ? `${path}&process=${encodeURIComponent(JSON.stringify(process.context ?? {}))}` : path;
}

/**
 * The response header carrying a processed page's layout, on the image route and on a downloaded
 * page's file, in the compact form {@link encodePageLayout} writes. Absent: draw the image as it is.
 */
export const PAGE_LAYOUT_HEADER = "Comical-Page-Layout";

/**
 * A layout as a header value: `<width>,<height>` then `;c:<sx>,<sy>,<sw>,<sh>,<dx>,<dy>,<dw>,<dh>`
 * per copy. Compact because it rides a header, where servers cap the total at around 16 KB; a
 * maximal layout is about 10 KB this way, over 30 as JSON.
 */
export function encodePageLayout(layout: PageImageLayout): string {
  let out = `${layout.width},${layout.height}`;
  for (const op of layout.ops) {
    const { src: s, dst: d } = op;
    out += `;c:${s.x},${s.y},${s.w},${s.h},${d.x},${d.y},${d.w},${d.h}`;
  }
  return out;
}

/** The layout in a header value, or undefined for one malformed or using an operation this side doesn't know. */
export function decodePageLayout(value: string | null | undefined): PageImageLayout | undefined {
  if (!value) return undefined;
  const [size, ...rest] = value.split(";");
  const nums = (s: string | undefined, n: number) => {
    const parts = (s ?? "").split(",");
    if (parts.length !== n || !parts.every((p) => /^\d{1,6}$/.test(p))) return undefined;
    return parts.map(Number);
  };
  const wh = nums(size, 2);
  if (!wh) return undefined;
  const ops: PageImageLayout["ops"] = [];
  for (const part of rest) {
    if (!part.startsWith("c:")) return undefined;
    const v = nums(part.slice(2), 8);
    if (!v) return undefined;
    ops.push({ op: "copy", src: { x: v[0]!, y: v[1]!, w: v[2]!, h: v[3]! }, dst: { x: v[4]!, y: v[5]!, w: v[6]!, h: v[7]! } });
  }
  const parsed = pageImageLayoutSchema.safeParse({ width: wh[0], height: wh[1], ops });
  return parsed.success ? parsed.data : undefined;
}

/** The bridge and original URL behind an image-route path (absolute or server-relative), or undefined. */
export function parseBridgeImagePath(path: string): { bridgeId: string; url: string; process?: PageProcess } | undefined {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/?#]*)?\/bridges\/([^/?#]+)\/image\?(?:[^#]*&)?url=([^&#]+)/i.exec(path);
  if (!m) return undefined;
  try {
    const parsed: { bridgeId: string; url: string; process?: PageProcess } = {
      bridgeId: decodeURIComponent(m[1]!),
      url: decodeURIComponent(m[2]!),
    };
    const process = processContext(/[?&]process=([^&#]*)/.exec(path)?.[1]);
    if (process) parsed.process = process;
    return parsed;
  } catch {
    return undefined;
  }
}

/** A malformed `process` parameter is no processing, never a broken image path. */
function processContext(raw: string | undefined): PageProcess | undefined {
  if (raw === undefined) return undefined;
  try {
    const context: unknown = JSON.parse(decodeURIComponent(raw));
    if (!context || typeof context !== "object" || Array.isArray(context)) return undefined;
    if (!Object.values(context).every((v) => typeof v === "string")) return undefined;
    return { context: context as Record<string, string> };
  } catch {
    return undefined;
  }
}
