/**
 * A hub reached over HTTP. `fetch` is passed in rather than taken from the global, so this package
 * keeps no platform dependency of its own.
 *
 * Given this device's pairing (`pairing.ts`), every exchange goes through the sealed channel
 * (`seal.ts`): the body out is a ciphertext, and a reply that doesn't open as the hub's answer to
 * that very request is refused as not the hub's at all — whatever address it came from and whatever
 * it says.
 */
import type { SyncBackend } from "./backend.ts";
import { SeqConflictError, SeqGapError } from "./log.ts";
import type { Pairing } from "./pairing.ts";
import { sealedChannel, type SealedChannel } from "./seal.ts";
import {
  parsePullResult,
  parsePushRefusal,
  SYNC_PULL_PATH,
  SYNC_PUSH_PATH,
  SYNC_UNPAIR_PATH,
  type PullRequest,
  type PullResult,
  type Segment,
} from "./wire.ts";

export type HttpBackendOptions = {
  /** The hub's origin plus any prefix it is mounted under, without a trailing slash. */
  baseUrl: string;
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>;
  token?: string;
  /** What `pair` returned; with it, nothing crosses in the clear. */
  pairing?: Pairing;
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

/** The reply wasn't sealed by the hub this device paired with: a stranger at that address, or a hub that has since forgotten the pairing. */
export class SyncSealError extends Error {
  constructor() {
    super("sync: the server didn't answer as the paired hub");
    this.name = "SyncSealError";
  }
}

/** The hub unlinked this device. Only the hub can say so, and it will say nothing else until the device pairs again. */
export class SyncUnlinkedError extends Error {
  constructor() {
    super("sync: the hub unlinked this device");
    this.name = "SyncUnlinkedError";
  }
}

type Reply = { status: number; body: unknown };

export class HttpBackend implements SyncBackend {
  private readonly base: string;
  private readonly channel: SealedChannel | null;

  constructor(private readonly opts: HttpBackendOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.channel = opts.pairing ? sealedChannel(opts.pairing.key, opts.pairing.id) : null;
  }

  /** Has the hub forget this device's pairing. Nothing to do on a hub that doesn't pair, or one that already unlinked it. */
  async unpair(): Promise<void> {
    if (!this.channel) return;
    try {
      const { status, body } = await this.post(SYNC_UNPAIR_PATH, {});
      if (!ok(status)) throw new SyncHttpError(status, `sync: unpair refused (${status}): ${describe(body)}`);
    } catch (err) {
      if (!(err instanceof SyncUnlinkedError)) throw err;
    }
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

  async pull(request: PullRequest): Promise<PullResult> {
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
    if (reply.status === 410) throw new SyncUnlinkedError();
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
