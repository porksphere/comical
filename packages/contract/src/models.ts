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

/** Corner of a card's cover a {@link cardBadge} anchors to (clients default to top-right). */
export const cardBadgePositionSchema = z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]);
export type CardBadgePosition = z.infer<typeof cardBadgePositionSchema>;

/**
 * A small label a bridge can paint onto a series card's cover in search/list/home grids — e.g. a
 * language tag ("EN"), an age rating, or "NEW". Presentation-as-data: the bridge supplies the text +
 * placement and each client renders it with native primitives (web absolutely-positions a span,
 * native clients overlay a label). Purely decorative metadata — hosts that don't render badges
 * degrade gracefully (the card is unaffected). Per-bridge mapping of native data into badges is the
 * configurability; the contract just carries the typed value.
 */
export const cardBadgeSchema = z.object({
  /** Short label shown on the card — kept terse (a few characters / one word). */
  text: z.string().min(1).max(16),
  /** Which corner of the cover to anchor to; clients default to top-right when omitted. */
  position: cardBadgePositionSchema.optional(),
  /** Optional semantic tone so clients can colour the badge consistently (styling is the client's). */
  tone: z.enum(["neutral", "info", "warn", "success"]).optional(),
});
export type CardBadge = z.infer<typeof cardBadgeSchema>;

/** A lightweight series entry as returned by search / home / popular / latest. */
export const seriesEntrySchema = z.object({
  /** Opaque, bridge-namespaced, stable-across-sessions identifier. */
  id: z.string().min(1),
  title: z.string().min(1),
  thumbnailUrl: z.string().url().optional(),
  subtitle: z.string().optional(),
  /**
   * Bridge-defined badges overlaid on the card's cover (language, rating, "NEW", …). Optional and
   * additive — older bridges omit it and clients that don't render badges ignore it. Capped so a
   * bridge can't bury a card under labels.
   */
  badges: z.array(cardBadgeSchema).max(4).optional(),
  /**
   * Set by a bridge (capability "exclude-tags") when this slot matched the user's persistent tag
   * exclusions. The entry is a redacted placeholder: `title` carries no real name and
   * `thumbnailUrl` is intentionally omitted so the host renders a blank card and never fetches a
   * cover. Hosts unaware of this flag degrade gracefully to a coverless, neutrally-titled card.
   */
  excluded: z.boolean().optional(),
});
export type SeriesEntry = z.infer<typeof seriesEntrySchema>;

/** Optional semantic hint so hosts that care can treat a group specially; free-form `label` drives display. */
export const tagKindSchema = z.enum(["genre", "theme", "demographic", "format", "content-warning", "other"]);
export type TagKind = z.infer<typeof tagKindSchema>;

/**
 * A labeled group of series tags. Sites categorize differently (genres / themes / demographics /
 * format / content-warnings / free-form tags); a bridge surfaces each grouping faithfully, one group
 * per axis. There is no separate normalized `genres` field — genres are simply a group with
 * `kind: "genre"` (conventionally `label: "Genres"`), so every taxonomy is rendered by one path.
 */
export const tagGroupSchema = z.object({
  /** Display label, e.g. "Themes", "Demographics", "Content Warnings". */
  label: z.string().min(1),
  kind: tagKindSchema.optional(),
  tags: z.array(z.string()),
  /** Bridge-internal IDs parallel to `tags` (same index). Hosts use these for filter lookups. */
  tagIds: z.array(z.string()).optional(),
  /**
   * Parallel to `tags` (same index): a ready-to-run search query string for each tag. When present,
   * hosts run a free-text search with this string on tag click (instead of selecting a tag filter) —
   * for backends whose tags aren't a filterable id set but whose search box accepts tag syntax (e.g.
   * a source whose query language supports `female:"big breasts$"`). Mutually exclusive with `tagIds`
   * per group in practice.
   */
  tagQueries: z.array(z.string()).optional(),
});
export type TagGroup = z.infer<typeof tagGroupSchema>;

/**
 * Optional semantic hint for a related-series group so hosts that care can treat a group specially
 * (icon, ordering); the free-form `label` still drives display. Sites model relatedness differently —
 * editorial links (sequel/prequel/spin-off/…) vs algorithmic rails (similar/recommended).
 */
export const relatedKindSchema = z.enum([
  "sequel",
  "prequel",
  "spin-off",
  "side-story",
  "alternative",
  "same-universe",
  "adaptation",
  "recommended",
  "similar",
  "other",
]);
export type RelatedKind = z.infer<typeof relatedKindSchema>;

