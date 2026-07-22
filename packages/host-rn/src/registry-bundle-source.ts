/**
 * A `BundleSource` backed by a Comical registry: the installed set + bundle code come from a registry
 * `index.json`, with bundles downloaded, integrity/authenticity-verified, and cached.
 *
 * The registry index already carries each bridge's full `BridgeInfo` (capabilities, nsfw, icon), so
 * `installed()` needs no bundle load. `resolveBundle` returns cached code when present, else downloads
 * + verifies (SHA-256 always; Ed25519 when the index is signed) and caches it.
 *
 * The `fetchIndex`/`downloadBundle` implementations are injected (a `RegistryFetcher`) rather than
 * imported, so an embedder can supply a caching or platform-specific fetcher. At runtime the caller
 * wires `@comical/registry/fetcher`'s real functions (whose verify.ts is pure WebCrypto — on-device
 * it needs a `crypto.subtle` polyfill; see `installWebCryptoShim`).
 */
import type { BridgeInfo } from "@comical/contract";
import type { BundleEntryLike, DownloadResult } from "@comical/registry/fetcher";
import type { RegistryBridgeEntry, RegistryIndex } from "@comical/registry/schema";
import type {
  BundleSource,
  InstalledBridge,
  InstalledStore,
  InstalledTrackerStore,
  TrackerBundleSource,
} from "./types.ts";

export type { BundleEntryLike } from "@comical/registry/fetcher";

/** The subset of `@comical/registry`'s fetcher this source uses — injected at construction. */
export interface RegistryFetcher {
  fetchIndex(url: string): Promise<RegistryIndex>;
  downloadBundle(
    entry: BundleEntryLike,
    opts?: { publicKey?: string; requireSignature?: boolean },
  ): Promise<Pick<DownloadResult, "text">>;
}

/** Persistent bundle cache keyed by (bridge id, sha256) so a changed bundle re-downloads. */
export interface BundleCache {
  read(id: string, sha256: string): Promise<string | null>;
  write(id: string, sha256: string, code: string): Promise<void>;
}

/** In-memory `BundleCache` — the default/fallback and what tests use. */
export class MemoryBundleCache implements BundleCache {
  private readonly store = new Map<string, string>();
  private key(id: string, sha256: string): string {
    return `${id}@${sha256}`;
  }
  async read(id: string, sha256: string): Promise<string | null> {
    return this.store.get(this.key(id, sha256)) ?? null;
  }
  async write(id: string, sha256: string, code: string): Promise<void> {
    this.store.set(this.key(id, sha256), code);
  }
}

export interface RegistryBundleSourceOptions {
  /** Absolute URL of the registry `index.json`. */
  indexUrl: string;
  fetcher: RegistryFetcher;
  cache?: BundleCache;
  /** Refuse unsigned bundles (defaults to false — SHA-256 integrity is always enforced). */
  requireSignature?: boolean;
}

export function entryToInfo(e: RegistryBridgeEntry): BridgeInfo {
  return {
    id: e.id,
    name: e.name,
    version: e.version,
    contractVersion: e.contractVersion,
    languages: e.languages,
    nsfw: e.nsfw,
    capabilities: e.capabilities as BridgeInfo["capabilities"],
    ...(e.iconUrl !== undefined ? { iconUrl: e.iconUrl } : {}),
    ...(e.assetProxy !== undefined ? { assetProxy: e.assetProxy } : {}),
  };
}

export class RegistryBundleSource implements BundleSource {
  private readonly cache: BundleCache;
  private index: RegistryIndex | undefined;

  constructor(private readonly opts: RegistryBundleSourceOptions) {
    this.cache = opts.cache ?? new MemoryBundleCache();
  }

  /** Fetch + memoize the registry index. Call `reload()` to force a refetch. */
  private async loadIndex(): Promise<RegistryIndex | null> {
    // No registry configured yet (e.g. the user hasn't entered a URL) — no bridges, no error.
    if (!this.opts.indexUrl.trim()) return null;
    if (this.index === undefined) {
      this.index = await this.opts.fetcher.fetchIndex(this.opts.indexUrl);
    }
    return this.index;
  }

