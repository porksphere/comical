/**
 * Decode a base64 string to raw bytes. Pure JS — no `atob`, no `Buffer` — so it behaves identically
 * in every bridge sandbox (browser, JSC, QuickJS, Node/Bun). A bridge uses this to read a response
 * fetched with `responseType: "base64"` (e.g. a source's packed binary index) that a UTF-8 text
 * decode would corrupt.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = /* @__PURE__ */ (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

export function base64ToBytes(b64: string): Uint8Array {
  // Collect the 6-bit values, ignoring padding (`=`), whitespace, and any stray non-alphabet char.
  const sextets: number[] = [];
  for (let i = 0; i < b64.length; i++) {
    const v = LOOKUP[b64.charCodeAt(i)]!;
    if (v >= 0) sextets.push(v);
  }
  const byteLen = (sextets.length * 6) >> 3; // 4 base64 chars → 3 bytes
  const out = new Uint8Array(byteLen);
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (const s of sextets) {
    acc = (acc << 6) | s;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}
