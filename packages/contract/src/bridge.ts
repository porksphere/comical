/**
 * The `Bridge` interface — what a bridge must implement — and the module contract by which a
 * bridge bundle is loaded.
 */
import type { HostCapabilities } from "./capabilities.ts";
import type {
  BridgeInfo,
  Chapter,
  Filter,
  FilterValue,
  Page,
  PagedResults,
  SeriesEntry,
  SeriesInfo,
  SeriesList,
  SettingDescriptor,
  Tag,
} from "./models.ts";

export interface Bridge {
  readonly info: BridgeInfo;

  // ---- Required read path ----

  /** Full detail for a series id previously emitted by this bridge. */
  getSeriesDetails(seriesId: string): Promise<SeriesInfo>;

  /** Ordered chapter list for a series. Order is the bridge's responsibility. */
  getChapters(seriesId: string): Promise<Chapter[]>;

  /** Resolve the readable pages (absolute image URLs) for a chapter. */
  getChapterPages(seriesId: string, chapterId: string): Promise<Page[]>;

  // ---- Optional capabilities (advertise via BridgeInfo.capabilities) ----

  /**
   * Browse — capability "lists". The bridge's self-defined catalog of browsable collections
   * (Trending, Recently Updated, a genre, …). `query` optionally filters a large catalog; small
   * bridges may ignore it.
   */
  getLists?(query?: string): Promise<SeriesList[]>;

  /** Entries within a list, by the list's id. `page` is 1-based. (capability "lists") */
  getListItems?(listId: string, page: number): Promise<PagedResults<SeriesEntry>>;

  /** Text search across the backend, with optional filters. `page` is 1-based. (capability "search") */
  getSearchResults?(
    query: string,
    page: number,
    filters?: FilterValue[],
  ): Promise<PagedResults<SeriesEntry>>;

  getFilters?(): Promise<Filter[]>;
  getTags?(): Promise<Tag[]>;

  /**
   * Declarative settings this bridge needs from the user (backend URL, credentials, options).
   * Pure/synchronous: it only describes inputs; the host collects values and passes them back
   * through `HostCapabilities.settings`.
   */
  getSettings?(): SettingDescriptor[];
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
