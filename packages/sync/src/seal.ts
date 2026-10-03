/**
 * The sealed channel between a device and its hub: every request and response body travels as an
 * AEAD ciphertext under keys derived from the pairing secret, and nothing else — not the secret, not
 * a token — ever crosses the wire. One primitive buys three things at once. A body no one else can
 * read. A body no one else can forge or alter, since a host without the secret can't produce a
 * ciphertext the other side opens, so a stranger answering at the hub's address is simply not
 * heard. And a response that can only be an answer to the request it came back for: the request's
 * nonce is in the response's associated data, so an old reply can't be served up again.
 *
 * The secret is shared, so there is no need for public keys; it is stretched with HKDF into one key
 * per direction, which is what keeps a message from being reflected back as if the other end had
 * sent it. XChaCha20-Poly1305 takes a 24-byte nonce, long enough that a random one per message is
 * safe without any counter state to keep in step across devices. The AEAD's own tag authenticates
 * the body; what it must be bound to besides is in the associated data: which side is speaking,
 * which route a request is for, and which request a response answers.
 *
 * Replay is harmless by construction and so needs no clock or nonce memory: a replayed push is the
 * same segment again, which the hub's log already treats as idempotent, and a replayed pull yields
 * a ciphertext only the device can open.
 *
 * Pure JS throughout (`@noble/*`), so the same code runs under Bun, in Electron's main process and
 * on Hermes — where only `crypto.getRandomValues` need be present, and already is for device ids.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToUtf8, randomBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const VERSION = 1;
const SALT = utf8ToBytes("comical-sync-seal");
const NONCE_BYTES = 24;

/** What crosses the wire, as JSON: the version, the nonce and the ciphertext, each in base64. */
export type SealedEnvelope = { v: number; n: string; c: string };

export interface SealedChannel {
  /** A device seals a request for `path`; the nonce is kept to open the reply. */
  sealRequest(path: string, body: string): { nonce: string; envelope: string };
  /** A hub opens a request for `path` — null for anything not sealed with this secret for it. */
  openRequest(path: string, envelope: string): { nonce: string; body: string } | null;
  /** A hub seals its reply to the request with that nonce. */
  sealResponse(nonce: string, status: number, body: string): string;
  /** A device opens the reply to its request — null unless it was sealed by the hub for it. */
  openResponse(nonce: string, envelope: string): { status: number; body: string } | null;
}

export function sealedChannel(secret: string): SealedChannel {
  const ikm = utf8ToBytes(secret);
  const toHub = hkdf(sha256, ikm, SALT, utf8ToBytes("device to hub"), 32);
  const fromHub = hkdf(sha256, ikm, SALT, utf8ToBytes("hub to device"), 32);

  return {
    sealRequest(path, body) {
      const nonce = randomBytes(NONCE_BYTES);
      return { nonce: toBase64(nonce), envelope: seal(toHub, nonce, `request ${path}`, body) };
    },
    openRequest(path, envelope) {
      const parsed = parseEnvelope(envelope);
      if (!parsed) return null;
      const body = open(toHub, parsed, `request ${path}`);
      return body === null ? null : { nonce: parsed.n, body };
    },
    sealResponse(nonce, status, body) {
      return seal(fromHub, randomBytes(NONCE_BYTES), `response ${nonce}`, JSON.stringify({ status, body }));
    },
    openResponse(nonce, envelope) {
      const parsed = parseEnvelope(envelope);
      if (!parsed) return null;
      const text = open(fromHub, parsed, `response ${nonce}`);
      if (text === null) return null;
      try {
        const reply = JSON.parse(text) as { status?: unknown; body?: unknown };
        if (typeof reply.status !== "number" || typeof reply.body !== "string") return null;
        return { status: reply.status, body: reply.body };
      } catch {
        return null;
      }
    },
  };
}

type Parsed = { n: string; nonce: Uint8Array; ciphertext: Uint8Array };

function seal(key: Uint8Array, nonce: Uint8Array, aad: string, plaintext: string): string {
  const ciphertext = xchacha20poly1305(key, nonce, utf8ToBytes(aad)).encrypt(utf8ToBytes(plaintext));
  const envelope: SealedEnvelope = { v: VERSION, n: toBase64(nonce), c: toBase64(ciphertext) };
  return JSON.stringify(envelope);
}

function open(key: Uint8Array, { nonce, ciphertext }: Parsed, aad: string): string | null {
  try {
    return bytesToUtf8(xchacha20poly1305(key, nonce, utf8ToBytes(aad)).decrypt(ciphertext));
  } catch {
    return null;
  }
}

/** Anything that isn't an envelope of this version is null, never a throw: it may be any host's reply. */
function parseEnvelope(text: string): Parsed | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const { v, n, c } = (value ?? {}) as Partial<SealedEnvelope>;
  if (v !== VERSION || typeof n !== "string" || typeof c !== "string") return null;
  const nonce = fromBase64(n);
  const ciphertext = fromBase64(c);
  if (!nonce || !ciphertext || nonce.length !== NONCE_BYTES) return null;
  return { n, nonce, ciphertext };
}

// Base64 by hand: Hermes has no btoa, and Buffer is Node's.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Map([...ALPHABET].map((ch, i) => [ch, i]));

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += ALPHABET[(triple >> 18) & 63]! + ALPHABET[(triple >> 12) & 63]!;
    out += b === undefined ? "=" : ALPHABET[(triple >> 6) & 63]!;
    out += c === undefined ? "=" : ALPHABET[triple & 63]!;
  }
  return out;
}

function fromBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let j = 0;
  for (let i = 0; i < text.length; i += 4) {
    let triple = 0;
    for (let k = 0; k < 4; k++) {
      const ch = text[i + k]!;
      const isPad = ch === "=" && i + k >= text.length - padding;
      const value = isPad ? 0 : LOOKUP.get(ch);
      if (value === undefined) return null;
      triple = (triple << 6) | value;
    }
    if (j < out.length) out[j++] = (triple >> 16) & 255;
    if (j < out.length) out[j++] = (triple >> 8) & 255;
    if (j < out.length) out[j++] = triple & 255;
  }
  return out;
}
