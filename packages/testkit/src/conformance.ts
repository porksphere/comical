/**
 * The bridge evaluator + conformance suite. It runs semantic invariants the schemas alone can't
 * express — referential integrity (round-trips), ordering/uniqueness, id stability, capability↔method
 * agreement — plus behavioral probes (filters narrow, sort reorders, in-list search) and data-quality
 * heuristics, against a loaded bridge.
 *
 * Two entry points:
 *   - `evaluateBridge(bridge, opts)` — never throws on a *bridge* problem; returns a structured
 *     `EvaluationReport` (pass/warn/fail per check + a coverage summary). This powers `comical evaluate`.
 *   - `runConformance(bridge, opts)` — thin wrapper that throws if any check is `fail` (the strict
 *     pass/fail gate used by unit tests and `comical test`).
 *
 * Schema-level guarantees (absolute image URLs, required fields) are already enforced by
 * `@comical/core`'s boundary validation, so a `LoadedBridge` passed here is pre-validated.
 *
 * "Coverage" here = contract/capability coverage + data-quality heuristics — NOT code coverage, and
 * NOT semantic correctness.
 */
import type { Bridge, BridgeCapability, Filter, PagedResults, SeriesEntry } from "@comical/contract";

export interface ConformanceOptions {
  /** A query expected to return ≥1 result from the backend the bridge is wired to. */
  searchQuery?: string;
}

export type Severity = "pass" | "warn" | "fail";

export interface CheckResult {
  /** Short, stable id, e.g. "search.item.title". */
  id: string;
  /** The capability this check belongs to, or "core" for the required read path / self-description. */
  capability: BridgeCapability | "core";
  severity: Severity;
  message: string;
}

export interface EvaluationSummary {
  pass: number;
  warn: number;
  fail: number;
  capabilitiesDeclared: BridgeCapability[];
  /** Declared capabilities a probe actually ran for. */
  capabilitiesExercised: BridgeCapability[];
  /** Exercised capabilities with no `fail` result. */
  capabilitiesPassing: BridgeCapability[];
  /** `fail` iff any check failed. Warnings never fail the verdict. */
  verdict: "pass" | "fail";
}

export interface EvaluationReport {
  bridgeId: string;
  results: CheckResult[];
  summary: EvaluationSummary;
  sampledSeriesId?: string;
  sampledChapterId?: string;
}

/** Back-compat shape returned by `runConformance`. */
export interface ConformanceReport {
  checks: string[];
  sampledSeriesId?: string;
  sampledChapterId?: string;
}

const CAPABILITY_METHOD: Partial<Record<BridgeCapability, keyof Bridge>> = {
  lists: "getLists",
  search: "getSearchResults",
  filters: "getFilters",
  sort: "getSortOptions",
  settings: "getSettings",
  favorites: "getFavorites",
  direct: "getSeriesPages",
  "read-sync": "markChapterRead",
};

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const ids = (r: PagedResults<SeriesEntry>): string => r.items.map((i) => i.id).join(",");

/**
 * Evaluate a loaded bridge and return a structured coverage report. Never throws on a bridge defect
 * (those become `fail`/`warn` results); only a harness bug would throw.
 */
