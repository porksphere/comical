/**
 * The neutral data models every bridge produces, as zod schemas with inferred TS types.
 *
 * These schemas are the runtime's boundary: `@comical/core` validates whatever a bridge
 * returns against them before handing data to a host, so a buggy or hostile bridge cannot
 * inject malformed data. Keep them backend-agnostic — nothing here names a specific service.
 */
import { z } from "zod";

/** Publication status of a series, normalized across backends. */
export const seriesStatusSchema = z.enum([
  "unknown",
  "ongoing",
  "completed",
  "hiatus",
  "cancelled",
]);
export type SeriesStatus = z.infer<typeof seriesStatusSchema>;

/** A lightweight series entry as returned by search / home / popular / latest. */
export const seriesEntrySchema = z.object({
  /** Opaque, bridge-namespaced, stable-across-sessions identifier. */
  id: z.string().min(1),
  title: z.string().min(1),
  thumbnailUrl: z.string().url().optional(),
  subtitle: z.string().optional(),
});
export type SeriesEntry = z.infer<typeof seriesEntrySchema>;

/** Optional semantic hint so hosts that care can treat a group specially; free-form `label` drives display. */
export const tagKindSchema = z.enum(["genre", "theme", "demographic", "format", "content-warning", "other"]);
export type TagKind = z.infer<typeof tagKindSchema>;

/**
 * A labeled group of series tags. Sites categorize differently (genres / themes / demographics /
 * format / content-warnings / free-form tags); a bridge surfaces each grouping faithfully. `genres`
 * remains the one normalized axis on `SeriesInfo`; everything else lives here.
 */
export const tagGroupSchema = z.object({
  /** Display label, e.g. "Themes", "Demographics", "Content Warnings". */
  label: z.string().min(1),
  kind: tagKindSchema.optional(),
  tags: z.array(z.string()),
  /** Bridge-internal IDs parallel to `tags` (same index). Hosts use these for filter lookups. */
  tagIds: z.array(z.string()).optional(),
});
export type TagGroup = z.infer<typeof tagGroupSchema>;

/** Full detail for a single series. */
export const seriesInfoSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  thumbnailUrl: z.string().url().optional(),
  author: z.string().optional(),
  authorId: z.string().optional(),
  artist: z.string().optional(),
  artistId: z.string().optional(),
  description: z.string().optional(),
  genres: z.array(z.string()).optional(),
  /** Other site taxonomies beyond genres (themes, demographics, format, content warnings, …). */
  tagGroups: z.array(tagGroupSchema).optional(),
  status: seriesStatusSchema.optional(),
  languages: z.array(z.string()).optional(),
  /**
   * Known cross-service identifiers for this series, keyed by tracker id (e.g. "anilist", "mal").
   * Populated by bridges that expose external mappings. Used by the tracker system to auto-link
   * library entries to tracker entries without manual matching.
   */
  externalIds: z.record(z.string(), z.union([z.string().min(1), z.number().int().positive()])).optional(),
});
export type SeriesInfo = z.infer<typeof seriesInfoSchema>;

/** A single chapter/issue within a series. */
export const chapterSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Decimal chapter number when known (e.g. 10.5). */
  number: z.number().optional(),
  volume: z.number().optional(),
  languageCode: z.string().optional(),
  /** The party that produced this version (translation team, publisher, …); disambiguates when a
   *  site carries multiple versions of the same chapter number. Content-neutral by design. */
  group: z.string().optional(),
  /** Number of pages, when the backend exposes it without opening the chapter. */
  pageCount: z.number().int().nonnegative().optional(),
  /** Publication time as epoch milliseconds. */
  publishedAt: z.number().int().optional(),
});
export type Chapter = z.infer<typeof chapterSchema>;

/** A single readable page. `imageUrl` must be absolute; `headers` carry any referer/auth. */
export const pageSchema = z.object({
  index: z.number().int().nonnegative(),
  imageUrl: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type Page = z.infer<typeof pageSchema>;

/** A page of results with cursor-free pagination. */
export interface PagedResults<T> {
  items: T[];
  page: number;
  hasNextPage: boolean;
}
export const pagedResultsSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    page: z.number().int().nonnegative(),
    hasNextPage: z.boolean(),
  });

/** A `{ value, label }` choice — shared by filters and settings `enum` (one option shape). */
export const optionSchema = z.object({ value: z.string(), label: z.string() });
export type Option = z.infer<typeof optionSchema>;

/**
 * Declarative search-filter descriptors a bridge advertises via `getFilters()`. The host renders
 * a control per kind and sends back `FilterValue[]` to `getSearchResults`.
 */
