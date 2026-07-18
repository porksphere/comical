/**
 * `installWebCryptoShim` fills the WebCrypto gaps Hermes leaves: `crypto.randomUUID` (used by
 * `@comical/library` to mint list/group ids — the on-device "undefined is not a function" that
 * blocked list creation) and `crypto.subtle` for bundle verification. Driven against an injectable
 * fake global so we can exercise the "absent" paths the real Bun global (which already has both) hides.
 */
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

  test("leaves a real subtle untouched", () => {
    const realSubtle = { digest: async () => new ArrayBuffer(0) };
    const target: { crypto?: CryptoGlobal } = { crypto: { subtle: realSubtle } };
    installWebCryptoShim(target);
    expect(target.crypto!.subtle).toBe(realSubtle);
  });
});
