/**
 * Derivation of a bridge's implemented method names from its declared capabilities — the fallback
 * used when the native `initBridge` doesn't report an explicit `methods` list.
 *
 * The authoritative source is the native side: `@comical/core`'s `loadBridge` wraps only the methods
 * a bridge actually defines, so a native build that returns `{ info, methods }` from `comical_init`
 * lets `buildProxyBridge` expose exactly those. This map is the fallback for older native builds.
 *
 * `CAPABILITY_METHODS` is keyed by `BridgeCapability`, and `capabilities.test.ts` asserts it covers
 * every member of `bridgeCapabilitySchema` — so adding a capability to the contract without mapping
 * it here fails the test rather than silently dropping methods (the drift this file once had).
 */
import type { BridgeCapability, BridgeInfo } from "@comical/contract";

/**
 * Capability → the bridge method names it enables. Every `BridgeCapability` must appear (a capability
 * with no dedicated method — e.g. host-injected `"exclude-tags"` — maps to `[]`). Guarded by the test.
 */
export const CAPABILITY_METHODS: Record<BridgeCapability, string[]> = {
  settings: ["getSettings"],
  lists: ["getLists", "getListItems"],
  search: ["getSearchResults"],
  filters: ["getFilters", "getTags"],
  sort: ["getSortOptions"],
  favorites: ["getFavorites", "addFavorite", "removeFavorite", "isFavorite"],
  "read-sync": ["getReadChapters", "markChapterRead", "markChapterUnread", "setSeriesStatus"],
  "resolve-tags": ["resolveTags"],
  "related-series": ["getRelatedSeries"],
  // Host-injected into query options; the bridge exposes no dedicated method for it.
  "exclude-tags": [],
  // The "direct" (chapterless) reader surface. Chaptered series use getChapters/getChapterPages,
  // added unconditionally below since they have no dedicated capability tag.
  direct: ["getSeriesPages", "resolvePage", "getPageThumbnail"],
};

// getSeriesDetails is mandatory (non-optional in the Bridge contract); chapter reading has no
// capability tag, so a non-"direct" bridge is assumed to serve chapters.
const ALWAYS = ["getSeriesDetails"];
const CHAPTERED = ["getChapters", "getChapterPages"];

/** The method names to expose on a proxy for a bridge with the given `info.capabilities`. */
export function methodsForBridge(info: BridgeInfo): string[] {
  const caps = info.capabilities ?? [];
  const methods = new Set<string>(ALWAYS);
  for (const cap of caps) for (const m of CAPABILITY_METHODS[cap] ?? []) methods.add(m);
  if (!caps.includes("direct")) for (const m of CHAPTERED) methods.add(m);
  return [...methods];
}
