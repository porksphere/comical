/**
 * What crosses between a device and a backend. The backend may be a hub on another version, or a
 * folder any client could have written to, so everything read from it is validated rather than
 * trusted.
 */
import { z } from "zod";
import type { Envelope } from "./crdt.ts";
import { isTableId, type TableId } from "./tables.ts";

export type SyncRecord = { table: TableId; id: string; env: Envelope };

/**
 * One push from one device: its `seq`-th. A device's segments are numbered 1, 2, 3… with no gaps,
 * which is what makes "what haven't I seen" a question with an exact answer.
 */
export type Segment = { device: string; seq: number; records: SyncRecord[] };

/** Highest contiguous `seq` applied, per device. A missing device means nothing seen from it. */
export type VersionVector = Record<string, number>;

export type PullResult = { segments: Segment[]; more: boolean };

/** Device ids name files and folders on dumb backends, so they are constrained to a safe alphabet. */
export const deviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "malformed device id");

export const hlcSchema = z.string().regex(/^\d{15}:\d{6}:[A-Za-z0-9_-]{1,64}$/, "malformed HLC stamp");

const registerSchema = z.object({
  kind: z.literal("register"),
  hlc: hlcSchema,
  value: z.unknown(),
  deleted: z.boolean(),
});

const setSchema = z.object({
  kind: z.literal("set"),
  hlc: hlcSchema,
  present: z.boolean(),
  meta: z.record(z.unknown()).optional(),
});

const progressSchema = z.object({
  kind: z.literal("progress"),
  hlc: hlcSchema,
  reset: hlcSchema.optional(),
  read: z.boolean(),
  lastPage: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative(),
  number: z.number().optional(),
  languageCode: z.string().optional(),
});

const eventSchema = z.object({
  kind: z.literal("event"),
  hlc: hlcSchema,
  value: z.unknown(),
  deleted: z.boolean(),
});

export const envelopeSchema = z.discriminatedUnion("kind", [registerSchema, setSchema, progressSchema, eventSchema]);

export const syncRecordSchema = z.object({
  table: z.string().refine(isTableId, "unknown sync table"),
  id: z.string().min(1),
  env: envelopeSchema,
});

export const segmentSchema = z.object({
  device: deviceIdSchema,
  seq: z.number().int().positive(),
  records: z.array(syncRecordSchema),
});

export const versionVectorSchema = z.record(deviceIdSchema, z.number().int().nonnegative());

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodTypeAny, input: unknown, fallback: string): Parsed<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data as T };
  const issue = parsed.error.issues[0];
  return { ok: false, error: issue ? `${issue.path.join(".")}: ${issue.message}` : fallback };
}

// The casts tie zod's inferred shapes back to the nominal types: `table` is refined rather than
// enumerated, so zod can only call it a string.
export const parseSegment = (input: unknown): Parsed<Segment> => parseWith(segmentSchema, input, "invalid segment");
export const parseVersionVector = (input: unknown): Parsed<VersionVector> =>
  parseWith(versionVectorSchema, input, "invalid version vector");

// ── Over HTTP ────────────────────────────────────────────────────────────────
// A hub serves `POST {base}/sync/push` (a `Segment`, answered 204) and `POST {base}/sync/pull`
// (a `PullRequest`, answered with a `PullResult`). A vector names every device ever seen, so pull
// is a POST rather than a query string that grows without bound.

export const SYNC_PUSH_PATH = "/sync/push";
export const SYNC_PULL_PATH = "/sync/pull";

/** A hub answers at most this many records per pull, whatever a client asks for. */
export const MAX_PULL_LIMIT = 10_000;

/** What a device calls itself to the people looking at the hub ("Tristan's iPhone"). */
export const deviceNameSchema = z.string().trim().min(1).max(64);

/**
 * Every round opens with a pull, so the pull is where a device says who it is: a hub keeps the
 * roster of who has been by from these alone, with nothing extra on the wire.
 */
export type PullRequest = { device: string; name: string; have: VersionVector; limit?: number };

/**
 * A refused push, as a hub reports it (409). `conflict` is a seq reused for different content, which
 * the pusher recovers from by rotating its device id; `gap` is a skipped seq, which it can't.
 */
export type PushRefusal = { error: "seq-conflict" | "seq-gap"; device: string; seq: number; head: number };

export const pullRequestSchema = z.object({
  device: deviceIdSchema,
  name: deviceNameSchema,
  have: versionVectorSchema,
  limit: z.number().int().positive().max(MAX_PULL_LIMIT).optional(),
});

export const pullResultSchema = z.object({ segments: z.array(segmentSchema), more: z.boolean() });

export const pushRefusalSchema = z.object({
  error: z.enum(["seq-conflict", "seq-gap"]),
  device: deviceIdSchema,
  seq: z.number().int().positive(),
  head: z.number().int().nonnegative(),
});

export const parsePullRequest = (input: unknown): Parsed<PullRequest> =>
  parseWith(pullRequestSchema, input, "invalid pull request");
export const parsePullResult = (input: unknown): Parsed<PullResult> => parseWith(pullResultSchema, input, "invalid pull result");
export const parsePushRefusal = (input: unknown): Parsed<PushRefusal> =>
  parseWith(pushRefusalSchema, input, "invalid push refusal");
