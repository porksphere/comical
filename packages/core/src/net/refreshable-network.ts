/**
 * A `NetworkCapability` wrapper that transparently refreshes an OAuth access token on a 401 and
 * retries the request once with the new token. Used by trackers (AniList/MAL-style OAuth), which
 * — unlike bridges — hold a `refresh_token` and can rotate their own access token without user
 * interaction.
 *
 * Node-free and fetch-free: the refresh call itself goes through the wrapped `inner` capability
 * (`inner.request`), the same host-provided network path a normal request uses — so a refresh
 * keeps whatever rate-limiting/cookie/proxy semantics the host applies, and this file never
 * imports `fetch` directly. That keeps `@comical/core`'s "no fetch" platform-agnostic contract
 * intact even though this class is reused by non-core hosts too (host-server today, host-rn's
 * embedded tracker provider next — see `EmbeddedTrackerProvider`).
 */
import type {
  HttpRequest,
  HttpResponse,
  NetworkCapability,
  SettingDescriptor,
  SettingValue,
} from "@comical/contract";

export interface OAuthTokenBlob {
  access: string;
  refresh?: string;
  expiresAt?: number;
}

export interface OAuthRefreshConfig {
  key: string;
  currentToken: string;
  refreshToken: string;
  refreshUrl: string;
  clientId: string;
  clientSecret: string;
}

/** Parse a stored setting value as an OAuth token blob (`{access, refresh?, expiresAt?}`), or `undefined` if it isn't one. */
export function parseOAuthBlob(value: SettingValue): OAuthTokenBlob | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as { access?: unknown };
    if (typeof parsed.access === "string") return parsed as OAuthTokenBlob;
  } catch { /* not a blob */ }
  return undefined;
}

/** Unwrap an oauth token blob to its plain access-token string, so the loaded tracker sees a simple string setting. */
export function resolveAccessToken(value: SettingValue): SettingValue {
  return parseOAuthBlob(value)?.access ?? value;
}

/**
 * Build the refresh configs a `RefreshableNetwork` needs from a tracker's setting descriptors +
 * its stored (raw, blob-shaped) values. Only oauth-pin/oauth-callback descriptors that declare a
 * `refreshUrl` and whose stored value is currently a refreshable blob (has a `refresh` token)
 * produce a config; everything else is skipped. `settingsForTracker` is the already-unwrapped
 * (access-token-only) values map — used to resolve an oauth-callback's `clientIdKey` indirection.
 */
export function buildRefreshConfigs(
  descriptors: readonly SettingDescriptor[],
  stored: Record<string, SettingValue>,
  settingsForTracker: Record<string, SettingValue>,
): OAuthRefreshConfig[] {
  const configs: OAuthRefreshConfig[] = [];
  for (const d of descriptors) {
    let refreshUrl: string | undefined;
    let clientId: string;
    let clientSecret: string;

    if (d.type === "oauth-pin") {
      if (!d.exchange?.refreshUrl) continue;
      refreshUrl = d.exchange.refreshUrl;
      clientId = d.exchange.clientId;
      clientSecret = d.exchange.clientSecret;
    } else if (d.type === "oauth-callback") {
      if (!d.exchange.refreshUrl) continue;
      refreshUrl = d.exchange.refreshUrl;
      clientId = d.exchange.clientIdKey
        ? String(settingsForTracker[d.exchange.clientIdKey] ?? "")
        : (d.exchange.clientId ?? "");
      clientSecret = "";
    } else {
      continue;
    }

    const blob = parseOAuthBlob(stored[d.key] ?? "");
    if (!blob?.refresh) continue;
    configs.push({ key: d.key, currentToken: blob.access, refreshToken: blob.refresh, refreshUrl, clientId, clientSecret });
  }
  return configs;
}

/**
 * Wraps a host's raw `NetworkCapability`. On a 401 whose `Authorization: Bearer <token>` matches
 * a configured refresh entry, exchanges the refresh token for a new access token (via `inner`,
 * form-encoded per the OAuth2 refresh grant), persists it through `onRefreshed`, and retries the
 * original request once with the new token. Concurrent 401s share one in-flight refresh.
 */
export class RefreshableNetwork implements NetworkCapability {
  private configs: OAuthRefreshConfig[] = [];
  private inflightRefresh: Promise<string | null> | null = null;

  constructor(
    private readonly inner: NetworkCapability,
    private readonly onRefreshed: (key: string, blob: OAuthTokenBlob) => Promise<void>,
  ) {}

  configure(configs: OAuthRefreshConfig[]): void {
    this.configs = configs;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const res = await this.inner.request(req);
    if (res.status !== 401 || this.configs.length === 0) return res;

    const authHeader = req.headers?.["Authorization"] ?? req.headers?.["authorization"];
    if (!authHeader?.startsWith("Bearer ")) return res;
    const bearerToken = authHeader.slice(7);
    const cfg = this.configs.find((c) => c.currentToken === bearerToken);
    if (!cfg) return res;

    // Serialize concurrent refresh attempts.
    this.inflightRefresh ??= this.doRefresh(cfg).finally(() => { this.inflightRefresh = null; });
    const newToken = await this.inflightRefresh;
    if (!newToken) return res;

    return this.inner.request({
      ...req,
      headers: { ...(req.headers ?? {}), Authorization: `Bearer ${newToken}` },
    });
  }

  private async doRefresh(cfg: OAuthRefreshConfig): Promise<string | null> {
    try {
      const params: Record<string, string> = {
        grant_type: "refresh_token",
        client_id: cfg.clientId,
        refresh_token: cfg.refreshToken,
      };
      if (cfg.clientSecret) params.client_secret = cfg.clientSecret;
      const res = await this.inner.request({
        url: cfg.refreshUrl,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(params).toString(),
      });
      if (res.status < 200 || res.status >= 300) return null;
      const data = JSON.parse(res.body) as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!data.access_token) return null;

      const blob: OAuthTokenBlob = { access: data.access_token };
      if (data.refresh_token) blob.refresh = data.refresh_token;
      if (data.expires_in) blob.expiresAt = Date.now() + data.expires_in * 1000;

      await this.onRefreshed(cfg.key, blob);
      cfg.currentToken = data.access_token;
      if (data.refresh_token) cfg.refreshToken = data.refresh_token;
      return data.access_token;
    } catch {
      return null;
    }
  }
}
