/**
 * The `Bridge` interface — what a bridge must implement — and the module contract by which a
 * bridge bundle is loaded.
 */
import type { HostCapabilities } from "./capabilities.ts";
import type {
  BridgeInfo,
  BridgeSeriesStatus,
  Chapter,
  Filter,
  FilterValue,
  GenreExclusions,
  Page,
  PageThumbnail,
  PagedResults,
  RelatedSeriesGroup,
  SeriesEntry,
  SeriesInfo,
  SeriesList,
  SettingDescriptor,
  SortOption,
  SortSelection,
  Tag,
} from "./models.ts";

/** Optional refinements for a search: filters narrow the set, sort orders it. */
export interface SearchOptions {
  filters?: FilterValue[];
  sort?: SortSelection;
  /**
   * Persistent per-bridge tag exclusions the host injects (capability `"exclude-tags"`). The
   * bridge pushes these to its backend's native negation — e.g. excluding a tag from every
   * result — and they are independent of the ad-hoc `filters` a user picks per search. Entries
   * are whatever the bridge's `getTags()` returns as `id` for getTags-capable bridges.
   */
  excludedTags?: string[];
}

/** Optional refinements for browsing a list: an in-list text query, plus filters/sort. */
export interface ListOptions {
  query?: string;
  filters?: FilterValue[];
  sort?: SortSelection;
  /** Persistent per-bridge tag exclusions the host injects (capability `"exclude-tags"`). See `SearchOptions.excludedTags`. */
  excludedTags?: string[];
}

export interface Bridge {
  readonly info: BridgeInfo;

  // ---- Required read path ----

  /** Full detail for a series id previously emitted by this bridge. */
  getSeriesDetails(seriesId: string): Promise<SeriesInfo>;

  /**
   * Related series groups for a series, loaded separately from the main detail so the detail page
   * can render without waiting for the related rail. (capability "related-series")
   *
   * Bridges that implement this should NOT include `relatedSeriesGroups` in their `getSeriesDetails`
   * response — the host will call this lazily and merge the result. Bridges that don't implement it
   * may still return `relatedSeriesGroups` inline in `SeriesInfo`.
   */
  getRelatedSeries?(seriesId: string): Promise<RelatedSeriesGroup[]>;

  /** Ordered chapter list for a series. Order is the bridge's responsibility. */
  getChapters?(seriesId: string): Promise<Chapter[]>;

  /** Resolve the readable pages for a chapter. `imageUrl` may be absolute or a server-relative proxy path. */
  getChapterPages?(seriesId: string, chapterId: string): Promise<Page[]>;

  // ---- Direct-read (capability "direct") ----

  /** Flat page list for a series with no chapter structure. (capability "direct") */
  getSeriesPages?(seriesId: string): Promise<Page[]>;

  /**
   * Resolve the full image URL for a single page, given its filehash and page reference.
   * Used by the host-server's page-image proxy endpoint to lazily fetch CDN URLs on demand
   * rather than resolving all pages upfront in `getSeriesPages`. (capability "direct")
   *
   * @param seriesId - The series identifier.
   * @param hash     - The filehash for the page (e.g. `"a1b2c3d4"`).
   * @param gidRef   - The `{gid}-{pageNum}` string (e.g. `"3992142-5"`).
   * @returns The full, directly-loadable image URL for the page.
   */
  resolvePage?(seriesId: string, hash: string, gidRef: string): Promise<string>;

  /**
   * Return the thumbnail descriptor for a single page by 0-based index. Called by the host-server's
   * per-page thumbnail route to lazily resolve thumbnails not populated by `getSeriesPages`.
   * Bridges that fully populate all thumbnails in `getSeriesPages` need not implement this.
   * (capability "direct")
   */
  getPageThumbnail?(seriesId: string, pageIndex: number): Promise<PageThumbnail>;

  // ---- Read-sync (capability "read-sync") ----
  // Bridges that can write reading state back to their source implement these.
  // The host calls them when local progress is recorded so the source stays in sync.

  /**
   * Return the chapter IDs the remote considers read for a series. Used by the runtime to
   * reconcile divergence during background sync (union merge: if either side is read, mark read).
   * (capability "read-sync")
   */
  getReadChapters?(seriesId: string): Promise<string[]>;

