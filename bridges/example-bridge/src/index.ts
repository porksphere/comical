/**
 * Reference bridge. Demonstrates the full interface by scraping a simple, user-supplied
 * "comic library" website with cheerio. The backend address is a user setting (`baseUrl`) — the
 * bridge ships pointed at nothing. In tests it is aimed at the testkit fixture backend, which
 * serves public-domain titles; in real use a user points it at a site they're authorized to use.
 *
 * The HTML structure parsed here matches `@comical/testkit`'s FixtureBackend.
 */
import {
  BridgeBase,
  type BridgeInfo,
  type CardBadge,
  type CardBadgePosition,
  type Chapter,
  type CheerioRoot,
  type Filter,
  type GenreExclusions,
  type InferSettings,
  type ListOptions,
  type Page,
  type PagedResults,
  type RelatedKind,
  type RelatedSeriesGroup,
  type SearchOptions,
  type SeriesEntry,
  type SeriesInfo,
  type SeriesList,
  type SeriesStatus,
  type SettingDescriptor,
  type SortOption,
  type SortSelection,
  type Tag,
  type TagGroup,
  type TagKind,
  defineBridge,
  defineSettings,
} from "@comical/sdk";

const STATUSES: ReadonlySet<string> = new Set<SeriesStatus>([
  "unknown",
  "ongoing",
  "completed",
  "hiatus",
  "cancelled",
]);

/** Typed settings: `baseUrl` (required string) + a `defaultSort` enum (the picker kind). */
const SETTINGS = defineSettings([
  {
    type: "string",
    key: "baseUrl",
    label: "Backend base URL",
    placeholder: "https://library.example",
    required: true,
  },
  {
    type: "enum",
    key: "defaultSort",
    label: "Default sort",
    description: "Applied to lists and search when no explicit sort is chosen.",
    options: [
      { value: "title", label: "Title" },
      { value: "author", label: "Author" },
    ],
    default: "title",
  },
  {
    type: "string",
    key: "sessionToken",
    label: "Session token",
    description: "Auth token for favorites. Browsing works without it; favorites require it.",
    secret: true,
  },
]);
type Settings = InferSettings<typeof SETTINGS>;

class ExampleBridge extends BridgeBase<Settings> {
  readonly info: BridgeInfo = {
    id: "example",
    name: "Example (Demo Library)",
    version: "0.1.0",
    contractVersion: "1.0.0",
    languages: ["en"],
    nsfw: false,
    capabilities: ["lists", "search", "filters", "sort", "settings", "favorites", "exclude-tags", "exclude-genres", "resolve-tags"],
    iconUrl: "https://example.com/favicon.ico",
  };

  /** The pickable genre universe for the "exclude-genres" control (mirrors the genre filter axis). */
  private static readonly GENRES = ["Fantasy", "Adventure", "Mystery", "Crime", "Horror", "Gothic"];
  /** Currently-excluded genres. In a real bridge this lives on the backend account; here it's in-memory
   *  state on the (manager-cached) instance — enough to exercise the host read/write round-trip. */
  private excludedGenres: string[] = [];

  getSettings(): SettingDescriptor[] {
    return [...SETTINGS];
  }

  getGenreExclusions(): Promise<GenreExclusions> {
    return Promise.resolve({
      available: ExampleBridge.GENRES.map((g) => ({ id: g, label: g })),
      excluded: [...this.excludedGenres],
    });
  }

  setExcludedGenres(genreIds: string[]): Promise<GenreExclusions> {
    const allowed = new Set(ExampleBridge.GENRES);
    this.excludedGenres = [...new Set(genreIds)].filter((g) => allowed.has(g));
    return this.getGenreExclusions();
  }

  /** A tiny id→label table so the host's reverse lookup ("resolve-tags") has something to resolve. */
  private static readonly TAG_LABELS: Record<string, string> = {
    t1: "Action",
    t2: "Romance",
    t3: "Comedy",
  };

  /** Resolve bare tag ids to labels (capability "resolve-tags"); ids we don't know are omitted. */
  resolveTags(ids: string[]): Promise<Tag[]> {
    return Promise.resolve(
      ids
        .map((id) => ({ id, label: ExampleBridge.TAG_LABELS[id] }))
        .filter((t): t is Tag => t.label !== undefined),
    );
  }

  private base(): string {
    return this.requireSetting("baseUrl").replace(/\/+$/, "");
  }

  /** Use the caller's sort if given, else fall back to the `defaultSort` setting. */
  private effectiveSort(sort?: SortSelection): SortSelection | undefined {
    if (sort) return sort;
    const fallback = this.setting("defaultSort");
    return fallback ? { key: fallback, ascending: true } : undefined;
  }

