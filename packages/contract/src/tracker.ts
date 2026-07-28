/**
 * Tracker interface — the contract between tracker plugins and the runtime.
 *
 * Trackers are loadable CJS bundles (same sandboxing model as bridges) that sync read state to
 * external list-tracking services (AniList, MAL, Kitsu, …). A tracker bundle default-exports a
 * `TrackerFactory`; the host loads it via `loadTracker()` in `@comical/core`.
 */
import { z } from "zod";
import type { HostCapabilities } from "./capabilities.ts";
import type { SettingDescriptor } from "./models.ts";
import type { PagedResults } from "./models.ts";

export const trackerCapabilitySchema = z.enum(["library-sync", "status-sync", "search", "settings"]);
export type TrackerCapability = z.infer<typeof trackerCapabilitySchema>;

export const trackerStatusSchema = z.enum([
  "reading",
  "completed",
  "on_hold",
  "dropped",
  "planning",
  "rereading",
]);
export type TrackerStatus = z.infer<typeof trackerStatusSchema>;

export const trackerInfoSchema = z.object({
  /** Stable, lowercase kebab-case id, e.g. "anilist", "mal". */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase kebab-case"),
  name: z.string().min(1),
  version: z.string(),
  contractVersion: z.string(),
  capabilities: z.array(trackerCapabilitySchema),
  rateLimit: z.object({
    maxConcurrent: z.number().int().positive().optional(),
    minIntervalMs: z.number().int().nonnegative().optional(),
  }).optional(),
});
export type TrackerInfo = z.infer<typeof trackerInfoSchema>;

/**
 * A calendar date, `YYYY-MM-DD`. Tracking services record reading start/finish as a DATE, not an
 * instant — AniList stores a fuzzy `{year, month, day}` and MAL a plain `YYYY-MM-DD` string — so a
 * date string is the lossless shape here. Epoch ms would force every tracker to pick a timezone.
 */
export const trackerDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const trackerEntryUpdateSchema = z.object({
  status: trackerStatusSchema.optional(),
  /** Decimal chapter number read (matches `Chapter.number`). */
  chaptersRead: z.number().optional(),
  /** 0–100 normalized score; tracker converts to its own scale internally. */
  score: z.number().optional(),
  notes: z.string().optional(),
  /** Date reading started. Sent once, on the transition into "reading". */
  startedAt: trackerDateSchema.optional(),
  /** Date reading finished. Sent once, on the transition into "completed". */
  finishedAt: trackerDateSchema.optional(),
});
export type TrackerEntryUpdate = z.infer<typeof trackerEntryUpdateSchema>;

export const trackerLibraryEntrySchema = z.object({
  externalId: z.union([z.string().min(1), z.number().int().positive()]),
  title: z.string().min(1),
  status: trackerStatusSchema,
  chaptersRead: z.number().optional(),
  /**
   * The service's OWN chapter count for this media, when it publishes one. The host uses it both to
   * decide a series is finished (progress has reached the total) and to clamp what it pushes — a
   * tracker is never told about more chapters than it believes exist.
   */
  totalChapters: z.number().int().positive().optional(),
  thumbnailUrl: z.string().url().optional(),
});
export type TrackerLibraryEntry = z.infer<typeof trackerLibraryEntrySchema>;

export const trackerSearchResultSchema = z.object({
  externalId: z.union([z.string().min(1), z.number().int().positive()]),
  title: z.string().min(1),
  thumbnailUrl: z.string().url().optional(),
  description: z.string().optional(),
});
export type TrackerSearchResult = z.infer<typeof trackerSearchResultSchema>;

export interface Tracker {
  readonly info: TrackerInfo;
  getSettings?(): SettingDescriptor[];
  /** capability "library-sync" — pull the user's list from the tracker service. */
  getLibrary?(page: number): Promise<PagedResults<TrackerLibraryEntry>>;
  /** capability "status-sync" — push updated read state to the tracker service. */
  updateEntry?(externalId: string | number, update: TrackerEntryUpdate): Promise<void>;
  /** capability "search" — search the tracker's title database for a manual link. */
  search?(query: string, page: number): Promise<PagedResults<TrackerSearchResult>>;
}

export type TrackerFactory = (host: HostCapabilities) => Tracker;
