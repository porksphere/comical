/**
 * `TrackerBase` — the ergonomic foundation tracker authors extend. Mirrors `BridgeBase` exactly:
 * captures host capabilities and exposes HTTP helpers, settings accessors, and a logging shortcut.
 *
 * Usage:
 *   class MyTracker extends TrackerBase<MySettings> { ... }
 *   export default defineTracker((host) => new MyTracker(host));
 */
import type {
  HostCapabilities,
  HttpRequest,
  LogCapability,
  SettingValue,
  Tracker,
  TrackerFactory,
  TrackerInfo,
} from "@comical/contract";

/** Identity helper — preserves type without runtime overhead. */
export function defineTracker(factory: TrackerFactory): TrackerFactory {
  return factory;
}

export abstract class TrackerBase<
  TSettings extends Record<string, SettingValue> = Record<string, SettingValue>,
> implements Tracker {
  abstract readonly info: TrackerInfo;

  constructor(protected readonly host: HostCapabilities) {}

  protected get log(): LogCapability {
    return this.host.log;
  }

  protected get settings(): Readonly<Partial<TSettings>> {
    return this.host.settings as Readonly<Partial<TSettings>>;
  }

  protected setting<K extends keyof TSettings>(key: K): TSettings[K] | undefined {
    return this.host.settings[key as string] as TSettings[K] | undefined;
  }

  protected requireString(key: keyof TSettings): string {
    const v = this.host.settings[key as string];
    if (!v || typeof v !== "string") throw new Error(`setting "${String(key)}" is required`);
    return v;
  }

  protected async fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
    const res = await this.host.network.request({ url, method: "GET", ...(headers ? { headers } : {}) });
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} from ${url}`);
    return JSON.parse(res.body) as T;
  }

  protected async request(req: HttpRequest) {
    return this.host.network.request(req);
  }
}