export const filterSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), key: z.string(), label: z.string() }),
  z.object({ type: z.literal("toggle"), key: z.string(), label: z.string() }),
  z.object({ type: z.literal("number"), key: z.string(), label: z.string(), min: z.number().optional(), max: z.number().optional() }),
  z.object({ type: z.literal("select"), key: z.string(), label: z.string(), options: z.array(optionSchema) }),
  z.object({ type: z.literal("multiselect"), key: z.string(), label: z.string(), options: z.array(optionSchema) }),
  /** Options fetched live via GET /bridges/:id/tags?q=:query. Value is string[] of tag IDs. */
  z.object({ type: z.literal("tag-multiselect"), key: z.string(), label: z.string() }),
]);
export type Filter = z.infer<typeof filterSchema>;

/**
 * A concrete filter value supplied to a search. `value` shape depends on the filter kind:
 * text → string, toggle → boolean, number → number, select → string, multiselect → string[].
 * Sorting is a SEPARATE concern (filters narrow a set; sort orders it) — see SortOption/SortSelection.
 */
export const filterValueSchema = z.object({
  key: z.string(),
  value: z.union([z.string(), z.array(z.string()), z.number(), z.boolean()]),
});
export type FilterValue = z.infer<typeof filterValueSchema>;

/** A sort field a bridge offers via `getSortOptions()` (capability "sort"). */
export const sortOptionSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** When true, ascending/descending direction has no meaning for this sort key. Hosts should hide the direction selector. */
  directionless: z.boolean().optional(),
});
export type SortOption = z.infer<typeof sortOptionSchema>;

/** A concrete sort selection supplied to a search: a field key + direction. */
export const sortSelectionSchema = z.object({ key: z.string(), ascending: z.boolean() });
export type SortSelection = z.infer<typeof sortSelectionSchema>;

/** A tag/genre a bridge can enumerate via `getTags()`. */
export const tagSchema = z.object({ id: z.string(), label: z.string() });
export type Tag = z.infer<typeof tagSchema>;

/**
 * A browsable collection a bridge offers — its own self-defined "list" (Trending, Recently
 * Updated, a genre, Staff Picks, …). The catalog is returned by `getLists()`; a list's paginated
 * entries are fetched with `getListItems(listId, page)`.
 *
 * Lists replace the old prescriptive `getPopular`/`getLatest`/`getHomeSections` — each backend
 * declares whatever lists make sense for it. Optional presentation hints (`layout`, `featured`)
 * let a host build a home view as data, without the contract dictating sections.
 *
 * Home composition is positional: a host stacks the lists in the order `getLists()` returns them
 * (array order = top-to-bottom). The `layout` hint says how to render each section:
 *   - `carousel`/`ranked`/`hero` — a horizontal page-1 preview row under the list name, with a
 *     "see all" affordance into the full list (`ranked` numbers items; `hero` spotlights one).
 *   - `grid` — a vertical grid. A grid renders as infinite-scroll **when it is the last section**
 *     of the home stack (it owns the page's downward scroll); any earlier grid pages with an
 *     explicit "load more". This makes the "one infinite section, and it's at the bottom"
 *     invariant hold by construction — it's derived from position, never declared.
 */
export const seriesListSchema = z.object({
  /** Stable, bridge-namespaced id passed back to `getListItems`. */
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  /** Presentation hint for hosts building a home view. See the schema doc above for semantics. */
  layout: z.enum(["carousel", "grid", "ranked", "hero"]).optional(),
  /** Whether the host should surface this list prominently (e.g. on a home screen). */
  featured: z.boolean().optional(),
  /** Whether `getListItems` accepts a `query` (and filters/sort) to search within this list. */
  searchable: z.boolean().optional(),
});
export type SeriesList = z.infer<typeof seriesListSchema>;

/**
 * A concrete value a user supplies for a setting. Kinds, not widgets: a host decides how to
 * render each (a `secret` string as a masked field, an `enum` as a picker), but the contract
 * only describes data.
 */
export const settingValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);
export type SettingValue = z.infer<typeof settingValueSchema>;

/** An allowed value for an `enum` setting. */
export const settingOptionSchema = z.object({ value: z.string(), label: z.string() });
export type SettingOption = z.infer<typeof settingOptionSchema>;

/**
 * Declarative per-bridge settings descriptors a bridge advertises via `getSettings()`.
 * THIS is where a backend URL + credentials live — supplied by the user, never baked into
 * the bridge. The host collects values for these and passes them in via `HostCapabilities`.
 *
 * Descriptors are keyed by **value kind**, not by widget. A `string` may be flagged `secret`
 * (API key, token, cookie, password — the host masks it); an `enum` carries the list of
 * expected values so a host can render a picker.
 */