  /** Collect every `.series-card` under `scope` into SeriesEntry list, optionally narrowed to
   *  `data-status="ongoing"` (the "ongoing" toggle filter). */
  private cards($: CheerioRoot, scope: string, ongoingOnly = false): SeriesEntry[] {
    const base = this.base();
    return $(`${scope} .series-card`)
      .toArray()
      .filter((el) => !ongoingOnly || $(el).attr("data-status") === "ongoing")
      .map((el) => {
        const node = $(el);
        const href = node.find("a.title").attr("href");
        const id = node.attr("data-id") ?? href?.split("/").pop() ?? "";
        const cover = node.find("img.cover").first().attr("src");
        const author = node.find(".author").first().text().trim();
        const entry: SeriesEntry = {
          id,
          title: node.find("a.title").first().text().trim(),
        };
        if (cover) entry.thumbnailUrl = this.resolve(base, cover);
        if (author) entry.subtitle = author;
        const badges = this.cardBadges($, node);
        if (badges.length) entry.badges = badges;
        return entry;
      })
      .filter((e) => e.id.length > 0);
  }

  /** Parse the backend's `.card-badge` spans (language tag, "NEW", …) into contract card badges. */
  private cardBadges($: CheerioRoot, node: ReturnType<CheerioRoot>): CardBadge[] {
    return node
      .find(".card-badge")
      .toArray()
      .map((el) => {
        const b = $(el);
        const badge: CardBadge = { text: b.text().trim() };
        const pos = b.attr("data-pos");
        if (pos) badge.position = pos as CardBadgePosition;
        const tone = b.attr("data-tone");
        if (tone) badge.tone = tone as CardBadge["tone"];
        return badge;
      })
      .filter((b) => b.text.length > 0);
  }

  async getLists(): Promise<SeriesList[]> {
    const $ = await this.fetchHtml(`${this.base()}/lists`);
    return $("ul.lists > li.list-card")
      .toArray()
      .map((el) => {
        const node = $(el);
        const layout = node.attr("data-layout");
        const list: SeriesList = {
          id: node.attr("data-id") ?? "",
          name: node.find("a.list-name").first().text().trim(),
          featured: true,
          searchable: true, // the fixture's /list/:id accepts q + sort
        };
        if (layout === "carousel" || layout === "grid" || layout === "ranked" || layout === "hero") {
          list.layout = layout;
        }
        return list;
      })
      .filter((l) => l.id.length > 0);
  }

  async getListItems(
    listId: string,
    page: number,
    options?: ListOptions,
  ): Promise<PagedResults<SeriesEntry>> {
    const params = new URLSearchParams({ page: String(page) });
    if (options?.query) params.set("q", options.query);
    const sort = this.effectiveSort(options?.sort);
    if (sort) {
      params.set("sort", sort.key);
      params.set("dir", sort.ascending ? "asc" : "desc");
    }
    // Excluded tags map onto this demo backend's genre axis, pushed down as a backend negation.
    if (options?.excludedTags?.length) params.set("excludeGenre", options.excludedTags.join(","));
    const ongoingOnly = options?.filters?.find((f) => f.key === "ongoing")?.value === true;
    const $ = await this.fetchHtml(`${this.base()}/list/${encodeURIComponent(listId)}?${params.toString()}`);
    const hasNextPage = $("section.list-items").attr("data-has-next") === "true";
    return { items: this.cards($, "section.list-items", ongoingOnly), page, hasNextPage };
  }

  async getFilters(): Promise<Filter[]> {
    return [
      {
        type: "multiselect",
        key: "genre",
        label: "Genres",
        options: ["Fantasy", "Adventure", "Mystery", "Crime", "Horror", "Gothic"].map((g) => ({
          value: g,
          label: g,
        })),
      },
      { type: "text", key: "author", label: "Author" },
      { type: "toggle", key: "ongoing", label: "Ongoing only" },
    ];
  }

  async getSortOptions(): Promise<SortOption[]> {
    return [
      { key: "title", label: "Title" },
      { key: "author", label: "Author" },
    ];
  }

  async getSearchResults(
    query: string,
    page: number,
    options?: SearchOptions,
  ): Promise<PagedResults<SeriesEntry>> {
    const params = new URLSearchParams({ q: query, page: String(page) });
    let ongoingOnly = false;
    for (const f of options?.filters ?? []) {
      if (f.key === "genre" && Array.isArray(f.value)) params.set("genre", f.value.join(","));
      if (f.key === "author" && typeof f.value === "string") params.set("author", f.value);
      if (f.key === "ongoing" && f.value === true) ongoingOnly = true;
    }
    // Excluded tags map onto this demo backend's genre axis, pushed down as a backend negation.
    if (options?.excludedTags?.length) params.set("excludeGenre", options.excludedTags.join(","));
    const sort = this.effectiveSort(options?.sort);
    if (sort) {
      params.set("sort", sort.key);
      params.set("dir", sort.ascending ? "asc" : "desc");
    }
    const $ = await this.fetchHtml(`${this.base()}/search?${params.toString()}`);
    return { items: this.cards($, "section.results", ongoingOnly), page, hasNextPage: false };
  }

