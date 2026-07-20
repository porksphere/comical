/**
 * Derivation of a tracker's implemented method names from its declared capabilities — the fallback
 * used when the native `initTracker` doesn't report an explicit `methods` list. Parallel to
 * `capabilities.ts`'s bridge equivalent (`CAPABILITY_METHODS`/`methodsForBridge`); see that file's
 * doc comment for why the fallback exists and how the authoritative `methods` list wins when present.
 *
 * `TRACKER_CAPABILITY_METHODS` is keyed by `TrackerCapability`, and `tracker-capabilities.test.ts`
 * asserts it covers every member of `trackerCapabilitySchema`.
 */
import type { TrackerCapability, TrackerInfo } from "@comical/contract";

/** Capability → the tracker method name(s) it enables. Every `TrackerCapability` must appear. */
export const TRACKER_CAPABILITY_METHODS: Record<TrackerCapability, string[]> = {
  "library-sync": ["getLibrary"],
  "status-sync": ["updateEntry"],
  search: ["search"],
  settings: ["getSettings"],
};

/** The method names to expose on a proxy for a tracker with the given `info.capabilities`. */
export function methodsForTracker(info: TrackerInfo): string[] {
  const caps = info.capabilities ?? [];
  const methods = new Set<string>();
  for (const cap of caps) for (const m of TRACKER_CAPABILITY_METHODS[cap] ?? []) methods.add(m);
  return [...methods];
}