/**
 * A labeled group of related series surfaced on a detail page (e.g. "Sequels", "Same Universe",
 * "Similar"). Mirrors {@link tagGroupSchema}: a free-form `label` plus an optional `kind`, but the
 * payload is full {@link seriesEntrySchema} cards so hosts can render tappable rails that navigate
 * straight to each series. Each bridge maps its own native related-data into whatever groups make
 * sense — that per-bridge mapping is the configurability.
 */
export const relatedSeriesGroupSchema = z.object({
  /** Display label, e.g. "Sequels", "Spin-offs", "Same Universe", "Similar". */
  label: z.string().min(1),
  kind: relatedKindSchema.optional(),
  /** The related series as lightweight cards; never empty (omit the group instead). */
  series: z.array(seriesEntrySchema).min(1),
});
export type RelatedSeriesGroup = z.infer<typeof relatedSeriesGroupSchema>;

/**
 * A single named credit (author or artist) with an optional bridge-namespaced id. The id, when
 * present, lets a host filter precisely (e.g. by an author page) rather than re-searching the name.
 * Splitting a site's "A, B & C" credit line into individual people is the bridge's job — it knows
 * its own format — so multi-credit works portably without each client guessing separators.
 */
export const creditSchema = z.object({
  name: z.string().min(1),
  id: z.string().min(1).optional(),
});
export type Credit = z.infer<typeof creditSchema>;

/** Full detail for a single series. */
export const seriesInfoSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  thumbnailUrl: z.string().url().optional(),
  /**
   * Author/artist credit lines. `author`/`artist` (+ `*Id`) are the single-value convenience form
   * kept for back-compat; `authors`/`artists` are the richer multi-credit form a bridge fills in when
   * a series has several people, each individually filterable. A client prefers the array when present
   * and otherwise falls back to the single string. Bridges should set both for the primary credit.
   */
  author: z.string().optional(),
  authorId: z.string().optional(),
  artist: z.string().optional(),
  artistId: z.string().optional(),
  authors: z.array(creditSchema).optional(),
  artists: z.array(creditSchema).optional(),
  description: z.string().optional(),
  /**
   * The series' overall type / format / category as one short label (e.g. "Manga", "Doujinshi",
   * "Webtoon", "Artist CG"). Distinct from the genre tag group — it answers "what kind of thing is
   * this", not "what is it about". Hosts render it as a single Type metadata cell beside status/author
   * rather than mixing it into the genre chips. Bridges that only have this one taxonomy still use it here.
   */
  type: z.string().min(1).optional(),
  /**
   * All site taxonomies, each a labeled group: genres (`kind: "genre"`), themes, demographics, format,
   * content warnings, free-form tags, … A bridge emits genres as a `{ kind: "genre", label: "Genres" }`
   * group like any other axis — there is no separate flat `genres` field.
   */
  tagGroups: z.array(tagGroupSchema).optional(),
  /**
   * Related series surfaced on the detail page, grouped and labeled by the bridge (sequels,
   * spin-offs, "same universe", algorithmic "similar"/"recommended", …). Hosts render each group as
   * a rail of tappable cards; bridges omit the field when there is nothing related to show.
   */
  relatedSeriesGroups: z.array(relatedSeriesGroupSchema).optional(),
  status: seriesStatusSchema.optional(),
  languages: z.array(z.string()).optional(),
  /**
   * Known cross-service identifiers for this series, keyed by tracker id (e.g. "anilist", "mal").
   * Populated by bridges that expose external mappings. Used by the tracker system to auto-link
   * library entries to tracker entries without manual matching.
   */
  externalIds: z.record(z.string(), z.union([z.string().min(1), z.number().int().positive()])).optional(),
  /**
   * Total page count for direct (page-flat) series, when the bridge can supply it
   * without fetching the full page list. Hosts render it as a metadata cell.
   */
  pageCount: z.number().int().positive().optional(),
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

/**
 * A page-preview thumbnail. A discriminated union so the same contract serves every client:
 *
 *  - `image` — a ready-to-display URL (absolute or server-relative). Render with a normal image
 *    element / native image loader.
 *  - `sprite` — slice-metadata for a tile inside a shared sprite sheet (some sources, e.g.
 *    a source's viewer, pack ~20 thumbnails into one image). The client fetches `sheetUrl` **once**
 *    (it's shared across the page's tiles, so it caches) and crops the `{x,y,w,h}` rect itself —
 *    no server-side recompression, so the original pixels are preserved. Web renders an inline SVG
 *    with a matching `viewBox`; native clients region-decode the rect (`BitmapRegionDecoder` on
 *    Android, `CGImage(cropping:)` on iOS). `sheetWidth`/`sheetHeight` are the full sheet's pixel
 *    dimensions, needed to scale the crop correctly.
 */
