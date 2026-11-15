/**
 * AES encryption (FIPS-197) for counter mode, in plain JS: core runs on engines with no WebCrypto
 * (Hermes, QuickJS, JavaScriptCore without the shim), and CTR needs only the forward cipher.
 * T-table form — four 256-entry tables built once at load — since a page is tens of thousands of
 * blocks and the byte-at-a-time form is several times slower on an interpreter.
 */

const SBOX = new Uint8Array(256);
const TE0 = new Uint32Array(256);
const TE1 = new Uint32Array(256);
const TE2 = new Uint32Array(256);
const TE3 = new Uint32Array(256);

{
  const rotl8 = (x: number, s: number) => ((x << s) | (x >>> (8 - s))) & 0xff;
  // Walks every non-zero element: p by multiplying by 3, q its inverse by dividing by 3.
  let p = 1;
  let q = 1;
  do {
    p = (p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    SBOX[p] = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i]!;
    const s2 = ((s << 1) ^ (s & 0x80 ? 0x1b : 0)) & 0xff;
    const s3 = s2 ^ s;
    const t = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0;
    TE0[i] = t;
    TE1[i] = ((t >>> 8) | (t << 24)) >>> 0;
    TE2[i] = ((t >>> 16) | (t << 16)) >>> 0;
    TE3[i] = ((t >>> 24) | (t << 8)) >>> 0;
  }
}

const subWord = (w: number) =>
  ((SBOX[w >>> 24]! << 24) | (SBOX[(w >>> 16) & 0xff]! << 16) | (SBOX[(w >>> 8) & 0xff]! << 8) | SBOX[w & 0xff]!) >>> 0;

/** The expanded key schedule for a 16-, 24- or 32-byte key. */
function expandKey(key: Uint8Array): { w: Uint32Array; rounds: number } {
  const nk = key.length / 4;
  if (key.length !== 16 && key.length !== 24 && key.length !== 32) {
    throw new RangeError(`AES key must be 16, 24 or 32 bytes, got ${key.length}`);
  }
  const rounds = nk + 6;
  const w = new Uint32Array(4 * (rounds + 1));
  for (let i = 0; i < nk; i++) {
    w[i] = ((key[4 * i]! << 24) | (key[4 * i + 1]! << 16) | (key[4 * i + 2]! << 8) | key[4 * i + 3]!) >>> 0;
  }
  let rcon = 1;
  for (let i = nk; i < w.length; i++) {
    let t = w[i - 1]!;
    if (i % nk === 0) {
      t = (subWord(((t << 8) | (t >>> 24)) >>> 0) ^ (rcon << 24)) >>> 0;
      rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x1b : 0)) & 0xff;
    } else if (nk > 6 && i % nk === 4) {
      t = subWord(t);
    }
    w[i] = (w[i - nk]! ^ t) >>> 0;
  }
  return { w, rounds };
}

/** Encrypt the 16-byte block `input` into `out`. */
function encryptBlock(w: Uint32Array, rounds: number, input: Uint8Array, out: Uint8Array): void {
  const word = (i: number) => ((input[i]! << 24) | (input[i + 1]! << 16) | (input[i + 2]! << 8) | input[i + 3]!) >>> 0;
  let s0 = word(0) ^ w[0]!;
  let s1 = word(4) ^ w[1]!;
  let s2 = word(8) ^ w[2]!;
  let s3 = word(12) ^ w[3]!;
  let k = 4;
  for (let r = 1; r < rounds; r++) {
    const t0 = TE0[s0 >>> 24]! ^ TE1[(s1 >>> 16) & 0xff]! ^ TE2[(s2 >>> 8) & 0xff]! ^ TE3[s3 & 0xff]! ^ w[k]!;
    const t1 = TE0[s1 >>> 24]! ^ TE1[(s2 >>> 16) & 0xff]! ^ TE2[(s3 >>> 8) & 0xff]! ^ TE3[s0 & 0xff]! ^ w[k + 1]!;
    const t2 = TE0[s2 >>> 24]! ^ TE1[(s3 >>> 16) & 0xff]! ^ TE2[(s0 >>> 8) & 0xff]! ^ TE3[s1 & 0xff]! ^ w[k + 2]!;
    const t3 = TE0[s3 >>> 24]! ^ TE1[(s0 >>> 16) & 0xff]! ^ TE2[(s1 >>> 8) & 0xff]! ^ TE3[s2 & 0xff]! ^ w[k + 3]!;
    s0 = t0 >>> 0;
    s1 = t1 >>> 0;
    s2 = t2 >>> 0;
    s3 = t3 >>> 0;
    k += 4;
  }
  const last = (a: number, b: number, c: number, d: number, key: number) =>
    (((SBOX[a >>> 24]! << 24) | (SBOX[(b >>> 16) & 0xff]! << 16) | (SBOX[(c >>> 8) & 0xff]! << 8) | SBOX[d & 0xff]!) ^ key) >>> 0;
  const o = [last(s0, s1, s2, s3, w[k]!), last(s1, s2, s3, s0, w[k + 1]!), last(s2, s3, s0, s1, w[k + 2]!), last(s3, s0, s1, s2, w[k + 3]!)];
  for (let i = 0; i < 4; i++) {
    out[4 * i] = o[i]! >>> 24;
    out[4 * i + 1] = (o[i]! >>> 16) & 0xff;
    out[4 * i + 2] = (o[i]! >>> 8) & 0xff;
    out[4 * i + 3] = o[i]! & 0xff;
  }
}

/**
 * AES-CTR over `data` in place, from `start` for `length` bytes: XOR with the cipher of successive
 * counter blocks, the counter a big-endian 128-bit integer starting at `counter`. Encryption and
 * decryption are the same operation.
 */
export function aesCtr(data: Uint8Array, key: Uint8Array, counter: Uint8Array, start = 0, length = data.length - start): void {
  if (counter.length !== 16) throw new RangeError(`AES-CTR counter must be 16 bytes, got ${counter.length}`);
  const { w, rounds } = expandKey(key);
  const block = Uint8Array.from(counter);
  const stream = new Uint8Array(16);
  const end = Math.min(data.length, start + length);
  for (let pos = start; pos < end; pos += 16) {
    encryptBlock(w, rounds, block, stream);
    const n = Math.min(16, end - pos);
    for (let i = 0; i < n; i++) data[pos + i]! ^= stream[i]!;
    for (let i = 15; i >= 0; i--) {
      block[i] = (block[i]! + 1) & 0xff;
      if (block[i] !== 0) break;
    }
  }
}
