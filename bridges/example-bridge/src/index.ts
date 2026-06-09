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
  type Chapter,
  type CheerioRoot,
  type Filter,
  type InferSettings,
  type ListOptions,
  type Page,
  type PagedResults,
  type SearchOptions,
  type SeriesEntry,
  type SeriesInfo,
  type SeriesList,
  type SeriesStatus,
  type SettingDescriptor,
  type SortOption,
  type SortSelection,
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
    capabilities: ["lists", "search", "filters", "sort", "settings", "favorites"],
  };

  getSettings(): SettingDescriptor[] {
    return [...SETTINGS];
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

  /** Collect every `.series-card` under `scope` into SeriesEntry list. */
  private cards($: CheerioRoot, scope: string): SeriesEntry[] {
    const base = this.base();
    return $(`${scope} .series-card`)
      .toArray()
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
        return entry;
      })
      .filter((e) => e.id.length > 0);
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
    const params = new URLSearchParams();
    if (options?.query) params.set("q", options.query);
    const sort = this.effectiveSort(options?.sort);
    if (sort) {
      params.set("sort", sort.key);
      params.set("dir", sort.ascending ? "asc" : "desc");
    }
    const qs = params.toString();
    const $ = await this.fetchHtml(`${this.base()}/list/${encodeURIComponent(listId)}${qs ? `?${qs}` : ""}`);
    return { items: this.cards($, "section.list-items"), page, hasNextPage: false };
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
    for (const f of options?.filters ?? []) {
      if (f.key === "genre" && Array.isArray(f.value)) params.set("genre", f.value.join(","));
      if (f.key === "author" && typeof f.value === "string") params.set("author", f.value);
    }
    const sort = this.effectiveSort(options?.sort);
    if (sort) {
      params.set("sort", sort.key);
      params.set("dir", sort.ascending ? "asc" : "desc");
    }
    const $ = await this.fetchHtml(`${this.base()}/search?${params.toString()}`);
    return { items: this.cards($, "section.results"), page, hasNextPage: false };
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