export const pageThumbnailSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("image"), url: z.string().min(1) }),
  z.object({
    kind: z.literal("sprite"),
    sheetUrl: z.string().min(1),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative().default(0),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
    sheetWidth: z.number().int().positive(),
    sheetHeight: z.number().int().positive().optional(),
  }),
]);
export type PageThumbnail = z.infer<typeof pageThumbnailSchema>;

/** A single readable page. `imageUrl` is an absolute URL or a server-relative path (e.g. `/bridges/…/page-image/…`); `headers` carry any referer/auth. */
export const pageSchema = z.object({
  index: z.number().int().nonnegative(),
  imageUrl: z.string().min(1),
  /** Optional cheaper preview variant (image URL or sprite-sheet slice metadata). */
  thumbnail: pageThumbnailSchema.optional(),
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
  z.object({
    type: z.literal("multiselect"),
    key: z.string(),
    label: z.string(),
    options: z.array(optionSchema),
    /** When true, each option cycles through inactive → include → exclude. Value shape becomes { include, exclude }. */
    excludable: z.boolean().optional(),
    /** When true, all options start selected (UI semantics: uncheck to exclude). Value is still string[] of selected. */
    defaultAll: z.boolean().optional(),
  }),
  /** Options fetched live via GET /bridges/:id/tags?q=:query. */
  z.object({
    type: z.literal("tag-multiselect"),
    key: z.string(),
    label: z.string(),
    /** When true, each tag chip has a mode toggle (include/exclude). Value shape becomes { include, exclude }. */
    excludable: z.boolean().optional(),
  }),
]);
export type Filter = z.infer<typeof filterSchema>;

/**
 * A concrete filter value supplied to a search. `value` shape depends on the filter kind:
 * text → string, toggle → boolean, number → number, select → string, multiselect → string[].
 * Sorting is a SEPARATE concern (filters narrow a set; sort orders it) — see SortOption/SortSelection.
 */
/** Value shape for excludable multiselect and tag-multiselect filters. */
export const filterIncludeExcludeSchema = z.object({
  include: z.array(z.string()),
  exclude: z.array(z.string()),
});
export type FilterIncludeExclude = z.infer<typeof filterIncludeExcludeSchema>;

/**
 * Normalise a filter value into { include, exclude } regardless of whether the bridge received the
 * new object shape or the legacy string[]. Bridges that declare `excludable: true` should call this
 * instead of casting to string[] directly.
 */
export function parseFilterIncludeExclude(value: unknown): FilterIncludeExclude {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && "include" in value) {
    const v = value as Partial<FilterIncludeExclude>;
    return { include: v.include ?? [], exclude: v.exclude ?? [] };
  }
  if (Array.isArray(value)) return { include: value as string[], exclude: [] };
  return { include: [], exclude: [] };
}

export const filterValueSchema = z.object({
  key: z.string(),
  value: z.union([z.string(), z.array(z.string()), z.number(), z.boolean(), filterIncludeExcludeSchema]),
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
  /**
   * When true, this list is a standalone top-level page that appears in the host's page selector
   * (alongside Home and Favorites) rather than as a section on the Home screen. Hosts that don't
   * understand this field gracefully degrade by showing it as a normal home section.
   */
  page: z.boolean().optional(),
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
  "settings",
  "favorites",
  "direct",
  "read-sync",
  /**
   * Honors persistent per-bridge tag exclusions natively: the host injects the user's configured
   * `excludedTags` into `SearchOptions`/`ListOptions` and the bridge pushes them to its backend's
   * negation. Advertise this ONLY when exclusion costs no extra request on the result path; without
   * it, configured exclusions are stored but inert.
   */
  "exclude-tags",
  /**
   * Resolves bare tag ids to labels via `resolveTags(ids)` — the inverse of the name-keyed `getTags`
   * search. The host uses it to put names back on ids it persists (e.g. `excludedTags`) without the
   * client carrying labels. Without it, such ids are displayed as their raw id.
   */
  "resolve-tags",
  /**
   * Provides related series separately from the main detail via `getRelatedSeries(seriesId)`.
   * The host calls this lazily after the detail page renders so the related rail doesn't block the
   * initial content. Bridges advertising this should NOT include `relatedSeriesGroups` in their
   * `getSeriesDetails` response.
   */
  "related-series",
]);
export type BridgeCapability = z.infer<typeof bridgeCapabilitySchema>;

