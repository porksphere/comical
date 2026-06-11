/**
 * Direct-read demo bridge. Targets the `DirectFixtureBackend` (illustration gallery concept):
 * each series is a complete, self-contained work read as a flat page sequence — no chapters.
 *
 * Demonstrates the "direct" capability path: only `getSeriesDetails` + `getSeriesPages`
 * are implemented; `getChapters`/`getChapterPages` are left as BridgeBase stubs.
 */
import {
  BridgeBase,
  type BridgeInfo,
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
  "unknown", "ongoing", "completed", "hiatus", "cancelled",
]);

const SETTINGS = defineSettings([
  {
    type: "string",
    key: "baseUrl",
    label: "Gallery base URL",
    placeholder: "http://localhost:3200",
    required: true,
  },
]);
type Settings = InferSettings<typeof SETTINGS>;

class DirectExampleBridge extends BridgeBase<Settings> {
  readonly info: BridgeInfo = {
    id: "direct-example",
    name: "Illustration Gallery (Demo)",
    version: "0.1.0",
    contractVersion: "1.0.0",
    languages: ["en"],
    nsfw: false,
    capabilities: ["direct", "lists", "settings"],
  };

  getSettings(): SettingDescriptor[] {
    return [...SETTINGS];
  }

  private base(): string {
    return this.requireSetting("baseUrl").replace(/\/+$/, "");
  }

  async getLists(): Promise<SeriesList[]> {
    return [{ id: "all", name: "All Works", layout: "grid", featured: true }];
  }

  async getListItems(_listId: string, page: number): Promise<PagedResults<SeriesEntry>> {
    const $ = await this.fetchHtml(`${this.base()}/`);
    const base = this.base();
    const items = $(".gallery-catalog .gallery-card")
      .toArray()
      .map((el) => {
        const node = $(el);
        const id = node.attr("data-id") ?? "";
        const cover = node.find("img.cover").first().attr("src");
        const entry: SeriesEntry = {
          id,
          title: node.find("a.title").first().text().trim(),
        };
        if (cover) entry.thumbnailUrl = this.resolve(base, cover);
        const artist = node.find(".artist").first().text().trim();
        if (artist) entry.subtitle = artist;
        return entry;
      })
      .filter((e) => e.id.length > 0);
    return { items, page, hasNextPage: false };
  }

  override async getSeriesDetails(seriesId: string): Promise<SeriesInfo> {
    const $ = await this.fetchHtml(`${this.base()}/gallery/${encodeURIComponent(seriesId)}`);
    const article = $("article.gallery");
    const statusText = article.find(".status").first().text().trim().toLowerCase();
    const status: SeriesStatus = (STATUSES.has(statusText) ? statusText : "unknown") as SeriesStatus;
    const cover = article.find("img.cover").first().attr("src");
    const info: SeriesInfo = {
      id: seriesId,
      title: article.find("h1.title").first().text().trim(),
      status,
    };
    const artist = article.find(".artist").first().text().trim();
    const description = article.find("p.description").first().text().trim();
    const genres = article.find("ul.genres > li").toArray()
      .map((el) => $(el).text().trim()).filter(Boolean);
    if (artist) info.author = artist;
    if (description) info.description = description;
    if (cover) info.thumbnailUrl = this.resolve(this.base(), cover);
    if (genres.length > 0) info.genres = genres;
    return info;
  }

  override async getSeriesPages(seriesId: string): Promise<Page[]> {
    const $ = await this.fetchHtml(`${this.base()}/gallery/${encodeURIComponent(seriesId)}/pages`);
    const base = this.base();
    return $("div.reader img.page")
      .toArray()
      .map((el, index) => {
        const thumb = $(el).attr("data-thumb");
        return {
          index,
          imageUrl: this.resolve(base, $(el).attr("src") ?? ""),
          ...(thumb ? { thumbnailUrl: this.resolve(base, thumb) } : {}),
        };
      })
      .filter((p) => p.imageUrl.length > 0);
  }
}

export default defineBridge((host) => new DirectExampleBridge(host));
