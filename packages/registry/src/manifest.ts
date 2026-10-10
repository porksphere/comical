/**
 * Local registry manifest — persisted in dataDir/registry-manifest.json.
 * Tracks which registries the user has added and which bridges are installed
 * (from registries or locally built).
 */
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "@comical/host-bun";
import { withRetired } from "./missing.ts";
import {
  type InstalledBridge,
  type InstalledTracker,
  type Manifest,
  manifestSchema,
  type RetiredBridge,
  type SavedRegistry,
} from "./schema.ts";
import { registryDisplayName } from "./url.ts";

const EMPTY: Manifest = { registries: [], installed: [], installedTrackers: [], retired: [] };

export class ManifestStore {
  private readonly path: string;
  private cache: Manifest | undefined;

  constructor(dataDir: string) {
    this.path = join(dataDir, "registry-manifest.json");
  }

  private loading: Promise<Manifest> | undefined;

  /**
   * The manifest, loaded once. A file that doesn't parse or fails the schema is moved aside to
   * `registry-manifest.json.corrupt-<ts>` (never read as empty and then overwritten — that would
   * silently forget every registry and install); a real IO error throws.
   */
  async read(): Promise<Manifest> {
    if (this.cache) return this.cache;
    this.loading ??= readJsonFile<Manifest>(this.path, structuredClone(EMPTY), {
      decode: (raw) => manifestSchema.parse(raw),
    }).then(
      (manifest) => {
        this.cache ??= manifest;
        this.loading = undefined;
        return this.cache;
      },
      (err: unknown) => {
        this.loading = undefined;
        throw err;
      },
    );
    return this.loading;
  }

  private async write(manifest: Manifest): Promise<void> {
    this.cache = manifest;
    // Serialize the cache as it is when the write runs, so overlapping writes land in order.
    await writeJsonFile(this.path, manifest);
  }

  // ── Registries ─────────────────────────────────────────────────────────────

  async addRegistry(registry: SavedRegistry): Promise<void> {
    const m = await this.read();
    const existing = m.registries.findIndex((r) => r.url === registry.url);
    if (existing >= 0) m.registries[existing] = registry;
    else m.registries.push(registry);
    await this.write(m);
  }

  async removeRegistry(url: string): Promise<void> {
    const m = await this.read();
    m.registries = m.registries.filter((r) => r.url !== url);
    await this.write(m);
  }

  async getRegistry(url: string): Promise<SavedRegistry | undefined> {
    return (await this.read()).registries.find((r) => r.url === url);
  }

  /**
   * Repoint a saved registry — and every bridge/tracker installed from it — at a new URL.
   *
   * The URL is the manifest's primary key, so this is a remove+add rather than an upsert
   * (`addRegistry` keys by url and would leave the old row stranded), and `registryUrl` has to move
   * on every installed record or they all orphan (`isOrphaned` compares against the saved list).
   * Both halves land in a single `write`, so an interrupted migration cannot half-apply — the
   * device-side equivalent, which writes each store separately, has to order its writes instead.
   *
   * Idempotent: a no-op when `oldUrl` isn't saved, and collapses onto any row already at `newUrl`.
   */
  async rebindRegistry(oldUrl: string, newUrl: string): Promise<void> {
    if (oldUrl === newUrl) return;
    const m = await this.read();
    const existing = m.registries.find((r) => r.url === oldUrl);
    if (!existing) return;

    const moved: SavedRegistry = { ...existing, url: newUrl, name: registryDisplayName(newUrl) };
    // The move has happened — any pending prompts about it are now resolved.
    delete moved.pendingMove;
    delete moved.pendingAdoption;

    m.registries = m.registries.filter((r) => r.url !== oldUrl && r.url !== newUrl);
    m.registries.push(moved);
    for (const b of m.installed) if (b.registryUrl === oldUrl) b.registryUrl = newUrl;
    for (const t of m.installedTrackers) if (t.registryUrl === oldUrl) t.registryUrl = newUrl;
    // So "get it back from" names where the registry lives now.
    for (const r of m.retired) if (r.registryUrl === oldUrl) r.registryUrl = newUrl;
    await this.write(m);
  }