/**
 * Reserved per-bridge settings key under which the host persists the user's tag exclusions
 * (a `string[]`). It is host-managed: bridges must NOT declare a `getSettings()` descriptor with
 * this key. The host reads it from storage and forwards it via `options.excludedTags` to bridges
 * advertising the `"exclude-tags"` capability — it is never passed as a bridge setting.
 */
export const EXCLUDED_TAGS_KEY = "excludedTags" as const;

/**
 * Reading status values a bridge may report or receive when the bridge supports `"read-sync"`.
 * Maps naturally onto the tracking status systems of example-bridge, Komga, AniList, and MAL.
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
 * Canonical bridge/tracker id pattern: one or more `.`-separated lowercase kebab segments, e.g.
 * `example` (unscoped) or `acme.example` (publisher-scoped). The optional leading segments are a
 * **publisher scope** (reverse-DNS / Java-package style) that makes the id globally unique across
 * registries and independent of the registry URL — two operators publishing an `example` don't
 * clash, and moving a registry's URL never changes a bridge's identity. `.` is deliberately chosen
 * over `/` so the id stays a single url-safe path segment (it flows through `/bridges/:id/…` routes
 * and `cacheDir/<id>/…` paths unencoded); each segment must start alphanumeric, so `..`, leading/
 * trailing dots, and path-traversal are all rejected.
 */
export const BRIDGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;

/**
 * Split a bridge id into its publisher `scope` (everything before the last `.`, if any) and bare
 * `name` (the final segment). `parseBridgeId("acme.example")` → `{ scope: "acme", name: "example" }`;
 * `parseBridgeId("example")` → `{ name: "example" }` (unscoped). Useful for display (show `name`,
 * badge `scope`) and for the future trust layer (bind a scope to a registry's key).
 */
export function parseBridgeId(id: string): { scope?: string; name: string } {
  const i = id.lastIndexOf(".");
  if (i === -1) return { name: id };
  return { scope: id.slice(0, i), name: id.slice(i + 1) };
}

/**
 * Self-description of a bridge. Note there is deliberately NO backend URL here — the address
 * and credentials of the user's backend arrive at runtime through settings.
 */
export const bridgeInfoSchema = z.object({
  /**
   * Stable, url-safe, lowercase id — optionally publisher-scoped (`scope.name`). Namespaces every
   * entity id this bridge emits. See {@link BRIDGE_ID_PATTERN}.
   */
  id: z.string().regex(BRIDGE_ID_PATTERN, "id must be lowercase kebab-case, optionally scoped as scope.name"),
  name: z.string().min(1),
  /** Semver of the bridge implementation itself. */
  version: z.string(),
  /** Semver of the contract this bridge targets (see CONTRACT_VERSION). */
  contractVersion: z.string(),
  languages: z.array(z.string()).min(1),
  nsfw: z.boolean(),
  capabilities: z.array(bridgeCapabilitySchema),
  /**
   * Whether this bridge's series entries carry a `subtitle` (the secondary line under a card's
   * title — latest chapter, author, …). A presentation-layout hint, not a behaviour switch: card
   * grids reserve a FIXED per-card height up front (virtualized lists need it before entries
   * arrive), so a bridge that never emits subtitles declaring nothing (the default) lets clients
   * drop the reserved subtitle line instead of rendering a blank band under every card. Additive
   * and optional — omitted means "no subtitles".
   */
  cardSubtitles: z.boolean().optional(),
  /** Absolute URL (or data URI) to a small square icon representing the bridge/source. Optional. */
  iconUrl: z.string().url().optional(),
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
  /**
   * Declares the hosts this bridge serves assets from through the host's image proxy (the routes
   * behind the server-relative `/img-proxy?url=…` URLs this bridge emits), plus an optional Referer
   * some backends require to serve them. The host derives its proxy allowlist *entirely* from the
   * loaded bridges' declarations — the core hardcodes no source's hostnames — so a bridge that never
   * emits proxy URLs omits this. `hosts` entries match a target host exactly or as a parent domain
   * (e.g. `"example.net"` also allows `cdn.example.net`); the allowlist is an SSRF boundary, so keep
   * it to the hosts genuinely needed.
   */
  assetProxy: z
    .object({
      hosts: z.array(z.string().min(1)).min(1),
      referer: z.string().url().optional(),
    })
    .optional(),
});
export type BridgeInfo = z.infer<typeof bridgeInfoSchema>;
