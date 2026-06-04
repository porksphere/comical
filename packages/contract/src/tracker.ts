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

export interface TrackerEntryUpdate {
  status?: TrackerStatus;
  /** Decimal chapter number read (matches `Chapter.number`). */
  chaptersRead?: number;
  /** 0–100 normalized score; tracker converts to its own scale internally. */
  score?: number;
  notes?: string;
}

export const trackerLibraryEntrySchema = z.object({
  externalId: z.union([z.string().min(1), z.number().int().positive()]),
  title: z.string().min(1),
  status: trackerStatusSchema,
  chaptersRead: z.number().optional(),
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
