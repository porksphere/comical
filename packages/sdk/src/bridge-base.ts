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
  Page,
  SeriesInfo,
  SettingValue,
} from "@comical/contract";

export type CheerioRoot = cheerio.CheerioAPI;

/**
 * Base class for bridge authors. The optional `TSettings` type parameter — produced by
 * `InferSettings<typeof SETTINGS>` — types the settings accessors: `this.setting("baseUrl")` and
 * `this.requireSetting("baseUrl")` return the inferred value type, and `this.settings` is the
 * typed record. Untyped subclasses (`extends BridgeBase`) keep the loose `SettingValue` shape.
 */
export abstract class BridgeBase<
  TSettings extends Record<string, SettingValue> = Record<string, SettingValue>,
> implements Bridge {
  abstract readonly info: BridgeInfo;

  constructor(protected readonly host: HostCapabilities) {}

  protected get log(): LogCapability {
    return this.host.log;
  }

  protected get settings(): Readonly<Partial<TSettings>> {
    return this.host.settings as Readonly<Partial<TSettings>>;
  }

  /** Read a user-supplied setting; returns undefined if unset. */
  protected setting<K extends keyof TSettings & string>(key: K): TSettings[K] | undefined {
    return this.host.settings[key] as TSettings[K] | undefined;
  }

  /** Read a setting that must be present (host guarantees required settings before content calls). */
  protected requireSetting<K extends keyof TSettings & string>(key: K): NonNullable<TSettings[K]> {
    const value = this.host.settings[key];
    if (value === undefined || value === null || value === "") {
      throw new Error(`required setting "${key}" is not configured`);
    }
    return value as NonNullable<TSettings[K]>;
  }

  /** Read a required setting as a non-empty string, throwing otherwise. Convenience for URLs/keys. */
  protected requireString(key: string): string {
    const value = this.host.settings[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`required string setting "${key}" is not configured`);
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

  // Required read-path methods — implemented by the concrete bridge. Browse (getLists/
  // getListItems) and search (getSearchResults) are optional: a subclass declares them when its
  // capabilities include "lists"/"search", typed against the re-exported contract types.
  abstract getSeriesDetails(seriesId: string): Promise<SeriesInfo>;

  // Chapter-based read path. Concrete stubs let "direct"-only bridges extend BridgeBase without
  // overriding these; bridges that serve chapters override them as normal.
  getChapters(_seriesId: string): Promise<Chapter[]> {
    return Promise.reject(new Error("getChapters is not supported by this bridge"));
  }
  getChapterPages(_seriesId: string, _chapterId: string): Promise<Page[]> {
    return Promise.reject(new Error("getChapterPages is not supported by this bridge"));
  }

  // Direct-read path (capability "direct"): override when the series has no chapter structure.
  getSeriesPages?(_seriesId: string): Promise<Page[]>;
}

/** Identity helper that gives a bridge factory the correct type and a single obvious export. */
export function defineBridge(factory: BridgeFactory): BridgeFactory {
  return factory;
}