  /** Drop the memoized index so the next call refetches (e.g. to pick up new/updated bridges). */
  reload(): void {
    this.index = undefined;
  }

  async installed(): Promise<InstalledBridge[]> {
    const idx = await this.loadIndex();
    if (!idx) return [];
    return idx.bridges.map((e) => ({ info: entryToInfo(e), source: "registry" as const }));
  }

  async resolveBundle(id: string): Promise<string> {
    const idx = await this.loadIndex();
    const entry = idx?.bridges.find((b) => b.id === id);
    if (!idx || !entry) throw new Error(`bridge not found: ${id}`);

    const cached = await this.cache.read(id, entry.sha256);
    if (cached !== null) return cached;

    const opts: { publicKey?: string; requireSignature?: boolean } = {};
    if (idx.publicKey !== undefined) opts.publicKey = idx.publicKey;
    if (this.opts.requireSignature !== undefined) opts.requireSignature = this.opts.requireSignature;

    const { text } = await this.opts.fetcher.downloadBundle(entry, opts);
    await this.cache.write(id, entry.sha256, text);
    return text;
  }
}

export interface MultiRegistryBundleSourceOptions {
  /** Absolute URLs of the registry `index.json`s. Blank entries are ignored. */
  indexUrls: string[];
  fetcher: RegistryFetcher;
  cache?: BundleCache;
  requireSignature?: boolean;
}

/**
 * A `BundleSource` over several registries — the user can add/remove registry URLs. `installed()`
 * merges every registry's bridges (first registry wins on an id collision) and tolerates a failing
 * registry (that one is skipped, the rest still load). `resolveBundle` tries each registry in order.
 */
export class MultiRegistryBundleSource implements BundleSource {
  private readonly sources: RegistryBundleSource[];

  constructor(opts: MultiRegistryBundleSourceOptions) {
    const base = { fetcher: opts.fetcher, ...(opts.cache ? { cache: opts.cache } : {}), ...(opts.requireSignature !== undefined ? { requireSignature: opts.requireSignature } : {}) };
    this.sources = opts.indexUrls
      .map((u) => u.trim())
      .filter((u) => u.length > 0)
      .map((indexUrl) => new RegistryBundleSource({ indexUrl, ...base }));
  }

  reload(): void {
    for (const s of this.sources) s.reload();
  }

  async installed(): Promise<InstalledBridge[]> {
    const results = await Promise.allSettled(this.sources.map((s) => s.installed()));
    const seen = new Set<string>();
    const out: InstalledBridge[] = [];
    for (const r of results) {
      if (r.status !== "fulfilled") continue; // a broken registry is skipped, not fatal
      for (const b of r.value) {
        if (seen.has(b.info.id)) continue;
        seen.add(b.info.id);
        out.push(b);
      }
    }
    return out;
  }

  async resolveBundle(id: string): Promise<string> {
    let lastError: unknown;
    for (const s of this.sources) {
      try {
        return await s.resolveBundle(id);
      } catch (e) {
        // "not found" just means this registry doesn't carry the bridge — keep looking. Any other
        // error (a broken/unreachable registry, a failed download/verify) is remembered but not fatal
        // yet, so a healthy registry later in the list can still satisfy the request.
        if (!(e instanceof Error && e.message.includes("not found"))) lastError = e;
      }
    }
    if (lastError) throw lastError;
    throw new Error(`bridge not found: ${id}`);
  }
}

export interface ManifestBundleSourceOptions {
  /** The persisted installed-bridge manifest (the app's AsyncStorage store). */
  installed: InstalledStore;
  /** Only the download half of the fetcher is needed — `installed()` never fetches an index. */
  fetcher: Pick<RegistryFetcher, "downloadBundle">;
  cache?: BundleCache;
  /** Refuse unsigned bundles (defaults to false — SHA-256 integrity is always enforced). */
  requireSignature?: boolean;
}

