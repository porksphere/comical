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

export const envelopeSchema = z.discriminatedUnion("kind", [registerSchema, setSchema, progressSchema]);

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
