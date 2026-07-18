/**
 * Minimal WebCrypto polyfill for Hermes, covering exactly what the reused host-server stack uses that
 * Hermes doesn't provide natively:
 *
 *  - `crypto.subtle.digest("SHA-256", …)` (always) plus `importKey`/`verify` for Ed25519 (only when a
 *    registry signs its index) — used by `@comical/registry`'s `verify.ts` to verify downloaded bridge
 *    bundles. Backed by pure-JS `@noble/*` (no native module / extra build step).
 *  - `crypto.randomUUID()` — used by `@comical/library` to mint list/group ids. Built on
 *    `crypto.getRandomValues`, which the host app must supply on native (e.g. via
 *    `react-native-get-random-values`); a clear error is thrown if it's absent rather than silently
 *    falling back to weak randomness.
 *
 * Install once at app launch on native before any bundle is resolved or list is created. Each piece is
 * a no-op where the real thing already exists (web, or a future native WebCrypto).
 */
import { verifyAsync } from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";

interface OpaqueKey {
  _raw: Uint8Array;
}

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** RFC 4122 v4 UUID from 16 random bytes (mutates `bytes` to set the version/variant nibbles). */
function uuidV4(bytes: Uint8Array): string {
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i]!.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

type CryptoGlobal = {
  subtle?: { digest?: unknown };
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T;
};

/** `target` is injectable for tests; production callers use the default `globalThis`. */
export function installWebCryptoShim(target: { crypto?: CryptoGlobal } = globalThis as { crypto?: CryptoGlobal }): void {
  // Only create the global when it's truly absent — reassigning an existing `globalThis.crypto` throws
  // where it's a read-only global (Bun/Node, browsers). When it exists we mutate it in place, and each
  // installer below no-ops for members that are already real.
  let cryptoObj = target.crypto;
  if (!cryptoObj) {
    cryptoObj = {};
    target.crypto = cryptoObj;
  }

  installRandomUUID(cryptoObj);
  installSubtle(cryptoObj);
}

/** `crypto.randomUUID` via the host-provided `getRandomValues`. No-op if `randomUUID` already exists. */
function installRandomUUID(cryptoObj: CryptoGlobal): void {
  if (typeof cryptoObj.randomUUID === "function") return; // real randomUUID present — leave it alone
  cryptoObj.randomUUID = () => {
    const getRandomValues = cryptoObj.getRandomValues;
    if (typeof getRandomValues !== "function") {
      throw new Error(
        "crypto.randomUUID shim needs crypto.getRandomValues — install a native entropy polyfill " +
          "(e.g. react-native-get-random-values) before installWebCryptoShim().",
      );
    }
    return uuidV4(getRandomValues(new Uint8Array(16)));
  };
}

function installSubtle(cryptoObj: CryptoGlobal): void {
  if (cryptoObj.subtle?.digest) return; // real WebCrypto subtle present — leave it alone

  const subtle = {
    async digest(_algorithm: unknown, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer> {
      const digest = sha256(toBytes(data)); // fresh 32-byte Uint8Array (offset 0)
      return digest.buffer as ArrayBuffer;
    },
    async importKey(
      _format: unknown,
      keyData: ArrayBuffer | ArrayBufferView,
      _algorithm: unknown,
      _extractable: unknown,
      _usages: unknown,
    ): Promise<OpaqueKey> {
      // Opaque handle consumed only by `verify` below (verify.ts never inspects the key otherwise).
      return { _raw: toBytes(keyData) };
    },
    async verify(
      _algorithm: unknown,
      key: OpaqueKey,
      signature: ArrayBuffer | ArrayBufferView,
      data: ArrayBuffer | ArrayBufferView,
    ): Promise<boolean> {
      return verifyAsync(toBytes(signature), toBytes(data), key._raw);
    },
  };

  if (!cryptoObj.subtle) cryptoObj.subtle = subtle;
}
