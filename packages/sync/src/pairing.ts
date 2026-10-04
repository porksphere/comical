/**
 * Pairing: how a device and a hub come to share a key that no other device has, and how either
 * side ends it.
 *
 * The hub shows a short code, good once and not for long. A device that has it runs an X25519
 * exchange with the hub through a channel sealed under the code (`seal.ts`), and the key the two
 * keep is the exchange's result — never sent, and not recoverable from the code. So the code only
 * has to hold for the minutes it is on screen: someone who records the exchange and works the code
 * out later learns two public keys. From then on the device seals its requests under its own key
 * and labels them with its pairing's id, which is how a hub with several devices knows whose key
 * to try.
 *
 * Because every device has its own key, the hub can unlink one and leave the rest alone. An
 * unlinked device is not just dropped: its key is kept a while longer for the one thing it is still
 * good for, sealing the answer "you were unlinked" — so the device can tell that apart from a
 * stranger answering at the hub's address and stop asking, and nobody but the hub can tell it so.
 */
import { randomBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { z } from "zod";
import { SyncHttpError, type HttpBackendOptions } from "./http.ts";
import { envelopePairing, fromBase64, sealedChannel, toBase64 } from "./seal.ts";
import { deviceNameSchema, SYNC_PAIR_PATH, SYNC_PULL_PATH, SYNC_PUSH_PATH, SYNC_UNPAIR_PATH } from "./wire.ts";

/** What a device keeps of its pairing: which one it is, and the key it shares with the hub. */
export type Pairing = { id: string; key: string };

/** A device paired with a hub, as the hub lists it. `lastSeenAt` is null until its first sync. */
export type PairedDevice = { id: string; name: string; pairedAt: number; lastSeenAt: number | null };

/** What a hub keeps per pairing. `unlinkedAt` marks one kept only to tell its device so. */
export type StoredPairing = PairedDevice & { key: string; unlinkedAt?: number };

export type PairingCode = { code: string; expiresAt: number };

export const PAIRING_CODE_TTL_MS = 10 * 60_000;
/** Long enough for a phone left in a drawer to come back and be told. */
const UNLINKED_KEPT_MS = 30 * 24 * 60 * 60_000;

// No 0/o, 1/l/i: a code is read off one screen and typed into another.
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LENGTH = 12;
const X25519_BYTES = 32;

export function newPairingCode(): string {
  // Bytes past the last whole multiple of the alphabet are thrown away, so no letter is likelier.
  const fair = 256 - (256 % CODE_ALPHABET.length);
  let code = "";
  while (code.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      if (byte < fair && code.length < CODE_LENGTH) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return code;
}

export interface PairingGateOptions {
  /** What `save` was last given, on an earlier run. */
  pairings: StoredPairing[];
  /** Called with every pairing whenever one changes. These hold keys: keep them where the hub's own data is. */
  save(pairings: StoredPairing[]): void;
  /** Answers a paired device's push or pull, the way the hub's routes would in the clear. */
  forward(path: string, body: string): Promise<{ status: number; body: string }>;
  /** Called when `devices()` has a new answer. */
  onDevices?(devices: PairedDevice[]): void;
  now?(): number;
}

export interface PairingGate {
  /** A fresh code for one device to pair with. Any code still open stops working. */
  openCode(): PairingCode;
  closeCode(): void;
  /** Paired devices, the most recently active first. */
  devices(): PairedDevice[];
  /** Stops answering that device's syncs. False when it isn't paired. */
  unlink(id: string): boolean;
  /**
   * A request as it arrived, to its sealed reply — or null for one this hub has no key for, which
   * is answered like any other unknown route: nothing about it says a hub is here.
   */
  handle(path: string, envelope: string): Promise<string | null>;
}

const pairRequestSchema = z.object({ name: deviceNameSchema, key: z.string() });
const pairReplySchema = z.object({ id: z.string().min(1), key: z.string() });

export function pairingGate(opts: PairingGateOptions): PairingGate {
  const now = opts.now ?? Date.now;
  let code: PairingCode | null = null;
  let pairings = opts.pairings.map((p) => ({ ...p }));

  const devices = (): PairedDevice[] =>
    pairings
      .filter((p) => p.unlinkedAt === undefined)
      .map(({ id, name, pairedAt, lastSeenAt }) => ({ id, name, pairedAt, lastSeenAt }))
      .sort((a, b) => (b.lastSeenAt ?? b.pairedAt) - (a.lastSeenAt ?? a.pairedAt));

  function changed(): void {
    const at = now();
    pairings = pairings.filter((p) => p.unlinkedAt === undefined || at - p.unlinkedAt < UNLINKED_KEPT_MS);
    opts.save(pairings.map((p) => ({ ...p })));
    opts.onDevices?.(devices());
  }

  function enrol(envelope: string): string | null {
    if (!code || now() >= code.expiresAt) return null;
    const channel = sealedChannel(code.code);
    const request = channel.openRequest(SYNC_PAIR_PATH, envelope);
    if (!request) return null;
    const refuse = (error: string) => channel.sealResponse(request.nonce, 400, JSON.stringify({ error }));

    const parsed = pairRequestSchema.safeParse(parseJson(request.body));
    const theirs = parsed.success ? fromBase64(parsed.data.key) : null;
    if (!parsed.success || theirs?.length !== X25519_BYTES) return refuse("malformed pairing request");
    const ours = x25519.keygen();
    let shared: Uint8Array;
    try {
      shared = x25519.getSharedSecret(ours.secretKey, theirs);
    } catch {
      return refuse("unusable key");
    }

    code = null;
    const id = [...randomBytes(8)].map((b) => b.toString(16).padStart(2, "0")).join("");
    pairings.push({ id, name: parsed.data.name, key: toBase64(shared), pairedAt: now(), lastSeenAt: null });
    changed();
    return channel.sealResponse(request.nonce, 200, JSON.stringify({ id, key: toBase64(ours.publicKey) }));
  }

  return {
    openCode() {
      code = { code: newPairingCode(), expiresAt: now() + PAIRING_CODE_TTL_MS };
      return { ...code };
    },
    closeCode() {
      code = null;
    },
    devices,
    unlink(id) {
      const pairing = pairings.find((p) => p.id === id && p.unlinkedAt === undefined);
      if (!pairing) return false;
      pairing.unlinkedAt = now();
      changed();
      return true;
    },
    async handle(path, envelope) {
      if (path === SYNC_PAIR_PATH) return enrol(envelope);

      const id = envelopePairing(envelope);
      const pairing = pairings.find((p) => p.id === id);
      if (!pairing) return null;
      const channel = sealedChannel(pairing.key);
      const request = channel.openRequest(path, envelope);
      if (!request) return null;
      const reply = (status: number, body = "") => channel.sealResponse(request.nonce, status, body);

      if (pairing.unlinkedAt !== undefined) return reply(410, JSON.stringify({ error: "unlinked" }));
      if (path === SYNC_UNPAIR_PATH) {
        // Its own doing, so there is nobody left to tell: gone outright.
        pairings = pairings.filter((p) => p !== pairing);
        changed();
        return reply(204);
      }
      if (path !== SYNC_PUSH_PATH && path !== SYNC_PULL_PATH) return reply(404, JSON.stringify({ error: "not found" }));
      if (path === SYNC_PULL_PATH) {
        const name = deviceNameSchema.safeParse((parseJson(request.body) as { name?: unknown } | undefined)?.name);
        if (name.success) pairing.name = name.data;
        pairing.lastSeenAt = now();
        changed();
      }
      const answer = await opts.forward(path, request.body);
      return reply(answer.status, answer.body);
    },
  };
}

/** The reply to a pairing request wasn't the hub's: the code is used up, expired or mistyped, or that address isn't the hub. */
export class SyncPairingError extends Error {
  constructor() {
    super("sync: that pairing code isn't one the hub is showing");
    this.name = "SyncPairingError";
  }
}

export type PairOptions = Pick<HttpBackendOptions, "baseUrl" | "fetch"> & {
  /** The code the hub is showing. */
  code: string;
  /** What the hub lists this device as until its first sync says otherwise. */
  name: string;
};

/** Pairs this device with the hub showing `code`. What comes back is the device's to keep, and to hand `HttpBackend`. */
export async function pair(opts: PairOptions): Promise<Pairing> {
  const ours = x25519.keygen();
  const channel = sealedChannel(opts.code);
  const { nonce, envelope } = channel.sealRequest(
    SYNC_PAIR_PATH,
    JSON.stringify({ name: opts.name, key: toBase64(ours.publicKey) }),
  );
  const res = await opts.fetch(`${opts.baseUrl.replace(/\/+$/, "")}${SYNC_PAIR_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: envelope,
  });
  const reply = channel.openResponse(nonce, await res.text());
  if (!reply) throw new SyncPairingError();
  const parsed = pairReplySchema.safeParse(parseJson(reply.body));
  const theirs = parsed.success ? fromBase64(parsed.data.key) : null;
  if (reply.status !== 200 || !parsed.success || theirs?.length !== X25519_BYTES) {
    throw new SyncHttpError(reply.status, `sync: pairing refused (${reply.status})`);
  }
  return { id: parsed.data.id, key: toBase64(x25519.getSharedSecret(ours.secretKey, theirs)) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
