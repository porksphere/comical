/**
 * `installWebCryptoShim` fills the WebCrypto gaps Hermes leaves: `crypto.randomUUID` (used by
 * `@comical/library` to mint list/group ids — the on-device "undefined is not a function" that
 * blocked list creation) and `crypto.subtle` for bundle verification. Driven against an injectable
 * fake global so we can exercise the "absent" paths the real Bun global (which already has both) hides.
 */
import { getPublicKeyAsync, hashes, signAsync } from "@noble/ed25519";
import { describe, expect, test } from "bun:test";
import { installWebCryptoShim } from "../src/crypto-shim.ts";

type CryptoGlobal = {
  subtle?: { digest?: unknown };
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T;
};

/** A deterministic `getRandomValues` (fills with a byte ramp) so UUID assertions are stable. */
function rampGetRandomValues<T extends ArrayBufferView | null>(array: T): T {
  if (array) {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i;
  }
  return array;
}

const V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("installWebCryptoShim — randomUUID", () => {
  test("installs randomUUID (built on getRandomValues) when absent", () => {
    const target: { crypto?: CryptoGlobal } = { crypto: { getRandomValues: rampGetRandomValues } };
    installWebCryptoShim(target);

    const uuid = target.crypto!.randomUUID!();
    expect(uuid).toMatch(V4_RE);
    // Version nibble = 4, variant nibble in [8..b], regardless of the raw entropy.
    expect(uuid.charAt(14)).toBe("4");
    expect("89ab").toContain(uuid.charAt(19));
  });

  test("creates crypto entirely when the global has none", () => {
    const target: { crypto?: CryptoGlobal } = {};
    // No getRandomValues supplied → randomUUID must throw a clear, actionable error rather than
    // silently using weak randomness.
    installWebCryptoShim(target);
    expect(() => target.crypto!.randomUUID!()).toThrow(/getRandomValues/);
  });

  test("leaves a real randomUUID untouched", () => {
    const sentinel = () => "real-uuid";
    const target: { crypto?: CryptoGlobal } = { crypto: { randomUUID: sentinel } };
    installWebCryptoShim(target);
    expect(target.crypto!.randomUUID).toBe(sentinel);
  });

  test("produces distinct ids across calls with real entropy", () => {
    const target: { crypto?: CryptoGlobal } = {
      crypto: { getRandomValues: (a) => (globalThis.crypto as CryptoGlobal).getRandomValues!(a) },
    };
    installWebCryptoShim(target);
    const a = target.crypto!.randomUUID!();
    const b = target.crypto!.randomUUID!();
    expect(a).toMatch(V4_RE);
    expect(a).not.toBe(b);
  });
});

describe("installWebCryptoShim — subtle", () => {
  test("installs a working SHA-256 digest when subtle is absent", async () => {
    const target: { crypto?: CryptoGlobal } = { crypto: { getRandomValues: rampGetRandomValues } };
    installWebCryptoShim(target);

    const subtle = target.crypto!.subtle as { digest(alg: string, data: ArrayBufferView): Promise<ArrayBuffer> };
    const digest = new Uint8Array(await subtle.digest("SHA-256", new Uint8Array([1, 2, 3])));
    // Same digest the real WebCrypto produces for the same input.
    const expected = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array([1, 2, 3])));
    expect([...digest]).toEqual([...expected]);
  });

  test("honours the requested algorithm instead of always hashing SHA-256", async () => {
    // Regression: the shim ignored its `algorithm` argument and always ran SHA-256. Nothing in
    // Comical asks for SHA-512 directly — but `@noble/ed25519`'s default async hash provider is
    // `crypto.subtle.digest("SHA-512", …)`, so it re-enters this shim during every `verify` and
    // rejected the 32-byte answer with `"digest" expected Uint8Array of length 64, got length=32`.
    const target: { crypto?: CryptoGlobal } = { crypto: { getRandomValues: rampGetRandomValues } };
    installWebCryptoShim(target);

    const subtle = target.crypto!.subtle as { digest(alg: unknown, data: ArrayBufferView): Promise<ArrayBuffer> };
    const msg = new Uint8Array([1, 2, 3]);
    for (const alg of ["SHA-512", { name: "SHA-512" }]) {
      const digest = new Uint8Array(await subtle.digest(alg, msg));
      expect(digest.length).toBe(64);
      expect([...digest]).toEqual([...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-512", msg))]);
    }
    // An algorithm we can't serve must say so rather than silently returning the wrong hash.
    await expect(subtle.digest("SHA-1", msg)).rejects.toThrow(/unsupported algorithm/);
  });

  test("verifies a real Ed25519 signature end to end", async () => {
    // The path that actually runs on device: importKey + verify against a signature over the bundle's
    // SHA-256 hex, exactly as `@comical/registry`'s verify.ts calls it.
    //
    // Note what this test has to do to be honest. On device, `installWebCryptoShim(globalThis)` means
    // noble's own SHA-512 provider (`globalThis.crypto.subtle.digest`) IS the shim — that mutual
    // recursion is the whole bug. Under Bun, `globalThis.crypto` is real WebCrypto, so noble would
    // quietly hash with the real SHA-512 and pass no matter how broken the shim is. Re-point noble's
    // provider slot at the shim's digest to reproduce the device's chain rather than Bun's.
    const target: { crypto?: CryptoGlobal } = { crypto: { getRandomValues: rampGetRandomValues } };
    installWebCryptoShim(target);
    const subtle = target.crypto!.subtle as {
      digest(alg: unknown, data: ArrayBufferView): Promise<ArrayBuffer>;
      importKey(f: string, k: Uint8Array, a: unknown, e: boolean, u: string[]): Promise<unknown>;
      verify(a: unknown, k: unknown, sig: Uint8Array, data: Uint8Array): Promise<boolean>;
    };

    const realSha512Async = hashes.sha512Async;
    hashes.sha512Async = async (...messages: Uint8Array[]) => {
      const joined = new Uint8Array(messages.reduce((n, m) => n + m.length, 0));
      let at = 0;
      for (const m of messages) {
        joined.set(m, at);
        at += m.length;
      }
      return new Uint8Array(await subtle.digest("SHA-512", joined));
    };

    try {
      const secret = new Uint8Array(32).fill(7);
      const publicKey = await getPublicKeyAsync(secret);
      const message = new TextEncoder().encode("a".repeat(64)); // a SHA-256 hex digest
      const signature = await signAsync(message, secret);

      const key = await subtle.importKey("raw", publicKey, { name: "Ed25519" }, true, ["verify"]);
      expect(await subtle.verify({ name: "Ed25519" }, key, signature, message)).toBe(true);
      // A signature over different bytes must be rejected, not merely "not throw".
      expect(await subtle.verify({ name: "Ed25519" }, key, signature, new TextEncoder().encode("b".repeat(64)))).toBe(
        false,
      );
    } finally {
      hashes.sha512Async = realSha512Async;
    }
  });

  test("leaves a real subtle untouched", () => {
    const realSubtle = { digest: async () => new ArrayBuffer(0) };
    const target: { crypto?: CryptoGlobal } = { crypto: { subtle: realSubtle } };
    installWebCryptoShim(target);
    expect(target.crypto!.subtle).toBe(realSubtle);
  });
});