const settingBase = {
  /** Stable key the value is stored under and read back via `host.settings[key]`. */
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().optional(),
};
export const settingDescriptorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("string"),
    ...settingBase,
    default: z.string().optional(),
    placeholder: z.string().optional(),
    /** Mask in UIs and treat as a credential (API key, token, cookie, password, …). */
    secret: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("number"),
    ...settingBase,
    default: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    type: z.literal("boolean"),
    ...settingBase,
    default: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("enum"),
    ...settingBase,
    options: z.array(settingOptionSchema).min(1),
    /** Default is a single value, or an array when `multiple` is set. */
    default: z.union([z.string(), z.array(z.string())]).optional(),
    /** When true, the value is a `string[]` (multi-select). */
    multiple: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("oauth-pin"),
    ...settingBase,
    /** Authorization URL to open in the user's browser. */
    authUrl: z.string(),
    /**
     * When present the user pastes an authorization code; the server exchanges it
     * for a token automatically. When absent the auth URL uses an implicit grant
     * and the user pastes the token directly from the provider's pin page.
     */
    exchange: z.object({
      url: z.string(),
      clientId: z.string(),
      clientSecret: z.string(),
      redirectUri: z.string(),
      /** Token refresh endpoint. When set, the host automatically refreshes on 401. */
      refreshUrl: z.string().optional(),
    }).optional(),
  }),
  z.object({
    type: z.literal("oauth-callback"),
    ...settingBase,
    /**
     * Auth URL template. Placeholders replaced by the server:
     *   {clientId}    — resolved from `exchange.clientIdKey` setting or `exchange.clientId`
     *   {pkce}        — server-generated PKCE code_challenge (plain method, when exchange.pkce = true)
     *   {callbackUrl} — server's local OAuth callback URL
     *   {state}       — random CSRF state token
     */
    authUrlTemplate: z.string(),
    exchange: z.object({
      url: z.string(),
      /** Read client_id from this other setting key (e.g. "clientId"). */
      clientIdKey: z.string().optional(),
      /** Hardcoded client_id (when not per-user). */
      clientId: z.string().optional(),
      /** Read client_secret from this other setting key. */
      clientSecretKey: z.string().optional(),
      /** Hardcoded client_secret. */
      clientSecret: z.string().optional(),
      /** Use PKCE plain method (code_challenge = code_verifier). */
      pkce: z.boolean().optional(),
      /** Token refresh endpoint. When set, the host automatically refreshes on 401. */
      refreshUrl: z.string().optional(),
    }),
  }),
]);
export type SettingDescriptor = z.infer<typeof settingDescriptorSchema>;

/** Capabilities a bridge advertises so hosts can adapt UI/behaviour. */
export const bridgeCapabilitySchema = z.enum([
  "lists",
  "search",
  "filters",
  "sort",
  "tags",
  "settings",
  "favorites",
  "direct",
  "read-sync",
]);
export type BridgeCapability = z.infer<typeof bridgeCapabilitySchema>;

/**
 * Reading status values a bridge may report or receive when the bridge supports `"read-sync"`.
 * Maps naturally onto the tracking status systems of MangaDex, Komga, AniList, and MAL.
 */
export const bridgeSeriesStatusSchema = z.enum([
  "reading",
  "completed",
  "on_hold",
  "dropped",
  "planning",
  "rereading",
]);
export type BridgeSeriesStatus = z.infer<typeof bridgeSeriesStatusSchema>;

/**
 * Self-description of a bridge. Note there is deliberately NO backend URL here — the address
 * and credentials of the user's backend arrive at runtime through settings.
 */
export const bridgeInfoSchema = z.object({
  /** Stable, url-safe, lowercase id. Namespaces every entity id this bridge emits. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase kebab-case"),
  name: z.string().min(1),
  /** Semver of the bridge implementation itself. */
  version: z.string(),
  /** Semver of the contract this bridge targets (see CONTRACT_VERSION). */
  contractVersion: z.string(),
  languages: z.array(z.string()).min(1),
  nsfw: z.boolean(),
  capabilities: z.array(bridgeCapabilitySchema),
  /**
   * Politeness budget for this bridge's backend. The runtime applies it to the gated network as
   * the default (a host may still override per key). Omit to accept the runtime default. The
   * bridge author knows the backend's limits; declaring them here means every host — server, web,
   * iOS, Android — throttles correctly with no per-host configuration.
   */
  rateLimit: z
    .object({
      /** Maximum requests in flight at once. */
      maxConcurrent: z.number().int().positive().optional(),
      /** Minimum milliseconds between successive request starts. */
      minIntervalMs: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type BridgeInfo = z.infer<typeof bridgeInfoSchema>;
