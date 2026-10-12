/**
 * UTF-8 `TextEncoder`/`TextDecoder` and `atob`/`btoa` for engines that don't ship them (QuickJS).
 *
 * The SDK's cursor helpers (`encodeCursor`/`decodeCursor`) need all four — every paged bridge read
 * goes through them — so a host missing any one fails `getListItems` outright. Mirrors the JSC
 * shims in host-ios' ComicalBridgeContext.swift; keep the two in lockstep.
 */

export class ComicalTextEncoder {
  readonly encoding = "utf-8";

  encode(input: string = ""): Uint8Array {
    const str = String(input);
    const bytes: number[] = [];
    for (let i = 0; i < str.length; i++) {
      let code = str.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
        const lo = str.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (lo - 0xdc00);
          i++;
        }
      }
      // A lone surrogate encodes as U+FFFD, as the WHATWG encoder does.
      if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
    return new Uint8Array(bytes);
  }
}

export class ComicalTextDecoder {
  readonly encoding = "utf-8";

  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (!input) return "";
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
    let out = "";
    let i = 0;
    while (i < bytes.length) {
      const b = bytes[i++]!;
      let cp: number;
      if (b < 0x80) cp = b;
      else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++]! & 0x3f);
      else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f);
      else cp = ((b & 0x07) << 18) | ((bytes[i++]! & 0x3f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f);
      out += String.fromCodePoint(cp);
    }
    return out;
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Binary string (one char per byte) → base64. Throws on chars above U+00FF, like the spec. */
export function comicalBtoa(input: string): string {
  const str = String(input);
  let out = "";
  for (let i = 0; i < str.length; i += 3) {
    const a = str.charCodeAt(i);
    const b = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
    const c = i + 2 < str.length ? str.charCodeAt(i + 2) : 0;
    if (a > 0xff || b > 0xff || c > 0xff) {
      throw new Error("btoa: string contains characters outside of the Latin1 range");
    }
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += i + 1 < str.length ? B64[(n >> 6) & 63]! : "=";
    out += i + 2 < str.length ? B64[n & 63]! : "=";
  }
  return out;
}

/** base64 → binary string. Ignores whitespace; throws on anything else outside the alphabet. */
export function comicalAtob(input: string): string {
  const str = String(input).replace(/[\t\n\f\r ]/g, "").replace(/=+$/, "");
  if (str.length % 4 === 1) throw new Error("atob: invalid base64 length");
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const ch of str) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error("atob: invalid base64 character");
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}
