/**
 * Removing a registry stops its bridges from updating, nothing more. The server used to refuse to
 * load them ("orphaned") while a phone kept running the same install, so one library behaved two
 * ways depending on which client you read it through.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ManifestStore, RegistryManager } from "@comical/registry/node";
import { sha256Hex } from "@comical/registry";
import { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";
import type { TrackerProvider } from "../src/tracker-provider.ts";

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
  getSeriesDetails: async (id) => ({ id, title: "Example " + id }),
  getChapters: async () => [],
  getChapterPages: async () => [],
}) };`;

let dataDir: string;
let registrySrv: ReturnType<typeof Bun.serve>;
let srv: ReturnType<typeof Bun.serve>;
let base: string;
let registryUrl: string;
let trackerRefreshes = 0;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "comical-orphaned-registry-"));
  const sha256 = await sha256Hex(new TextEncoder().encode(BUNDLE));
  registrySrv = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/bridge.js") return new Response(BUNDLE);
      if (path !== "/index.json") return new Response("not found", { status: 404 });
      return Response.json({
        registryVersion: "1",
        updated: new Date().toISOString(),
        bridges: [{
          id: BRIDGE_ID, name: "Registry example", version: "1.0.0", contractVersion: "2.0.0",
          languages: ["en"], nsfw: false, capabilities: [],
          url: `http://localhost:${registrySrv.port}/bridge.js`, sha256,
        }],
      });
    },
  });
  registryUrl = `http://localhost:${registrySrv.port}/index.json`;

  const registry = new RegistryManager({ cacheDir: join(dataDir, "bridge-cache"), manifest: new ManifestStore(dataDir) });
  const manager = new BridgeManager({
    bridgesDir: join(dataDir, "no-local-bridges"),
    dataDir,
    settings: new SettingsStore(dataDir),
    registry,
  });
  const trackers = {
    list: async () => [],
    get: async (id: string) => { throw new Error(`tracker not found: ${id}`); },
    storedSettings: async () => ({}),
    updateSettings: async () => ({}),
    invalidate() {},
    refresh() { trackerRefreshes++; },
  } as TrackerProvider;
  srv = Bun.serve({ port: 0, fetch: createRouter(manager, { registry, trackers }).fetch });
  base = `http://localhost:${srv.port}`;

  expect((await fetch(`${base}/registries`, { method: "POST", body: JSON.stringify({ url: registryUrl }) })).status).toBe(201);
  const install = await fetch(`${base}/registries/${encodeURIComponent(registryUrl)}/bridges/${BRIDGE_ID}/install`, { method: "POST" });
  expect(install.status).toBe(201);
  // Loaded before the removal, so the test also covers the cache being dropped and rebuilt.
  expect((await fetch(`${base}/bridges/${BRIDGE_ID}/series/s1`)).status).toBe(200);

  const removed = await fetch(`${base}/registries/${encodeURIComponent(registryUrl)}`, { method: "DELETE" });
  expect(removed.status).toBe(200);
});

afterAll(async () => {
  srv.stop(true);
  registrySrv.stop(true);
  await rm(dataDir, { recursive: true, force: true });
});

describe("a bridge whose registry was removed", () => {
  test("is still listed", async () => {
    const list = (await (await fetch(`${base}/bridges`)).json()) as { info: { id: string }; source: string }[];
    expect(list.map((b) => b.info.id)).toContain(BRIDGE_ID);
  });

  test("still serves its content", async () => {
    const res = await fetch(`${base}/bridges/${BRIDGE_ID}/series/s2`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { title: string }).title).toBe("Example s2");
  });

  test("the registry list no longer holds it", async () => {
    const regs = (await (await fetch(`${base}/registries`)).json()) as { url: string }[];
    expect(regs.map((r) => r.url)).not.toContain(registryUrl);
  });

  test("its removal also dropped the loaded trackers", () => {
    expect(trackerRefreshes).toBe(1);
  });
});
