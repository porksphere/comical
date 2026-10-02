import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { RegistryManager } from "@comical/registry";
import { BridgeManager } from "../src/bridge-manager.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGE_ID = "registry-example";
const BUNDLE = `module.exports = { default: () => ({
  info: {
    id: "${BRIDGE_ID}",
    name: "Registry example",
    version: "1.0.0",
    contractVersion: "2.0.0",
    languages: ["en"],
    nsfw: false,
    capabilities: [],
  },
  getSeriesDetails: async (id) => ({ id, title: "Example" }),
  getChapters: async () => [],
  getChapterPages: async () => [],
}) };`;

describe("BridgeManager registry listing", () => {
  test("includes a registry-installed bridge from the manifest", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "comical-registry-bridge-list-"));
    try {
      const bundlePath = join(dataDir, "bridge-cache", BRIDGE_ID, "1.0.0", "bridge.js");
      await mkdir(dirname(bundlePath), { recursive: true });
      await writeFile(bundlePath, BUNDLE, "utf8");

      const registry = {
        allInstalled: async () => [{
          id: BRIDGE_ID,
          version: "1.0.0",
          contractVersion: "2.0.0",
          registryUrl: "https://example.com/registry.json",
          bundlePath,
          sha256: "a".repeat(64),
          installedAt: "2026-01-01T00:00:00.000Z",
        }],
        checkUpdates: async () => [{
          id: BRIDGE_ID,
          installedVersion: "1.0.0",
          availableVersion: "1.1.0",
        }],
        isOrphaned: async () => false,
        resolveBundle: async (id: string) => id === BRIDGE_ID ? bundlePath : null,
      } as unknown as RegistryManager;

      const manager = new BridgeManager({
        bridgesDir: join(dataDir, "empty-bridges"),
        dataDir,
        settings: new SettingsStore(dataDir),
        registry,
      });

      const listed = await manager.list();

      expect(listed).toHaveLength(1);
      expect(listed[0]?.info.id).toBe(BRIDGE_ID);
      expect(listed[0]?.source).toBe("registry");
      expect(listed[0]?.configured).toBe(true);
      expect(listed[0]?.availableVersion).toBe("1.1.0");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