export async function evaluateBridge(
  bridge: Bridge,
  options: ConformanceOptions = {},
): Promise<EvaluationReport> {
  const results: CheckResult[] = [];
  const exercised = new Set<BridgeCapability>();
  const has = (cap: BridgeCapability) => bridge.info.capabilities.includes(cap);

  const rec = (capability: CheckResult["capability"], severity: Severity, id: string, message: string) =>
    results.push({ id, capability, severity, message });
  const pass = (c: CheckResult["capability"], id: string, m: string) => rec(c, "pass", id, m);
  const warn = (c: CheckResult["capability"], id: string, m: string) => rec(c, "warn", id, m);
  const fail = (c: CheckResult["capability"], id: string, m: string) => rec(c, "fail", id, m);

  let firstId: string | undefined;
  let sampledChapterId: string | undefined;

  // ── Self-description ──────────────────────────────────────────────────────
  if (bridge.info.capabilities.length === 0) fail("core", "info.capabilities", "info.capabilities is empty");
  else pass("core", "info.capabilities", `declares ${bridge.info.capabilities.length} capability(ies)`);

  for (const cap of bridge.info.capabilities) {
    const method = CAPABILITY_METHOD[cap];
    if (method && typeof (bridge as unknown as Record<string, unknown>)[method] !== "function") {
      fail("core", `capability.${cap}`, `capability "${cap}" declared but ${String(method)} is not implemented`);
    }
  }
  if (has("lists") && typeof bridge.getListItems !== "function") {
    fail("core", "capability.lists.getListItems", 'capability "lists" declared but getListItems is not implemented');
  }

  // ── Lists (browse) ────────────────────────────────────────────────────────
  if (has("lists") && bridge.getLists && bridge.getListItems) {
    exercised.add("lists");
    try {
      const lists = await bridge.getLists();
      if (!Array.isArray(lists) || lists.length === 0) {
        fail("lists", "lists.nonEmpty", "getLists returned no lists despite the 'lists' capability");
      } else {
        for (const l of lists) {
          if (!l.id) fail("lists", "lists.id", "a list has an empty id");
          if (!l.name) fail("lists", "lists.name", "a list has an empty name");
        }
        pass("lists", "lists.catalog", `getLists returned ${lists.length} list(s)`);

        const first = lists[0]!;
        const items = await bridge.getListItems(first.id, 1);
        if (items.page !== 1) fail("lists", "lists.page", `getListItems page should echo 1, got ${items.page}`);
        if (typeof items.hasNextPage !== "boolean") fail("lists", "lists.hasNextPage", "getListItems hasNextPage must be boolean");
        if (items.items.length === 0) {
          fail("lists", "lists.items", `list "${first.id}" returned no items`);
        } else {
          firstId = items.items[0]!.id;
          pass("lists", "lists.items", `list "${first.id}" returned ${items.items.length} item(s)`);
          dataQualityEntries("lists", items.items, warn);

          const again = await bridge.getListItems(first.id, 1);
          if (ids(items) !== ids(again)) {
            fail("lists", "lists.idStability", `list "${first.id}" item ids are not stable across identical calls`);
          } else pass("lists", "lists.idStability", "list item ids are stable across calls");
        }

        // In-list search probe (only for a list that advertises it).
        const searchable = lists.find((l) => l.searchable);
        if (searchable) {
          exercised.add("search");
          await probeInListSearch(bridge, searchable.id, warn, pass, fail);
        }
      }
    } catch (e) {
      fail("lists", "lists.threw", `lists browse threw: ${msg(e)}`);
    }
  }

  // ── Search ────────────────────────────────────────────────────────────────
  if (has("search") && bridge.getSearchResults) {
    exercised.add("search");
    const query = options.searchQuery ?? "";
    try {
      const results0 = await bridge.getSearchResults(query, 1);
      if (results0.page !== 1) fail("search", "search.page", `search page should echo 1, got ${results0.page}`);
      if (typeof results0.hasNextPage !== "boolean") fail("search", "search.hasNextPage", "search hasNextPage must be boolean");
      for (const item of results0.items) {
        if (!item.id) fail("search", "search.item.id", "a search item has an empty id");
        if (!item.title) fail("search", "search.item.title", "a search item has an empty title");
      }
      if (results0.items.length > 0) {
        firstId ??= results0.items[0]!.id;
        pass("search", "search.items", `search returned ${results0.items.length} item(s)`);
        dataQualityEntries("search", results0.items, warn);
      } else {
        warn("search", "search.items", `search for "${query}" returned no items (try --query)`);
      }
    } catch (e) {
      fail("search", "search.threw", `getSearchResults threw: ${msg(e)}`);
    }
  }

  // ── Filters (descriptors + narrowing probe) ────────────────────────────────
  if (has("filters") && bridge.getFilters) {
    exercised.add("filters");
    try {
      const filters = await bridge.getFilters();
      if (!Array.isArray(filters) || filters.length === 0) {
        fail("filters", "filters.nonEmpty", "getFilters returned none despite the 'filters' capability");
      } else {
        for (const f of filters) {
          if (!f.key) fail("filters", "filters.key", "a filter has an empty key");
          if ((f.type === "select" || f.type === "multiselect") && (!f.options || f.options.length === 0)) {
            fail("filters", "filters.options", `filter "${f.key}" is ${f.type} but has no options`);
          }
        }
        pass("filters", "filters.descriptors", `getFilters returned ${filters.length} filter(s)`);
        await probeFilterEffect(bridge, filters, options.searchQuery ?? "", warn, pass, fail);
      }
    } catch (e) {
      fail("filters", "filters.threw", `getFilters threw: ${msg(e)}`);
    }
  }

  // ── Sort (options + reorder probe) ─────────────────────────────────────────
  if (has("sort") && bridge.getSortOptions) {
    exercised.add("sort");
    try {
      const sorts = await bridge.getSortOptions();
      if (!Array.isArray(sorts) || sorts.length === 0) {
        fail("sort", "sort.nonEmpty", "getSortOptions returned none despite the 'sort' capability");
      } else {
        for (const s of sorts) if (!s.key) fail("sort", "sort.key", "a sort option has an empty key");
        pass("sort", "sort.options", `getSortOptions returned ${sorts.length} option(s)`);
        await probeSortEffect(bridge, sorts[0]!.key, options.searchQuery ?? "", warn, pass, fail);
      }
    } catch (e) {
      fail("sort", "sort.threw", `getSortOptions threw: ${msg(e)}`);
    }
  }

  // ── Settings (descriptor sanity) ───────────────────────────────────────────
  if (has("settings") && bridge.getSettings) {
    exercised.add("settings");
    try {
      const descriptors = bridge.getSettings();
      const seen = new Set<string>();
      for (const d of descriptors) {
        if (seen.has(d.key)) fail("settings", "settings.uniqueKey", `duplicate setting key "${d.key}"`);
        seen.add(d.key);
        if (d.type === "enum" && (!d.options || d.options.length === 0)) {
          fail("settings", "settings.enumOptions", `enum setting "${d.key}" has no options`);
        }
        if (d.type !== "string" && (d as { secret?: boolean }).secret) {
          fail("settings", "settings.secret", `setting "${d.key}" is ${d.type} but marked secret (secret is string-only)`);
        }
      }
      pass("settings", "settings.descriptors", `getSettings returned ${descriptors.length} descriptor(s)`);
    } catch (e) {
      fail("settings", "settings.threw", `getSettings threw: ${msg(e)}`);
    }
  }

  // ── Favorites (read-only probe; mutations are never auto-called — they hit a real account) ──
  if (has("favorites") && bridge.getFavorites) {
    exercised.add("favorites");
    if (typeof bridge.addFavorite !== "function" || typeof bridge.removeFavorite !== "function") {
      warn("favorites", "favorites.mutations", "favorites is read-only (no add/removeFavorite)");
    }
    try {
      const favs = await bridge.getFavorites(1);
      if (favs.page !== 1) fail("favorites", "favorites.page", `getFavorites page should echo 1, got ${favs.page}`);
      for (const item of favs.items) {
        if (!item.id) fail("favorites", "favorites.item.id", "a favorite has an empty id");
        if (!item.title) fail("favorites", "favorites.item.title", "a favorite has an empty title");
      }
      pass("favorites", "favorites.read", `getFavorites returned ${favs.items.length} item(s)`);
    } catch (e) {
      warn("favorites", "favorites.read", `getFavorites could not be read (authentication required?): ${msg(e)}`);
    }
  }

  // ── Direct-read path (capability "direct") ───────────────────────────────
  if (has("direct") && bridge.getSeriesPages) {
    exercised.add("direct");
    if (firstId) {
      try {
        const pages = await bridge.getSeriesPages(firstId);
        if (pages.length === 0) fail("direct", "direct.pages.empty", "getSeriesPages returned no pages");
        else {
          pass("direct", "direct.pages", `getSeriesPages returned ${pages.length} page(s)`);
          if (pages.every((p) => !p.thumbnailUrl)) {
            warn("direct", "direct.pages.thumbnail", "pages have no thumbnailUrl (no page-preview grid)");
          }
        }
      } catch (e) {
        fail("direct", "direct.pages.threw", `getSeriesPages threw: ${msg(e)}`);
      }
    } else {
      warn("direct", "direct.noSample", "no series id available to probe getSeriesPages");
    }
  }

  // ── Required read path: sampled id → details → chapters → pages ────────────
  if (firstId) {
    try {
      const details = await bridge.getSeriesDetails(firstId);
      if (details.id !== firstId) {
        fail("core", "read.detailsRoundTrip", `getSeriesDetails id round-trip failed: sent "${firstId}", got "${details.id}"`);
      } else pass("core", "read.detailsRoundTrip", "details round-trip the sampled id");
      if (!details.author) warn("core", "read.details.author", "series details have no author");
      if (!details.description) warn("core", "read.details.description", "series details have no description");
      if (!details.genres || details.genres.length === 0) warn("core", "read.details.genres", "series details have no genres");

      if (has("direct")) {
        // Chapter-based read path not applicable for direct bridges.
      } else if (bridge.getChapters) {
        const chapters = await bridge.getChapters(firstId);
        if (!Array.isArray(chapters)) {
          fail("core", "read.chapters.array", "getChapters did not return an array");
        } else {
          const numbers = chapters.map((c) => c.number).filter((n): n is number => typeof n === "number");
          const sorted = [...numbers].sort((x, y) => x - y);
          if (new Set(chapters.map((c) => c.id)).size !== chapters.length) {
            fail("core", "read.chapters.unique", "chapter ids are not unique");
          }
          if (numbers.length === chapters.length && numbers.join() !== sorted.join() && numbers.join() !== [...sorted].reverse().join()) {
            fail("core", "read.chapters.order", "chapters are not in a consistent (asc or desc) numeric order");
          }
          if (chapters.length === 0) {
            warn("core", "read.chapters.empty", "series has no chapters");
          } else {
            pass("core", "read.chapters", `got ${chapters.length} ordered, uniquely-identified chapter(s)`);
            sampledChapterId = chapters[0]!.id;
            const pages = await bridge.getChapterPages!(firstId, sampledChapterId);
            if (pages.length === 0) fail("core", "read.pages", "getChapterPages returned no pages for the first chapter");
            else pass("core", "read.pages", `got ${pages.length} page(s) with absolute image URLs`);
          }
        }
      }
    } catch (e) {
      fail("core", "read.threw", `read path threw: ${msg(e)}`);
    }
  } else if (has("search") || has("lists")) {
    warn("core", "read.noSample", "no item available to sample the read path (search/lists returned nothing)");
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const failedCaps = new Set(results.filter((r) => r.severity === "fail").map((r) => r.capability));
  const declared = bridge.info.capabilities;
  const summary: EvaluationSummary = {
    pass: results.filter((r) => r.severity === "pass").length,
    warn: results.filter((r) => r.severity === "warn").length,
    fail: results.filter((r) => r.severity === "fail").length,
    capabilitiesDeclared: declared,
    capabilitiesExercised: declared.filter((c) => exercised.has(c)),
    capabilitiesPassing: declared.filter((c) => exercised.has(c) && !failedCaps.has(c)),
    verdict: results.some((r) => r.severity === "fail") ? "fail" : "pass",
  };

  const report: EvaluationReport = { bridgeId: bridge.info.id, results, summary };
  if (firstId) report.sampledSeriesId = firstId;
  if (sampledChapterId) report.sampledChapterId = sampledChapterId;
  return report;
}

/** Strict gate: runs the evaluator and throws if any check failed. Returns the passed checks. */
export async function runConformance(
  bridge: Bridge,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const report = await evaluateBridge(bridge, options);
  const failures = report.results.filter((r) => r.severity === "fail");
  if (failures.length > 0) {
    throw new Error(
      `bridge "${bridge.info.id}" failed conformance:\n  - ${failures.map((f) => f.message).join("\n  - ")}`,
    );
  }
  const out: ConformanceReport = { checks: report.results.filter((r) => r.severity === "pass").map((r) => r.message) };
  if (report.sampledSeriesId) out.sampledSeriesId = report.sampledSeriesId;
  if (report.sampledChapterId) out.sampledChapterId = report.sampledChapterId;
  return out;
}

// ── Behavioral probes ─────────────────────────────────────────────────────────

type Rec = (c: CheckResult["capability"], id: string, m: string) => void;

function dataQualityEntries(cap: BridgeCapability, items: SeriesEntry[], warn: Rec): void {
  if (items.length > 0 && items.every((i) => !i.thumbnailUrl)) {
    warn(cap, `${cap}.item.thumbnail`, `${cap} items have no thumbnailUrl`);
  }
}

async function probeInListSearch(
  bridge: Bridge,
  listId: string,
  warn: Rec,
  pass: Rec,
  fail: Rec,
): Promise<void> {
  if (!bridge.getListItems) return;
  try {
    const all = await bridge.getListItems(listId, 1);
    const sample = all.items[0];
    if (!sample) return;
    const token = sample.title.split(/\s+/)[0] ?? sample.title;
    const scoped = await bridge.getListItems(listId, 1, { query: token });
    if (scoped.items.length === 0) {
      warn("search", "search.inList", `in-list search for "${token}" returned nothing`);
    } else if (scoped.items.length <= all.items.length) {
      pass("search", "search.inList", `in-list search narrowed "${listId}" to ${scoped.items.length}/${all.items.length}`);
    } else {
      warn("search", "search.inList", "in-list search did not narrow results");
    }
  } catch (e) {
    fail("search", "search.inList", `in-list search threw: ${msg(e)}`);
  }
}

async function probeFilterEffect(
  bridge: Bridge,
  filters: Filter[],
  query: string,
  warn: Rec,
  pass: Rec,
  fail: Rec,
): Promise<void> {
  if (!bridge.getSearchResults) {
    warn("filters", "filters.effect", "cannot probe filter effect without search");
    return;
  }
  const picked = filters.find(
    (f): f is Extract<Filter, { type: "select" | "multiselect" }> =>
      (f.type === "select" || f.type === "multiselect") && Array.isArray(f.options) && f.options.length > 0,
  );
  if (!picked) {
    warn("filters", "filters.effect", "no select/multiselect filter to probe");
    return;
  }
  const optionValue = picked.options[0]!.value;
  try {
    const base = await bridge.getSearchResults(query, 1);
    const value = picked.type === "multiselect" ? [optionValue] : optionValue;
    const filtered = await bridge.getSearchResults(query, 1, { filters: [{ key: picked.key, value }] });
    if (ids(filtered) === ids(base)) {
      warn("filters", "filters.effect", `applying filter "${picked.key}=${optionValue}" did not change results`);
    } else {
      pass("filters", "filters.effect", `filter "${picked.key}" changed results (${base.items.length}→${filtered.items.length})`);
    }
  } catch (e) {
    fail("filters", "filters.effect", `applying a filter threw: ${msg(e)}`);
  }
}

async function probeSortEffect(
  bridge: Bridge,
  sortKey: string,
  query: string,
  warn: Rec,
  pass: Rec,
  fail: Rec,
): Promise<void> {
  if (!bridge.getSearchResults) {
    warn("sort", "sort.effect", "cannot probe sort effect without search");
    return;
  }
  try {
    const asc = await bridge.getSearchResults(query, 1, { sort: { key: sortKey, ascending: true } });
    const desc = await bridge.getSearchResults(query, 1, { sort: { key: sortKey, ascending: false } });
    if (asc.items.length < 2) {
      warn("sort", "sort.effect", "not enough results to observe sort order");
    } else if (ids(asc) === ids(desc)) {
      warn("sort", "sort.effect", `asc/desc on "${sortKey}" produced identical order`);
    } else {
      pass("sort", "sort.effect", `sort "${sortKey}" reorders results (asc ≠ desc)`);
    }
  } catch (e) {
    fail("sort", "sort.effect", `applying a sort threw: ${msg(e)}`);
  }
}
