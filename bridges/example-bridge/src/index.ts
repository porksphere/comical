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
  type HomeSection,
  type SeriesEntry,
  type SeriesInfo,
  type SeriesStatus,
  type Page,
  type PagedResults,
  type SettingDescriptor,
  defineBridge,
} from "@comical/sdk";

const STATUSES: ReadonlySet<string> = new Set<SeriesStatus>([
  "unknown",
  "ongoing",
  "completed",
  "hiatus",
  "cancelled",
]);

class ExampleBridge extends BridgeBase {
  readonly info: BridgeInfo = {
    id: "example",
    name: "Example (Demo Library)",
    version: "0.1.0",
    contractVersion: "1.0.0",
    languages: ["en"],
    nsfw: false,
    capabilities: ["search", "home", "popular", "settings"],
  };

  getSettings(): SettingDescriptor[] {
    return [
      {
        type: "text",
        key: "baseUrl",
        label: "Backend base URL",
        placeholder: "https://library.example",
        required: true,
      },
    ];
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

  override async getSearchResults(query: string, page: number): Promise<PagedResults<SeriesEntry>> {
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

  async getHomeSections(): Promise<HomeSection[]> {
    const $ = await this.fetchHtml(`${this.base()}/`);
    return $("section.home-section")
      .toArray()
      .map((el) => {
        const node = $(el);
        const id = node.attr("data-section") ?? "section";
        return {
          type: "carousel" as const,
          id,
          title: node.find("h2").first().text().trim() || "Section",
          items: this.cards($, `section.home-section[data-section="${id}"]`),
          more: true,
        };
      });
  }

  async getPopular(page: number): Promise<PagedResults<SeriesEntry>> {
    const sections = await this.getHomeSections();
    const popular = sections.find((s) => s.id === "popular") ?? sections[0];
    return { items: popular?.items ?? [], page, hasNextPage: false };
  }
}

export default defineBridge((host) => new ExampleBridge(host));