/**
 * A `BundleSource` backed by the on-device *installed* manifest rather than a live registry index:
 * `installed()` returns exactly the bridges the user chose to install (not everything a registry
 * offers), reading pinned `InstalledBridgeRecord`s with no network — so it works offline and only
 * loads what's installed. `resolveBundle` re-downloads + verifies the record's pinned bundle
 * (`url`/`sha256`/`signature`) and caches it by `sha256`. This is the embedded counterpart to the
 * server's registry-cache-backed bridge loading; per-bridge install/update/uninstall is driven
 * separately by `EmbeddedRegistryProvider`, which writes the manifest this reads.
 */
export class ManifestBundleSource implements BundleSource {
  private readonly cache: BundleCache;

  constructor(private readonly opts: ManifestBundleSourceOptions) {
    this.cache = opts.cache ?? new MemoryBundleCache();
  }

  async installed(): Promise<InstalledBridge[]> {
    const records = await this.opts.installed.all();
    return records.map((r) => ({
      info: r.info,
      source: "registry" as const,
      ...(r.availableVersion !== undefined ? { availableVersion: r.availableVersion } : {}),
      ...(r.discontinued ? { discontinued: true } : {}),
    }));
  }

  async resolveBundle(id: string): Promise<string> {
    const rec = await this.opts.installed.get(id);
    if (!rec) throw new Error(`bridge not found: ${id}`);

    const cached = await this.cache.read(id, rec.sha256);
    if (cached !== null) return cached;

    const opts: { publicKey?: string; requireSignature?: boolean } = {};
    if (rec.publicKey !== undefined) opts.publicKey = rec.publicKey;
    if (this.opts.requireSignature !== undefined) opts.requireSignature = this.opts.requireSignature;

    const { text } = await this.opts.fetcher.downloadBundle(
      { id: rec.id, url: rec.url, sha256: rec.sha256, signature: rec.signature },
      opts,
    );
    await this.cache.write(id, rec.sha256, text);
    return text;
  }
}

export interface ManifestTrackerBundleSourceOptions {
  /** The persisted installed-tracker manifest (the app's AsyncStorage store). */
  installed: InstalledTrackerStore;
  /** Only the download half of the fetcher is needed — `ids()` never fetches an index. */
  fetcher: Pick<RegistryFetcher, "downloadBundle">;
  cache?: BundleCache;
  /** Refuse unsigned bundles (defaults to false — SHA-256 integrity is always enforced). */
  requireSignature?: boolean;
}

/**
 * A `TrackerBundleSource` backed by the on-device *installed* manifest — the tracker equivalent of
 * `ManifestBundleSource`. `ids()` reads pinned `InstalledTrackerRecord`s with no network;
 * `resolveBundle` re-downloads + verifies the record's pinned bundle and caches it by `sha256`.
 * Per-tracker install/update/uninstall is driven separately by `EmbeddedRegistryProvider`, which
 * writes the manifest this reads.
 */
export class ManifestTrackerBundleSource implements TrackerBundleSource {
  private readonly cache: BundleCache;

  constructor(private readonly opts: ManifestTrackerBundleSourceOptions) {
    this.cache = opts.cache ?? new MemoryBundleCache();
  }

  async ids(): Promise<string[]> {
    const records = await this.opts.installed.all();
    return records.map((r) => r.id);
  }

  async resolveBundle(id: string): Promise<string> {
    const rec = await this.opts.installed.get(id);
    if (!rec) throw new Error(`tracker not found: ${id}`);

    const cached = await this.cache.read(id, rec.sha256);
    if (cached !== null) return cached;

    const opts: { publicKey?: string; requireSignature?: boolean } = {};
    if (rec.publicKey !== undefined) opts.publicKey = rec.publicKey;
    if (this.opts.requireSignature !== undefined) opts.requireSignature = this.opts.requireSignature;

    const { text } = await this.opts.fetcher.downloadBundle(
      { id: rec.id, url: rec.url, sha256: rec.sha256, signature: rec.signature },
      opts,
    );
    await this.cache.write(id, rec.sha256, text);
    return text;
  }
}
