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
  type InferSettings,
  type Page,
  type PagedResults,
  type SeriesEntry,
  type SeriesInfo,
  type SeriesList,
  type SeriesStatus,
  type SettingDescriptor,
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

/** Typed settings: `baseUrl` (required string) + a `sort` enum to exercise the picker kind. */
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
    key: "sort",
    label: "Sort order",
    options: [
      { value: "title", label: "Title" },
      { value: "recent", label: "Recently added" },
    ],
    default: "title",
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
    capabilities: ["lists", "search", "settings"],
  };

  getSettings(): SettingDescriptor[] {
    return [...SETTINGS];
  }

  private base(): string {
    return this.requireSetting("baseUrl").replace(/\/+$/, "");
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
        };
        if (layout === "carousel" || layout === "grid" || layout === "ranked" || layout === "hero") {
          list.layout = layout;
        }
        return list;
      })
      .filter((l) => l.id.length > 0);
  }

  async getListItems(listId: string, page: number): Promise<PagedResults<SeriesEntry>> {
    const $ = await this.fetchHtml(`${this.base()}/list/${encodeURIComponent(listId)}`);
    return { items: this.cards($, "section.list-items"), page, hasNextPage: false };
  }

  async getSearchResults(query: string, page: number): Promise<PagedResults<SeriesEntry>> {
    const params = new URLSearchParams({ q: query, page: String(page) });
    const $ = await this.fetchHtml(`${this.base()}/search?${params.toString()}`);
    return { items: this.cards($, "section.results"), page, hasNextPage: false };
  }

  override async getSeriesDetails(seriesId: string): Promise<SeriesInfo> {
    const $ = await this.fetchHtml(`${this.base()}/series/${encodeURIComponent(seriesId)}`);
    const article = $("article.series");
    const statusText = article.find(".status").first().text().trim().toLowerCase();
    const status: SeriesStatus = (STATUSES.has(statusText) ? statusText : "unknown") as SeriesStatus;
    const cover = article.find("img.cover").first().attr("src");
    const genres = article
      .find("ul.genres > li")
      .toArray()
      .map((el) => $(el).text().trim())
      .filter(Boolean);

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

}

export default defineBridge((host) => new ExampleBridge(host));
