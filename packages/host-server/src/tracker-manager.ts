/**
 * Manages the lifecycle of loaded trackers on the server.
 *
 * Trackers can come from two sources:
 *   - Local: `{trackersDir}/{id}/dist/tracker.js` bundles (optional)
 *   - Registry: downloaded, verified, cached via RegistryManager (optional)
 *
 * `get(id)` tries local first, then falls back to the registry cache.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { HostCapabilities, HttpRequest, HttpResponse, NetworkCapability, SettingValue } from "@comical/contract";
import { type LoadedTracker, loadTracker, resolveSettings } from "@comical/core";
import { createBunHost } from "@comical/host-bun";
import type { RegistryManager } from "@comical/registry";
import type { SettingsStore } from "./settings-store.ts";
// TrackerSummary lives in the Node-free provider module (so the router can name it); import for
// local use and re-export to preserve this module's public surface.
import type { TrackerSummary } from "./tracker-provider.ts";
export type { TrackerSummary } from "./tracker-provider.ts";

export interface TrackerManagerOptions {
  trackersDir?: string | string[];
  dataDir: string;
  settings: SettingsStore;
  registry?: RegistryManager;
}

interface DiscoveredTracker {
  id: string;
  bundlePath: string;
}

// ── OAuth token blob ──────────────────────────────────────────────────────────

interface OAuthTokenBlob {
  access: string;
  refresh?: string;
  expiresAt?: number;
}

interface OAuthRefreshConfig {
  key: string;
  currentToken: string;
  refreshToken: string;
  refreshUrl: string;
  clientId: string;
  clientSecret: string;
}

function parseOAuthBlob(value: SettingValue): OAuthTokenBlob | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as { access?: unknown };
    if (typeof parsed.access === "string") return parsed as OAuthTokenBlob;
  } catch { /* not a blob */ }
  return undefined;
}

/** Unwrap oauth token blobs to plain access-token strings so the tracker sees a simple string. */
function resolveAccessToken(value: SettingValue): SettingValue {
  return parseOAuthBlob(value)?.access ?? value;
}

// ── Refreshable network ───────────────────────────────────────────────────────

class RefreshableNetwork implements NetworkCapability {
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
      const resp = await fetch(cfg.refreshUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(params).toString(),
      });
      if (!resp.ok) return null;
      const data = await resp.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
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

// ── Tracker discovery ─────────────────────────────────────────────────────────

function discoverTrackers(dirs: string | string[]): DiscoveredTracker[] {
  const dirList = Array.isArray(dirs) ? dirs : [dirs];
  const found: DiscoveredTracker[] = [];
  for (const dir of dirList) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const id of entries) {
      const bundlePath = join(dir, id, "dist", "tracker.js");
      if (existsSync(bundlePath)) found.push({ id, bundlePath });
    }
  }
  return found;
}

export class TrackerManager {
  private readonly loaded = new Map<string, LoadedTracker>();
  private discovered: DiscoveredTracker[] | undefined;

  constructor(private readonly opts: TrackerManagerOptions) {}

  refresh(): void {
    this.discovered = undefined;
    this.loaded.clear();
  }

  invalidate(id: string): void {
    this.loaded.delete(id);
  }

  private discover(): DiscoveredTracker[] {
    if (!this.discovered) {
      this.discovered = this.opts.trackersDir ? discoverTrackers(this.opts.trackersDir) : [];
    }
    return this.discovered;
  }

  async get(id: string): Promise<LoadedTracker> {
    const cached = this.loaded.get(id);
    if (cached) return cached;

    // Find the bundle — local discovery first, then registry cache.
    const found = this.discover().find((d) => d.id === id);
    let bundlePath: string | undefined = found?.bundlePath;

    if (!bundlePath && this.opts.registry) {
      const p = await this.opts.registry.resolveTrackerBundle(id);
      if (p && existsSync(p)) bundlePath = p;
    }

    if (!bundlePath) throw new Error(`tracker not found: ${id}`);

    const code = readFileSync(bundlePath, "utf8");
    const stored = (await this.opts.settings.get(id)) as Record<string, SettingValue>;

    // Unwrap oauth-pin token blobs → plain access-token strings for the tracker.
    const settingsForTracker: Record<string, SettingValue> = {};
    for (const [k, v] of Object.entries(stored)) settingsForTracker[k] = resolveAccessToken(v);

    const bunHost = createBunHost({ bridgeId: id, dataDir: join(this.opts.dataDir, "trackers", id), settings: settingsForTracker });
    const refreshable = new RefreshableNetwork(
      bunHost.network,
      async (key, blob) => {
        await this.opts.settings.patch(id, { [key]: JSON.stringify(blob) });
        this.invalidate(id);
      },
    );
    const host: HostCapabilities = { ...bunHost, network: refreshable };
    const tracker = loadTracker({ code, capabilities: host, expectedId: id });

    // Configure refresh now that we have descriptors.
    const descriptors = tracker.getSettings?.() ?? [];
    const refreshConfigs: OAuthRefreshConfig[] = [];
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
      refreshConfigs.push({ key: d.key, currentToken: blob.access, refreshToken: blob.refresh, refreshUrl, clientId, clientSecret });
    }
    if (refreshConfigs.length > 0) refreshable.configure(refreshConfigs);

    this.loaded.set(id, tracker);
    return tracker;
  }

  private async summarize(id: string): Promise<TrackerSummary> {
    const tracker = await this.get(id);
    const settings = tracker.getSettings?.() ?? [];
    const stored = (await this.opts.settings.get(id)) as Record<string, SettingValue>;
    const { missingRequired } = resolveSettings(stored, settings);
    const secretKeys = new Set(
      settings.filter((d) => (d.type === "string" && !!d.secret) || d.type === "oauth-pin" || d.type === "oauth-callback").map((d) => d.key),
    );
    const values: Record<string, SettingValue> = {};
    const secretsSet: string[] = [];
    for (const [k, v] of Object.entries(stored)) {
      if (secretKeys.has(k)) { if (v !== undefined && v !== "") secretsSet.push(k); }
      else values[k] = v;
    }
    return { info: tracker.info, settings, values, secretsSet, configured: missingRequired.length === 0, missingRequired };
  }

  async list(): Promise<TrackerSummary[]> {
    const results: TrackerSummary[] = [];
    const localIds = new Set(this.discover().map((d) => d.id));

    // Local trackers.
    for (const d of this.discover()) {
      try { results.push(await this.summarize(d.id)); } catch { /* skip */ }
    }

    // Registry-installed trackers not present in a local dir.
    if (this.opts.registry) {
      const installed = await this.opts.registry.allInstalledTrackers();
      for (const t of installed) {
        if (localIds.has(t.id)) continue;
        try { results.push(await this.summarize(t.id)); } catch { /* skip */ }
      }
    }

    return results;
  }

  async storedSettings(id: string): Promise<Record<string, SettingValue>> {
    return (await this.opts.settings.get(id)) as Record<string, SettingValue>;
  }

  async updateSettings(id: string, patch: Record<string, SettingValue>): Promise<Record<string, SettingValue>> {
    const updated = (await this.opts.settings.patch(id, patch)) as Record<string, SettingValue>;
    this.invalidate(id);
    return updated;
  }

  async missingRequired(id: string): Promise<string[]> {
    const tracker = await this.get(id);
    const settings = tracker.getSettings?.() ?? [];
    const stored = await this.storedSettings(id);
    const { missingRequired } = resolveSettings(stored, settings);
    return missingRequired;
  }
}
