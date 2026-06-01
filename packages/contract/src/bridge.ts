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
  HomeSection,
  SeriesEntry,
  SeriesInfo,
  Page,
  PagedResults,
  SettingDescriptor,
  Tag,
} from "./models.ts";

export interface Bridge {
  readonly info: BridgeInfo;

  /** Full detail for a series id previously emitted by this bridge. */
  getSeriesDetails(seriesId: string): Promise<SeriesInfo>;

  /** Ordered chapter list for a series. Order is the bridge's responsibility. */
  getChapters(seriesId: string): Promise<Chapter[]>;

  /** Resolve the readable pages (absolute image URLs) for a chapter. */
  getChapterPages(seriesId: string, chapterId: string): Promise<Page[]>;

  /** Search the backend. `page` is 1-based. */
  getSearchResults(
    query: string,
    page: number,
    filters?: FilterValue[],
  ): Promise<PagedResults<SeriesEntry>>;

  // ---- Optional capabilities (advertise via BridgeInfo.capabilities) ----

  /** Curated home-page sections (presentation-as-data). */
  getHomeSections?(): Promise<HomeSection[]>;
  getPopular?(page: number): Promise<PagedResults<SeriesEntry>>;
  getLatest?(page: number): Promise<PagedResults<SeriesEntry>>;
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
