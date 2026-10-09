/**
 * Pure matching helpers for the tracker import — the part of "which source series is this tracker
 * entry?" that needs no bridge, no library and no I/O, kept apart so it can be tested as a table.
 */
import { z } from "zod";
import type { SeriesEntry } from "@comical/contract";
import { trackerStatusSchema } from "@comical/contract";
import { normalizeTitle } from "@comical/library";

/** How many non-exact search hits are offered for the user to pick from. */
export const MAX_IMPORT_CANDIDATES = 3;

/**
 * Most entries one resolve or import call takes. Both run bridge/tracker requests per entry under
 * rate limits of up to a couple of seconds each, so a whole list in one call would be a request
 * that runs for minutes with nothing to show; a host slices the list and drives the batches itself,
 * with progress and a way to cancel. Shared by every host, so the slice size is decided once.
 */
export const MAX_TRACKER_IMPORT_BATCH = 20;

const externalIdSchema = z.union([z.string().min(1), z.number().int().positive()]);

/** Request shape of a resolve call — the tracker entries to find on a bridge. */
export const trackerImportResolveRequestSchema = z.object({
  bridgeId: z.string().min(1),
  entries: z.array(z.object({
    externalId: externalIdSchema,
    title: z.string().min(1),
    altTitles: z.array(z.string().min(1)).optional(),
  })).min(1).max(MAX_TRACKER_IMPORT_BATCH),
});

/** One entry to import, as a host sends it — validated at the boundary like any contract value. */
export const trackerImportItemSchema = z.object({
  externalId: externalIdSchema,
  title: z.string().min(1),
  thumbnailUrl: z.string().url().optional(),
  status: trackerStatusSchema,
  chaptersRead: z.number().nonnegative().optional(),
  totalChapters: z.number().int().positive().optional(),
  bridgeId: z.string().min(1),
  seriesId: z.string().min(1),
});

export const trackerImportRequestSchema = z.object({
  items: z.array(trackerImportItemSchema).min(1).max(MAX_TRACKER_IMPORT_BATCH),
  collectionIds: z.array(z.string().min(1)).optional(),
  seedProgress: z.boolean(),
});

/**
 * Every name a tracker entry goes by, folded with {@link normalizeTitle} so a comparison against a
 * source's title is exact-after-folding. Names that fold to nothing (punctuation only) are dropped —
 * an empty key would match any other empty key.
 */
export function trackerEntryNames(entry: { title: string; altTitles?: string[] | undefined }): Set<string> {
  const names = new Set<string>();
  for (const raw of [entry.title, ...(entry.altTitles ?? [])]) {
    const n = normalizeTitle(raw);
    if (n) names.add(n);
  }
  return names;
}

/** Does any of a series' names fold to one of the tracker entry's? */
export function sharesName(names: Set<string>, series: { title: string; altTitles?: string[] | undefined }): boolean {
  for (const raw of [series.title, ...(series.altTitles ?? [])]) {
    if (names.has(normalizeTitle(raw))) return true;
  }
  return false;
}

/**
 * Split a bridge's search results for one tracker entry into the hit we can accept on the user's
 * behalf and the ones they have to choose between.
 *
 * `exact` is the first result whose title folds to one of the entry's names — same rule as the
 * library's cross-bridge duplicate detection, so what the import matches on its own is exactly what
 * the library would later have called a duplicate anyway. Everything else, including any further
 * exact hits (a source can list a title twice: a reprint, a colored edition), goes to `candidates`
 * in the bridge's own ranking, capped so a long result list doesn't turn the picker into a search
 * page.
 *
 * `confirmed` is a result the caller has already established as the one (its full details carried
 * the tracker's id, or an alternate title that matched); it is taken as `exact` without a title test.
 */
export function matchSearchResults(
  names: Set<string>,
  results: SeriesEntry[],
  confirmed?: SeriesEntry,
): { exact?: SeriesEntry; candidates: SeriesEntry[] } {
  const exact = confirmed ?? results.find((r) => names.has(normalizeTitle(r.title)));
  const candidates = results.filter((r) => r !== exact).slice(0, MAX_IMPORT_CANDIDATES);
  return { ...(exact && { exact }), candidates };
}
