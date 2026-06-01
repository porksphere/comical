/**
 * Bundle integrity and authenticity verification.
 *
 * Integrity  (mandatory): SHA-256 of bundle bytes must match the index entry.
 * Authenticity (optional): Ed25519 signature over the SHA-256 must verify against
 *                          the registry's public key, when both are present.
 */

export class VerificationError extends Error {
  override readonly name = "VerificationError";
}

/**
 * Verify a downloaded bundle against its expected SHA-256.
 * @throws VerificationError on mismatch.
 */
export async function verifyChecksum(
  bundleBytes: Uint8Array<ArrayBuffer>,
  expectedHex: string,
): Promise<void> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", bundleBytes.buffer as ArrayBuffer);
  const actual = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (actual !== expectedHex.toLowerCase()) {
    throw new VerificationError(
      `SHA-256 mismatch: expected ${expectedHex}, got ${actual}`,
    );
  }
}

/**
 * Verify an Ed25519 signature over a SHA-256 hex digest.
 * Both `publicKeyB64` and `signatureB64` are base64url-encoded.
 * @throws VerificationError if invalid or verification fails.
 */
export async function verifySignature(
  sha256Hex: string,
  signatureB64: string,
  publicKeyB64: string,
): Promise<void> {
  let pubKey: CryptoKey;
  let sig: Uint8Array;
  try {
    const rawKey = base64UrlDecode(publicKeyB64);
    pubKey = await crypto.subtle.importKey(
      "raw",
      rawKey.buffer as ArrayBuffer,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    sig = base64UrlDecode(signatureB64);
  } catch (e) {
    throw new VerificationError(
      `failed to parse key/signature: ${e instanceof Error ? e.message : e}`,
    );
  }

  // The signed message is the SHA-256 hex string encoded as UTF-8.
  const message = new TextEncoder().encode(sha256Hex);
  const valid = await crypto.subtle.verify("Ed25519", pubKey, sig.buffer as ArrayBuffer, message.buffer as ArrayBuffer);
  if (!valid) throw new VerificationError("Ed25519 signature verification failed");
}

/**
 * Compute SHA-256 of bundle bytes and return lowercase hex.
 * Used by the publisher to generate index entries.
 */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate an Ed25519 keypair for a registry operator.
 * Returns { publicKey, privateKey } as base64url strings.
 */
export async function generateKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
  const priv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer);
  return { publicKey: base64UrlEncode(pub), privateKey: base64UrlEncode(priv) };
}

/**
 * Sign a SHA-256 hex digest with a PKCS8 private key (base64url).
 * Returns the signature as base64url.
 */
export async function signSha256(sha256Hex: string, privateKeyB64: string): Promise<string> {
  const rawKey = base64UrlDecode(privateKeyB64);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    rawKey.buffer as ArrayBuffer,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const message = new TextEncoder().encode(sha256Hex);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, message.buffer as ArrayBuffer));
  return base64UrlEncode(sig);
}

/** Compute SHA-256 fingerprint of a base64url public key (for pinning). */
export async function publicKeyFingerprint(publicKeyB64: string): Promise<string> {
  return sha256Hex(base64UrlDecode(publicKeyB64));
}

// ── Base64url helpers ────────────────────────────────────────────────────────

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    s.length + (4 - (s.length % 4)) % 4, "=",
  );
  const arr = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  // Ensure the underlying buffer is a plain ArrayBuffer (not SharedArrayBuffer).
  const owned = new Uint8Array(arr.byteLength);
  owned.set(arr);
  return owned;
}
