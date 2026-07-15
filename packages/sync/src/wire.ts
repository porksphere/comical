/**
 * The sync wire contract: what a client pushes to a hub and what a hub returns on pull.
 *
 * The client (`comical-app`) and the hub (`@comical/host-server`) are separately deployed and
 * update independently, so this is a real boundary — the hub validates everything it is handed
 * rather than trusting it. A malformed HLC is the dangerous case: the cursor's total order relies on
 * packed stamps comparing lexically (see hlc.ts), so a stamp that isn't zero-padded would silently
 * sort wrong and make a device miss records forever. `hlcSchema` is what keeps that from entering
 * the store.
 */
import { z } from "zod";
import type { Envelope } from "./crdt.ts";
import { isTableId, type TableId } from "./tables.ts";

/** The unit exchanged with a backend: an addressed, stamped envelope. */
export type SyncRecord = { table: TableId; id: string; env: Envelope };

/** Everything newer than a cursor, plus the cursor to resume from next time. */
export type PullResult = { records: SyncRecord[]; cursor: string | null };

/** Packed HLC: `<physical:15>:<counter:6>:<node>` — the zero-padding is what makes it sort lexically. */
export const hlcSchema = z.string().regex(/^\d{15}:\d{6}:\S+$/, "malformed HLC stamp");

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
  read: z.boolean(),
  lastPage: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative(),
  number: z.number().optional(),
  languageCode: z.string().optional(),
});

export const envelopeSchema = z.discriminatedUnion("kind", [registerSchema, setSchema, progressSchema]);

export const syncRecordSchema = z.object({
  // Refining against the allow-list (rather than a hand-written enum) means a table added to
  // TABLE_STRATEGY is accepted here automatically, and one removed is rejected automatically.
  table: z.string().refine(isTableId, "unknown sync table"),
  id: z.string().min(1),
  env: envelopeSchema,
});

/**
 * Validate a pushed body. Returns the records, or an error message to hand back as a 400.
 *
 * The cast is the one place the validated shape is tied back to `SyncRecord`: zod infers `table` as
 * `string` (it is refined, not enumerated) and an `unknown` register value as optional, neither of
 * which it can express as the nominal type. Everything the type asserts has just been checked above.
 */
export function parseSyncRecords(input: unknown): { ok: true; records: SyncRecord[] } | { ok: false; error: string } {
  const parsed = z.array(syncRecordSchema).safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid sync records" };
  }
  return { ok: true, records: parsed.data as SyncRecord[] };
}

/** A pull cursor: a packed HLC, or absent for "from the beginning". */
export function parseCursor(input: string | null | undefined): { ok: true; cursor: string | null } | { ok: false; error: string } {
  if (!input) return { ok: true, cursor: null };
  const parsed = hlcSchema.safeParse(input);
  return parsed.success ? { ok: true, cursor: parsed.data } : { ok: false, error: "malformed cursor" };
}

/**
 * Account ids partition a hub between users. They are derived client-side from the pairing secret,
 * but the hub still constrains the shape — it becomes a filename.
 */
const ACCOUNT_RE = /^[A-Za-z0-9_-]{1,128}$/;
export function isValidAccountId(account: string | null | undefined): account is string {
  return typeof account === "string" && ACCOUNT_RE.test(account);
}