  override async getSeriesDetails(seriesId: string): Promise<SeriesInfo> {
    const $ = await this.fetchHtml(`${this.base()}/series/${encodeURIComponent(seriesId)}`);
    const article = $("article.series");
    const statusText = article.find(".status").first().text().trim().toLowerCase();
    const status: SeriesStatus = (STATUSES.has(statusText) ? statusText : "unknown") as SeriesStatus;
    const cover = article.find("img.cover").first().attr("src");
    const liText = (selector: string): string[] =>
      article.find(selector).toArray().map((el) => $(el).text().trim()).filter(Boolean);
    const genres = liText("ul.genres > li");
    const tagGroups: TagGroup[] = article
      .find("ul.tag-group")
      .toArray()
      .map((el) => {
        const node = $(el);
        const group: TagGroup = {
          label: node.attr("data-label") ?? "Tags",
          tags: node.find("li").toArray().map((li) => $(li).text().trim()).filter(Boolean),
        };
        const kind = node.attr("data-kind");
        if (kind) group.kind = kind as TagKind;
        return group;
      })
      .filter((g) => g.tags.length > 0);

    // Related-series rails — each `ul.related-group` is a labeled list of other series cards.
    const relatedSeriesGroups: RelatedSeriesGroup[] = article
      .find("ul.related-group")
      .toArray()
      .map((el) => {
        const node = $(el);
        const series: SeriesEntry[] = node
          .find("li.related-item")
          .toArray()
          .map((li) => {
            const item = $(li);
            const entry: SeriesEntry = {
              id: item.attr("data-id") ?? "",
              title: item.find(".title").first().text().trim(),
            };
            const itemCover = item.find("img.cover").first().attr("src");
            if (itemCover) entry.thumbnailUrl = this.resolve(this.base(), itemCover);
            return entry;
          })
          .filter((e) => e.id && e.title);
        const group: RelatedSeriesGroup = { label: node.attr("data-label") ?? "Related", series };
        const kind = node.attr("data-kind");
        if (kind) group.kind = kind as RelatedKind;
        return group;
      })
      .filter((g) => g.series.length > 0);

    const info: SeriesInfo = {
      id: seriesId,
      title: article.find("h1.title").first().text().trim(),
      status,
    };
    const author = article.find(".author").first().text().trim();
    const description = article.find("p.description").first().text().trim();
    if (author) info.author = author;
    if (description) info.description = description;
    if (cover) info.thumbnailUrl = this.resolve(this.base(), cover);
    if (genres.length > 0) info.genres = genres;
    if (tagGroups.length > 0) info.tagGroups = tagGroups;
    if (relatedSeriesGroups.length > 0) info.relatedSeriesGroups = relatedSeriesGroups;
    return info;
  }

  override async getChapters(seriesId: string): Promise<Chapter[]> {
    const $ = await this.fetchHtml(`${this.base()}/series/${encodeURIComponent(seriesId)}`);
    return $("ul.chapters > li.chapter")
      .toArray()
      .map((el) => {
        const node = $(el);
        const chapter: Chapter = {
          id: node.attr("data-id") ?? "",
          name: node.find("a").first().text().trim(),
        };
        const number = Number(node.attr("data-number"));
        if (Number.isFinite(number)) chapter.number = number;
        const pageCount = Number(node.attr("data-pages"));
        if (Number.isFinite(pageCount) && pageCount > 0) chapter.pageCount = pageCount;
        const group = node.attr("data-group");
        if (group) chapter.group = group;
        const languageCode = node.attr("data-lang");
        if (languageCode) chapter.languageCode = languageCode;
        return chapter;
      })
      .filter((c) => c.id.length > 0);
  }

  override async getChapterPages(seriesId: string, chapterId: string): Promise<Page[]> {
    const url = `${this.base()}/series/${encodeURIComponent(seriesId)}/chapter/${encodeURIComponent(chapterId)}`;
    const $ = await this.fetchHtml(url);
    const base = this.base();
    return $("img.page")
      .toArray()
      .map((el, index) => ({ index, imageUrl: this.resolve(base, $(el).attr("src") ?? "") }))
      .filter((p) => p.imageUrl.length > 0);
  }

  // ── Favorites (capability "favorites") — backend-synced, requires the sessionToken setting ──

  /** Authorization headers from the session token; throws a clear error when unauthenticated. */
  private authHeaders(): Record<string, string> {
    const token = this.setting("sessionToken");
    if (!token) throw new Error("favorites require authentication — set the sessionToken setting");
    return { Authorization: `Bearer ${token}` };
  }

  async getFavorites(page: number): Promise<PagedResults<SeriesEntry>> {
    const $ = await this.fetchHtml(`${this.base()}/favorites`, this.authHeaders());
    return { items: this.cards($, "section.favorites"), page, hasNextPage: false };
  }

  async addFavorite(seriesId: string): Promise<void> {
    await this.request({
      url: `${this.base()}/favorites/${encodeURIComponent(seriesId)}`,
      method: "PUT",
      headers: this.authHeaders(),
    });
  }

  async removeFavorite(seriesId: string): Promise<void> {
    await this.request({
      url: `${this.base()}/favorites/${encodeURIComponent(seriesId)}`,
      method: "DELETE",
      headers: this.authHeaders(),
    });
  }
}

export default defineBridge((host) => new ExampleBridge(host));
