/**
 * The reusable bridge conformance suite. Every bridge must pass it. It runs semantic invariants
 * the schemas alone can't express — referential integrity (round-trips), ordering/uniqueness,
 * id stability, and capability↔method agreement — against a loaded bridge.
 *
 * Schema-level guarantees (e.g. absolute image URLs, required fields) are already enforced by
 * `@comical/core`'s boundary validation, so a `LoadedBridge` passed here is pre-validated.
 *
 * Throws an `Error` listing every violation; resolves with a short report on success. Engine-
 * and runner-agnostic: call it inside whatever test wrapper you use.
 */
import type { Bridge, BridgeCapability } from "@comical/contract";

export interface ConformanceOptions {
  /** A query expected to return ≥1 result from the backend the bridge is wired to. */
  searchQuery?: string;
}

export interface ConformanceReport {
  checks: string[];
  sampledSeriesId?: string;
  sampledChapterId?: string;
}

const CAPABILITY_METHOD: Partial<Record<BridgeCapability, keyof Bridge>> = {
  home: "getHomeSections",
  popular: "getPopular",
  latest: "getLatest",
  filters: "getFilters",
  tags: "getTags",
  settings: "getSettings",
};

export async function runConformance(
  bridge: Bridge,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const errors: string[] = [];
  const checks: string[] = [];
  const fail = (msg: string) => errors.push(msg);
  const ok = (msg: string) => checks.push(msg);

  // --- Self-description ---
  if (bridge.info.capabilities.length === 0) fail("info.capabilities is empty");
  else ok("info has capabilities");

  // --- Capability ↔ method agreement ---
  for (const cap of bridge.info.capabilities) {
    const method = CAPABILITY_METHOD[cap];
    if (method && typeof (bridge as unknown as Record<string, unknown>)[method] !== "function") {
      fail(`capability "${cap}" declared but method ${String(method)} is not implemented`);
    }
  }
  if (bridge.info.capabilities.includes("search")) {
    if (typeof bridge.getSearchResults !== "function") fail('capability "search" but no getSearchResults');
  }
  ok("capabilities match implemented methods");

  // --- Search ---
  const query = options.searchQuery ?? "";
  const report: ConformanceReport = { checks };
  let firstId: string | undefined;
  try {
    const results = await bridge.getSearchResults(query, 1);
    if (results.page !== 1) fail(`search page should echo 1, got ${results.page}`);
    if (typeof results.hasNextPage !== "boolean") fail("search hasNextPage must be boolean");
    if (results.items.length === 0) {
      fail(`search returned no items for query "${query}" (provide options.searchQuery)`);
    } else {
      for (const item of results.items) {
        if (!item.id) fail("a search item has an empty id");
        if (!item.title) fail("a search item has an empty title");
      }
      firstId = results.items[0]!.id;
      ok(`search returned ${results.items.length} item(s)`);
    }

    // --- Id stability across calls (proxy for across-sessions) ---
    const again = await bridge.getSearchResults(query, 1);
    const a = results.items.map((i) => i.id).join(",");
    const b = again.items.map((i) => i.id).join(",");
    if (a !== b) fail("search result ids are not stable across identical calls");
    else ok("search ids are stable across calls");
  } catch (e) {
    fail(`getSearchResults threw: ${msg(e)}`);
  }

  // --- Round-trip: search id → details → chapters → pages ---
  if (firstId) {
    report.sampledSeriesId = firstId;
    try {
      const details = await bridge.getSeriesDetails(firstId);
      if (details.id !== firstId) {
        fail(`getSeriesDetails id round-trip failed: sent "${firstId}", got "${details.id}"`);
      } else ok("details round-trip the search id");

      const chapters = await bridge.getChapters(firstId);
      if (!Array.isArray(chapters)) fail("getChapters did not return an array");
      const numbers = chapters.map((c) => c.number).filter((n): n is number => typeof n === "number");
      const sorted = [...numbers].sort((x, y) => x - y);
      const ids = new Set(chapters.map((c) => c.id));
      if (ids.size !== chapters.length) fail("chapter ids are not unique");
      if (numbers.length === chapters.length && numbers.join() !== sorted.join() && numbers.join() !== [...sorted].reverse().join()) {
        fail("chapters are not in a consistent (asc or desc) numeric order");
      }
      if (chapters.length > 0) {
        ok(`got ${chapters.length} ordered, uniquely-identified chapter(s)`);
        const chapterId = chapters[0]!.id;
        report.sampledChapterId = chapterId;
        const pages = await bridge.getChapterPages(firstId, chapterId);
        if (pages.length === 0) fail("getChapterPages returned no pages for the first chapter");
        else ok(`got ${pages.length} page(s) with absolute image URLs`);
      }
    } catch (e) {
      fail(`round-trip threw: ${msg(e)}`);
    }
  }

  // --- Optional: home sections shape ---
  if (bridge.getHomeSections) {
    try {
      const sections = await bridge.getHomeSections();
      if (!Array.isArray(sections)) fail("getHomeSections did not return an array");
      else ok(`home returned ${sections.length} section(s)`);
    } catch (e) {
      fail(`getHomeSections threw: ${msg(e)}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `bridge "${bridge.info.id}" failed conformance:\n  - ${errors.join("\n  - ")}`,
    );
  }
  return report;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
