/**
 * `BridgeBase` — the ergonomic foundation bridge authors extend. It captures the host
 * capabilities and exposes safe helpers (HTTP, HTML parsing via cheerio, URL resolution,
 * settings access) so a concrete bridge only implements the backend-specific parsing.
 *
 * A bridge module exports a factory; authors typically write:
 *
 *   class MyBridge extends BridgeBase { ... }
 *   export default defineBridge((host) => new MyBridge(host));
 */
import * as cheerio from "cheerio";
import type {
  Bridge,
  BridgeFactory,
  BridgeInfo,
  Chapter,
  HostCapabilities,
  HttpRequest,
  HttpResponse,
  LogCapability,
  SeriesEntry,
  SeriesInfo,
  Page,
  PagedResults,
  ResolvedSettings,
} from "@comical/contract";

export type CheerioRoot = cheerio.CheerioAPI;

export abstract class BridgeBase implements Bridge {
  abstract readonly info: BridgeInfo;

  constructor(protected readonly host: HostCapabilities) {}

  protected get log(): LogCapability {
    return this.host.log;
  }

  protected get settings(): ResolvedSettings {
    return this.host.settings;
  }

  /** Read a user-supplied setting (e.g. backend URL); returns undefined if unset. */
  protected setting(key: string): string | boolean | undefined {
    return this.host.settings[key];
  }

  /** Read a required string setting, throwing a clear error if it is missing/blank. */
  protected requireSetting(key: string): string {
    const value = this.host.settings[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`required setting "${key}" is not configured`);
    }
    return value;
  }

  /** The single HTTP path. Goes through the runtime's gated network (rate-limit + cache). */
  protected request(req: HttpRequest): Promise<HttpResponse> {
    return this.host.network.request(req);
  }

  /** GET a URL and return its decoded text body. */
  protected async fetchText(url: string, headers?: Record<string, string>): Promise<string> {
    const res = await this.request(headers ? { url, headers } : { url });
    return res.body;
  }

  /** GET a URL and parse the body as JSON. */
  protected async fetchJson<T = unknown>(
    url: string,
    headers?: Record<string, string>,
  ): Promise<T> {
    const body = await this.fetchText(url, headers);
    return JSON.parse(body) as T;
  }

  /** GET a URL and load its HTML into a cheerio root for CSS-selector querying. */
  protected async fetchHtml(url: string, headers?: Record<string, string>): Promise<CheerioRoot> {
    return this.parse(await this.fetchText(url, headers));
  }

  /** Parse an HTML string into a cheerio root. */
  protected parse(html: string): CheerioRoot {
    return cheerio.load(html);
  }

  /** Resolve a possibly-relative href against a base URL into an absolute URL. */
  protected resolve(base: string, href: string): string {
    return new URL(href, base).toString();
  }

  // Required interface methods — implemented by the concrete bridge.
  abstract getSeriesDetails(seriesId: string): Promise<SeriesInfo>;
  abstract getChapters(seriesId: string): Promise<Chapter[]>;
  abstract getChapterPages(seriesId: string, chapterId: string): Promise<Page[]>;
  abstract getSearchResults(
    query: string,
    page: number,
    filters?: Parameters<Bridge["getSearchResults"]>[2],
  ): Promise<PagedResults<SeriesEntry>>;
}

/** Identity helper that gives a bridge factory the correct type and a single obvious export. */
export function defineBridge(factory: BridgeFactory): BridgeFactory {
  return factory;
}
