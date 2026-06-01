/**
 * Local registry manifest — persisted in dataDir/registry-manifest.json.
 * Tracks which registries the user has added and which bridges are installed
 * (from registries or locally built).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type InstalledBridge,
  type Manifest,
  manifestSchema,
  type SavedRegistry,
} from "./schema.ts";

const EMPTY: Manifest = { registries: [], installed: [] };

export class ManifestStore {
  private readonly path: string;
  private cache: Manifest | undefined;

  constructor(dataDir: string) {
    this.path = join(dataDir, "registry-manifest.json");
  }

  async read(): Promise<Manifest> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = manifestSchema.safeParse(JSON.parse(raw));
      this.cache = parsed.success ? parsed.data : structuredClone(EMPTY);
    } catch {
      this.cache = structuredClone(EMPTY);
    }
    return this.cache;
  }

  private async write(manifest: Manifest): Promise<void> {
    this.cache = manifest;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(manifest, null, 2), "utf8");
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

  async updateLastFetched(url: string): Promise<void> {
    const m = await this.read();
    const reg = m.registries.find((r) => r.url === url);
    if (reg) reg.lastFetched = new Date().toISOString();
    await this.write(m);
  }

  // ── Installed bridges ──────────────────────────────────────────────────────

  async addInstalled(bridge: InstalledBridge): Promise<void> {
    const m = await this.read();
    m.installed = m.installed.filter((b) => b.id !== bridge.id);
    m.installed.push(bridge);
    await this.write(m);
  }

  async removeInstalled(id: string): Promise<void> {
    const m = await this.read();
    m.installed = m.installed.filter((b) => b.id !== id);
    await this.write(m);
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
}
