/**
 * A hub reached over HTTP. `fetch` is passed in rather than taken from the global, so this package
 * keeps no platform dependency of its own.
 *
 * Given a pairing secret, every exchange goes through the sealed channel (`seal.ts`): the body out
 * is a ciphertext, and a reply that doesn't open as the hub's answer to that very request is
 * refused as not the hub's at all — whatever address it came from and whatever it says.
 */
import type { SyncBackend } from "./backend.ts";
import { SeqConflictError, SeqGapError } from "./log.ts";
import { sealedChannel, type SealedChannel } from "./seal.ts";
import {
  parsePullResult,
  parsePushRefusal,
  SYNC_PULL_PATH,
  SYNC_PUSH_PATH,
  type PullRequest,
  type PullResult,
  type Segment,
  type VersionVector,
} from "./wire.ts";

export type HttpBackendOptions = {
  /** The hub's origin plus any prefix it is mounted under, without a trailing slash. */
  baseUrl: string;
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>;
  token?: string;
  /** The pairing secret; with it, nothing crosses in the clear. */
  secret?: string;
};

export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SyncHttpError";
  }
}

/** The reply wasn't sealed by a hub holding the secret: a stranger at that address, or a hub re-keyed since pairing. */
export class SyncSealError extends Error {
  constructor() {
    super("sync: the server didn't answer as the paired hub");
    this.name = "SyncSealError";
  }
}

type Reply = { status: number; body: unknown };

export class HttpBackend implements SyncBackend {
  private readonly base: string;
  private readonly channel: SealedChannel | null;

  constructor(private readonly opts: HttpBackendOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.channel = opts.secret ? sealedChannel(opts.secret) : null;
  }

  async push(segment: Segment): Promise<void> {
    const { status, body } = await this.post(SYNC_PUSH_PATH, segment);
    if (ok(status)) return;
    if (status === 409) {
      const refusal = parsePushRefusal(body);
      if (refusal.ok) {
        const { error, device, seq, head } = refusal.value;
        throw error === "seq-conflict" ? new SeqConflictError(device, seq, head) : new SeqGapError(device, seq, head);
      }
    }
    throw new SyncHttpError(status, `sync: push refused (${status}): ${describe(body)}`);
  }

  async pull(have: VersionVector, limit?: number): Promise<PullResult> {
    const request: PullRequest = limit === undefined ? { have } : { have, limit };
    const { status, body } = await this.post(SYNC_PULL_PATH, request);
    if (!ok(status)) throw new SyncHttpError(status, `sync: pull refused (${status}): ${describe(body)}`);
    const parsed = parsePullResult(body);
    if (!parsed.ok) throw new SyncHttpError(status, `sync: hub sent a malformed pull (${parsed.error})`);
    return parsed.value;
  }

  private async post(path: string, body: unknown): Promise<Reply> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    const json = JSON.stringify(body);
    if (!this.channel) {
      const res = await this.opts.fetch(`${this.base}${path}`, { method: "POST", headers, body: json });
      return { status: res.status, body: parseJson(await res.text()) };
    }
    const { nonce, envelope } = this.channel.sealRequest(path, json);
    const res = await this.opts.fetch(`${this.base}${path}`, { method: "POST", headers, body: envelope });
    const reply = this.channel.openResponse(nonce, await res.text());
    if (!reply) throw new SyncSealError();
    return { status: reply.status, body: parseJson(reply.body) };
  }
}

const ok = (status: number): boolean => status >= 200 && status < 300;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describe(body: unknown): string {
  const error = (body as { error?: unknown } | undefined)?.error;
  return typeof error === "string" ? error : "no detail";
}