  /** Record (or clear, with `undefined`) an unverified `movedTo` claim awaiting user confirmation. */
  async setPendingMove(url: string, target: string | undefined): Promise<void> {
    const m = await this.read();
    const reg = m.registries.find((r) => r.url === url);
    if (!reg) return;
    if ((reg.pendingMove ?? undefined) === target) return; // no-op — don't rewrite the file
    if (target) reg.pendingMove = target;
    else delete reg.pendingMove;
    await this.write(m);
  }

  /** Record the set of unverified `movedFrom` claims this registry makes (empty clears it). */
  async setPendingAdoption(url: string, candidates: string[]): Promise<void> {
    const m = await this.read();
    const reg = m.registries.find((r) => r.url === url);
    if (!reg) return;
    const next = candidates.length ? candidates : undefined;
    if (JSON.stringify(reg.pendingAdoption ?? undefined) === JSON.stringify(next)) return;
    if (next) reg.pendingAdoption = next;
    else delete reg.pendingAdoption;
    await this.write(m);
  }

  async updateLastFetched(url: string): Promise<void> {
    const m = await this.read();
    const reg = m.registries.find((r) => r.url === url);
    if (reg) reg.lastFetched = new Date().toISOString();
    await this.write(m);
  }

  // ── Installed bridges ──────────────────────────────────────────────────────

  /** Record an install. Installing a bridge again clears its retired record in the same write. */
  async addInstalled(bridge: InstalledBridge): Promise<void> {
    const m = await this.read();
    m.installed = m.installed.filter((b) => b.id !== bridge.id);
    m.installed.push(bridge);
    m.retired = withRetired(m.retired, bridge.id);
    await this.write(m);
  }

  /** Drop an install record outright — nothing is kept of it. `retireInstalled` is the uninstall. */
  async removeInstalled(id: string): Promise<void> {
    const m = await this.read();
    m.installed = m.installed.filter((b) => b.id !== id);
    await this.write(m);
  }

  /**
   * Uninstall: drop the install record and keep what's needed to still show the bridge's series —
   * its name, rating and capabilities, and where it came from — as a retired record, in one write.
   * A no-op for an id that isn't installed.
   */
  async retireInstalled(id: string, at: string): Promise<void> {
    const m = await this.read();
    const rec = m.installed.find((b) => b.id === id);
    if (!rec) return;
    m.installed = m.installed.filter((b) => b.id !== id);
    m.retired = withRetired(m.retired, id, {
      id,
      registryUrl: rec.registryUrl,
      ...(rec.info ? { info: rec.info } : {}),
      uninstalledAt: at,
    });
    await this.write(m);
  }

  async allRetired(): Promise<RetiredBridge[]> {
    return (await this.read()).retired;
  }

  async getInstalled(id: string): Promise<InstalledBridge | undefined> {
    return (await this.read()).installed.find((b) => b.id === id);
  }

  async allInstalled(): Promise<InstalledBridge[]> {
    return (await this.read()).installed;
  }

  async allRegistries(): Promise<SavedRegistry[]> {
    return (await this.read()).registries;
  }

  /** Returns IDs of bridges installed from `registryUrl`. */
  async bridgesFromRegistry(registryUrl: string): Promise<string[]> {
    return (await this.read()).installed
      .filter((b) => b.registryUrl === registryUrl)
      .map((b) => b.id);
  }

  // ── Installed trackers ─────────────────────────────────────────────────────

  async addInstalledTracker(tracker: InstalledTracker): Promise<void> {
    const m = await this.read();
    m.installedTrackers = m.installedTrackers.filter((t) => t.id !== tracker.id);
    m.installedTrackers.push(tracker);
    await this.write(m);
  }

  async removeInstalledTracker(id: string): Promise<void> {
    const m = await this.read();
    m.installedTrackers = m.installedTrackers.filter((t) => t.id !== id);
    await this.write(m);
  }

  async getInstalledTracker(id: string): Promise<InstalledTracker | undefined> {
    return (await this.read()).installedTrackers.find((t) => t.id === id);
  }

  async allInstalledTrackers(): Promise<InstalledTracker[]> {
    return (await this.read()).installedTrackers;
  }

  /** Returns IDs of trackers installed from `registryUrl`. */
  async trackersFromRegistry(registryUrl: string): Promise<string[]> {
    return (await this.read()).installedTrackers
      .filter((t) => t.registryUrl === registryUrl)
      .map((t) => t.id);
  }
}
