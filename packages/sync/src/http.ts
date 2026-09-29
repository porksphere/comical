/**
 * A hub reached over HTTP. `fetch` is passed in rather than taken from the global, so this package
 * keeps no platform dependency of its own.
 */
import type { SyncBackend } from "./backend.ts";
import { SeqConflictError, SeqGapError } from "./log.ts";
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

export class HttpBackend implements SyncBackend {
  private readonly base: string;

  constructor(private readonly opts: HttpBackendOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
  }

  async push(segment: Segment): Promise<void> {
    const res = await this.post(SYNC_PUSH_PATH, segment);
    if (res.ok) return;
    const body = await readJson(res);
    if (res.status === 409) {
      const refusal = parsePushRefusal(body);
      if (refusal.ok) {
        const { error, device, seq, head } = refusal.value;
        throw error === "seq-conflict" ? new SeqConflictError(device, seq, head) : new SeqGapError(device, seq, head);
      }
    }
    throw new SyncHttpError(res.status, `sync: push refused (${res.status}): ${describe(body)}`);
  }

  async pull(have: VersionVector, limit?: number): Promise<PullResult> {
    const request: PullRequest = limit === undefined ? { have } : { have, limit };
    const res = await this.post(SYNC_PULL_PATH, request);
    const body = await readJson(res);
    if (!res.ok) throw new SyncHttpError(res.status, `sync: pull refused (${res.status}): ${describe(body)}`);
    const parsed = parsePullResult(body);
    if (!parsed.ok) throw new SyncHttpError(res.status, `sync: hub sent a malformed pull (${parsed.error})`);
    return parsed.value;
  }

  private post(path: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    return this.opts.fetch(`${this.base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function describe(body: unknown): string {
  const error = (body as { error?: unknown } | undefined)?.error;
  return typeof error === "string" ? error : "no detail";
}
