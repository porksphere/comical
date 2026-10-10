/**
 * `GET /library/missing-bridges`, and the uninstalled bridges' place in a backup's sources.
 *
 * Uninstalling a bridge leaves its series in the library. Without this route a client knows nothing
 * of that bridge: not its name, not that it is adult content (so its series showed with adult
 * content hidden), not that it is `direct` (so its series opened as a chapter list). The route
 * answers from what the uninstall kept, then from a registry that offers the id.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { entryKey, InMemoryLibraryStore, Library, type LibraryBackup } from "@comical/library";
import { ManifestStore, RegistryManager, sha256Hex } from "@comical/registry";
import { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGE_ID = "adult-direct";
const BUNDLE = `module.exports = { default: () => ({
  info: {
    id: "${BRIDGE_ID}",
    name: "Adult Direct",
    version: "1.0.0",
    contractVersion: "2.0.0",
    languages: ["en"],
    nsfw: true,
    capabilities: ["direct"],
  },
  getSeriesDetails: async (id) => ({ id, title: "Example " + id }),
  getChapters: async () => [],
  getChapterPages: async () => [],
}) };`;

let dataDir: string;
let registrySrv: ReturnType<typeof Bun.serve>;
let srv: ReturnType<typeof Bun.serve>;
let noRegistrySrv: ReturnType<typeof Bun.serve>;
let base: string;
let registryUrl: string;
let library: Library;

const missing = async (url = base) => {
  const res = await fetch(`${url}/library/missing-bridges`);
  expect(res.status).toBe(200);
  return (await res.json()) as Array<Record<string, unknown>>;
};
const installUrl = () => `${base}/registries/${encodeURIComponent(registryUrl)}/bridges/${BRIDGE_ID}/install`;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "comical-missing-bridges-"));
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
        bridges: [
          {
            id: BRIDGE_ID, name: "Adult Direct", version: "1.0.0", contractVersion: "2.0.0",
            languages: ["en"], nsfw: true, capabilities: ["direct"],
            url: `http://localhost:${registrySrv.port}/bridge.js`, sha256,
          },
          {
            // Offered, never installed here — a library synced from another device can hold its series.
            id: "offered", name: "Offered Elsewhere", version: "1.0.0", contractVersion: "2.0.0",
            languages: ["en"], nsfw: false, capabilities: [],
            url: `http://localhost:${registrySrv.port}/bridge.js`, sha256,
          },
        ],
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
  library = new Library(new InMemoryLibraryStore());
  srv = Bun.serve({ port: 0, fetch: createRouter(manager, { registry, library }).fetch });
  noRegistrySrv = Bun.serve({ port: 0, fetch: createRouter(manager, { library }).fetch });
  base = `http://localhost:${srv.port}`;

  expect((await fetch(`${base}/registries`, { method: "POST", body: JSON.stringify({ url: registryUrl }) })).status).toBe(201);
});

afterAll(async () => {
  srv.stop(true);
  noRegistrySrv.stop(true);
  registrySrv.stop(true);
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  Reflect.set(library, "store", new InMemoryLibraryStore());
  // Each test starts with the bridge installed and one of its series collected.
  expect((await fetch(installUrl(), { method: "POST" })).status).toBe(201);
  await library.collectSeries({ bridgeId: BRIDGE_ID, seriesId: "s1" }, { seriesTitle: "Kept" });
});

describe("GET /library/missing-bridges", () => {
  test("lists nothing while every referenced bridge is installed", async () => {
    expect(await missing()).toEqual([]);
  });

  test("an uninstalled bridge comes back with its name, rating, capabilities and registry", async () => {
    expect((await fetch(`${base}/bridges/${BRIDGE_ID}`, { method: "DELETE" })).status).toBe(200);
    expect(await missing()).toEqual([
      { id: BRIDGE_ID, name: "Adult Direct", nsfw: true, capabilities: ["direct"], registryUrl },
    ]);
  });

  test("still known after its registry is removed too", async () => {
    expect((await fetch(`${base}/bridges/${BRIDGE_ID}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${base}/registries/${encodeURIComponent(registryUrl)}`, { method: "DELETE" })).status).toBe(200);
    try {
      expect((await missing())[0]).toMatchObject({ id: BRIDGE_ID, nsfw: true, capabilities: ["direct"] });
    } finally {
      await fetch(`${base}/registries`, { method: "POST", body: JSON.stringify({ url: registryUrl }) });
    }
  });

  test("reinstalling it takes it off the list", async () => {
    expect((await fetch(`${base}/bridges/${BRIDGE_ID}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(installUrl(), { method: "POST" })).status).toBe(201);
    expect(await missing()).toEqual([]);
  });

  test("a bridge never installed here is named from a registry offering it; one nobody offers is just its id", async () => {
    await library.recordRead({ bridgeId: "offered", seriesId: "x", title: "Synced", lastReadAt: 1 });
    await library.markRead(entryKey("unheard-of", "y"), "c1", true);
    expect(await missing()).toEqual([
      { id: "offered", name: "Offered Elsewhere", nsfw: false, capabilities: [], registryUrl },
      { id: "unheard-of" },
    ]);
  });

  test("on a host without a registry, missing bridges are listed by id alone", async () => {
    expect((await fetch(`${base}/bridges/${BRIDGE_ID}`, { method: "DELETE" })).status).toBe(200);
    expect(await missing(`http://localhost:${noRegistrySrv.port}`)).toEqual([{ id: BRIDGE_ID }]);
  });
});

describe("backup sources", () => {
  test("name where an uninstalled bridge came from, so a restore can point at it", async () => {
    expect((await fetch(`${base}/bridges/${BRIDGE_ID}`, { method: "DELETE" })).status).toBe(200);
    const backup = (await (await fetch(`${base}/library/backup`)).json()) as LibraryBackup;
    expect(backup.sources?.bridges).toEqual([{ id: BRIDGE_ID, registryUrl }]);
  });
});
