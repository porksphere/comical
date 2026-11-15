/**
 * Page image processing (`Page.process`, `BridgeInfo.images.process`): what the image route does for
 * a page whose source serves it encrypted or cut up. Platform-agnostic arithmetic only — byte
 * transforms run here, in JS, because they are the same on every host; pixel work never does. The
 * route hands back the decoded bytes and the bridge's layout, and the client draws the layout
 * natively where it decodes the image.
 */
import {
  type BridgeInfo,
  type PageByteTransform,
  type PageImageDecodeRequest,
  type PageImageLayout,
  type PageImageLayoutRequest,
} from "@comical/contract";
import { aesCtr } from "./aes.ts";
import { BridgeContractError, ComicalError } from "./errors.ts";

export type ImageFormat = "jpeg" | "png" | "webp" | "gif" | "avif";

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/** AVIF keeps its size in an `ispe` box inside `meta`; boxes are walked, not scanned for, so a stray match in pixel data can't lie. */
function avifSize(b: Uint8Array): { width: number; height: number } | undefined {
  const walk = (start: number, end: number, depth: number): { width: number; height: number } | undefined => {
    let i = start;
    while (i + 8 <= end && depth < 6) {
      let size = u32be(b, i);
      const type = ascii(b, i + 4, 4);
      let header = 8;
      if (size === 1 && i + 16 <= end) {
        size = u32be(b, i + 8) * 2 ** 32 + u32be(b, i + 12);
        header = 16;
      } else if (size === 0) {
        size = end - i;
      }
      if (size < header || i + size > end) return undefined;
      if (type === "ispe" && size >= header + 12) {
        return { width: u32be(b, i + header + 4), height: u32be(b, i + header + 8) };
      }
      // `meta` is a full box: four bytes of version and flags before its children.
      if (type === "meta" || type === "iprp" || type === "ipco") {
        const found = walk(i + header + (type === "meta" ? 4 : 0), i + size, depth + 1);
        if (found) return found;
      }
      i += size;
    }
    return undefined;
  };
  return walk(0, b.length, 0);
}

/**
 * An encoded image's pixel size and format, read from its header: PNG, GIF, WebP (lossy, lossless,
 * extended), JPEG and AVIF. Undefined for anything else or a buffer too short to say.
 */
export function imageSize(b: Uint8Array): { width: number; height: number; format: ImageFormat } | undefined {
  if (b.length < 24) return undefined;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: u32be(b, 16), height: u32be(b, 20), format: "png" };
  }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8), format: "gif" };
  }
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const fmt = ascii(b, 12, 4);
    if (fmt === "VP8 ") {
      return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff, format: "webp" };
    }
    if (fmt === "VP8L") {
      const b0 = b[21]!, b1 = b[22]!, b2 = b[23]!, b3 = b[24]!;
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width, height, format: "webp" };
    }
    if (fmt === "VP8X") {
      const width = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
      const height = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
      return { width, height, format: "webp" };
    }
    return undefined;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: u16be(b, i + 5), width: u16be(b, i + 7), format: "jpeg" };
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      i += 2 + u16be(b, i + 2);
    }
    return undefined;
  }
  if (ascii(b, 4, 4) === "ftyp" && /^avi[fs]$/.test(ascii(b, 8, 4))) {
    const size = avifSize(b);
    return size ? { ...size, format: "avif" } : undefined;
  }
  return undefined;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i;

function base64Bytes(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_INDEX[clean.charCodeAt(i)] ?? -1;
    if (v < 0) throw new BridgeContractError("byte transform key is not base64");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** Apply `transforms` to a copy of `bytes`, in order. */
export function applyByteTransforms(bytes: Uint8Array, transforms: readonly PageByteTransform[]): Uint8Array {
  const out = Uint8Array.from(bytes);
  for (const t of transforms) {
    const start = Math.min(t.offset ?? 0, out.length);
    const end = t.length === undefined ? out.length : Math.min(out.length, start + t.length);
    const key = base64Bytes(t.key);
    if (t.kind === "xor") {
      if (key.length === 0) throw new BridgeContractError("xor key is empty");
      for (let i = start, k = 0; i < end; i++, k = k + 1 === key.length ? 0 : k + 1) out[i]! ^= key[k]!;
    } else {
      try {
        aesCtr(out, key, base64Bytes(t.counter), start, end - start);
      } catch (e) {
        throw new BridgeContractError(`aes-ctr transform: ${(e as Error).message}`);
      }
    }
  }
  return out;
}

/** Throws unless every rectangle of `layout` lies inside its image: the decoded `width × height` for a source, the output for a destination. */
export function checkPageImageLayout(layout: PageImageLayout, width: number, height: number): void {
  const inside = (r: { x: number; y: number; w: number; h: number }, w: number, h: number) => r.x + r.w <= w && r.y + r.h <= h;
  for (const [i, op] of layout.ops.entries()) {
    if (!inside(op.src, width, height)) {
      throw new BridgeContractError(`layoutPageImage: op ${i} reads outside the ${width}×${height} image`);
    }
    if (!inside(op.dst, layout.width, layout.height)) {
      throw new BridgeContractError(`layoutPageImage: op ${i} draws outside the ${layout.width}×${layout.height} output`);
    }
  }
}

/** The processing hooks of a loaded bridge (already validating their inputs and outputs). */
export interface PageImageProcessor {
  decodePageImage?(req: PageImageDecodeRequest): Promise<PageByteTransform[] | null>;
  layoutPageImage?(req: PageImageLayoutRequest): Promise<PageImageLayout | null>;
}

export interface ProcessedPageImage {
  bytes: Uint8Array;
  /** Present when the bridge laid the image out; absent means draw it as it is. */
  layout?: PageImageLayout;
  /** The decoded image's format, when its header says. */
  format?: ImageFormat;
}

/**
 * Process one fetched page image: decode its bytes if the bridge declares `bytes`, then measure it
 * and ask for its layout if it declares `layout`. Only the steps a bridge declares run, whatever
 * methods it appears to have.
 */
export async function processPageImage(opts: {
  info: Pick<BridgeInfo, "id" | "images">;
  bridge: PageImageProcessor;
  url: string;
  bytes: Uint8Array;
  headers: Record<string, string>;
  context: Record<string, string>;
}): Promise<ProcessedPageImage> {
  const declared = opts.info.images?.process;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers)) headers[k.toLowerCase()] = v;
  const req = { url: opts.url, headers, context: opts.context };

  let bytes = opts.bytes;
  if (declared?.bytes && opts.bridge.decodePageImage) {
    const transforms = await opts.bridge.decodePageImage(req);
    if (transforms?.length) bytes = applyByteTransforms(bytes, transforms);
  }

  const size = imageSize(bytes);
  const result: ProcessedPageImage = { bytes };
  if (size) result.format = size.format;
  if (declared?.layout && opts.bridge.layoutPageImage) {
    if (!size || size.width < 1 || size.height < 1) {
      throw new ComicalError(`page image from ${opts.info.id} has no readable size${declared.bytes ? " after decoding" : ""}`);
    }
    const layout = await opts.bridge.layoutPageImage({ ...req, width: size.width, height: size.height });
    if (layout) {
      checkPageImageLayout(layout, size.width, size.height);
      result.layout = layout;
    }
  }
  return result;
}