  /** Push a chapter-read event to the source. (capability "read-sync") */
  markChapterRead?(seriesId: string, chapterId: string): Promise<void>;

  /** Mark a chapter unread on the source. (capability "read-sync") */
  markChapterUnread?(seriesId: string, chapterId: string): Promise<void>;

  /** Update the series reading status on the source. (capability "read-sync") */
  setSeriesStatus?(seriesId: string, status: BridgeSeriesStatus): Promise<void>;

  // ---- Optional capabilities (advertise via BridgeInfo.capabilities) ----

  /**
   * Browse — capability "lists". The bridge's self-defined catalog of browsable collections
   * (Trending, Recently Updated, a genre, …). `query` optionally filters a large catalog; small
   * bridges may ignore it.
   */
  getLists?(query?: string): Promise<SeriesList[]>;

  /**
   * Entries within a list, by the list's id. `page` is 1-based. `options` carries an in-list
   * `query` (only honored for lists flagged `searchable`) plus filters/sort. (capability "lists")
   */
  getListItems?(listId: string, page: number, options?: ListOptions): Promise<PagedResults<SeriesEntry>>;

  /** Text search across the backend. `page` is 1-based. `options` carries filters + sort. (capability "search") */
  getSearchResults?(
    query: string,
    page: number,
    options?: SearchOptions,
  ): Promise<PagedResults<SeriesEntry>>;

  /** Search-filter descriptors (capability "filters"). */
  getFilters?(): Promise<Filter[]>;

  /** Sort fields offered for search ordering (capability "sort"). */
  getSortOptions?(): Promise<SortOption[]>;

  getTags?(query?: string): Promise<Tag[]>;

  /**
   * Resolve bare tag ids back to their labels (capability "resolve-tags"). The inverse of the
   * name-keyed `getTags` search: given ids the host holds (e.g. persisted `excludedTags`), return
   * the `{ id, label }` for each it can resolve, silently omitting any it cannot. The host caches
   * the result, so this is called only for ids it has never seen a label for.
   */
  resolveTags?(ids: string[]): Promise<Tag[]>;

  // ---- Genre exclusions — capability "exclude-genres" ----
  // Backed by the bridge's backend account (server-side, applies to every surface), so these typically
  // need auth and throw a clear error when credentials are absent — unlike host-injected `excludedTags`.

  /** The pickable genres plus the account's currently-excluded subset. (capability "exclude-genres") */
  getGenreExclusions?(): Promise<GenreExclusions>;

  /** Replace the account's excluded-genre set (a write-through to the backend); returns the new state. (capability "exclude-genres") */
  setExcludedGenres?(genreIds: string[]): Promise<GenreExclusions>;

  /**
   * Declarative settings this bridge needs from the user (backend URL, credentials, options).
   * Pure/synchronous: it only describes inputs; the host collects values and passes them back
   * through `HostCapabilities.settings`.
   */
  getSettings?(): SettingDescriptor[];

  // ---- Favorites — capability "favorites" ----
  // Backed by the backend's own account bookmarks/follows, so these need auth: the bridge declares
  // an (optional) secret setting and these methods throw a clear error when it's absent — browsing
  // stays anonymous. `getFavorites` is the minimum for the capability; the mutations are independently
  // optional (a backend may expose follows read-only).

  /** The signed-in account's favorited series. `page` is 1-based. */
  getFavorites?(page: number): Promise<PagedResults<SeriesEntry>>;

  /** Add a series to the account's favorites. */
  addFavorite?(seriesId: string): Promise<void>;

  /** Remove a series from the account's favorites. */
  removeFavorite?(seriesId: string): Promise<void>;

  /** Check whether a series is currently in the account's favorites. */
  isFavorite?(seriesId: string): Promise<boolean>;
}

/**
 * A bridge bundle default-exports a factory. The core calls it once with the host capabilities
 * (already namespaced + gated) to obtain a `Bridge` instance. Using a factory (rather than a
 * bare object) lets a bridge capture its settings/host at construction time.
 */
export type BridgeFactory = (host: HostCapabilities) => Bridge;

export interface BridgeModule {
  default: BridgeFactory;
}
