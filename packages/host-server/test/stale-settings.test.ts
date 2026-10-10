/**
 * A bridge whose stored settings an older version wrote — an enum option this version dropped —
 * must still load and serve. Before, `resolveSettings` threw on it, the bridge failed to load, and a
 * reinstall couldn't fix it: uninstalling never deletes settings, so the bad value came straight back.
 */
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-stale-settings");

let srv: ReturnType<typeof Bun.serve>;
let baseUrl: string;
const warn = console.warn;

beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
  const settings = new SettingsStore(DATA_DIR);
  await settings.set("example", { baseUrl: "https://library.example", defaultSort: "popularity" });
  console.warn = () => {}; // the loader reports the dropped key; not this test's output
  const manager = new BridgeManager({ bridgesDir: BRIDGES_DIR, dataDir: DATA_DIR, settings });
  srv = Bun.serve({ port: 0, fetch: createRouter(manager).fetch });
  baseUrl = `http://localhost:${srv.port}`;
});

afterAll(async () => {
  console.warn = warn;
  srv.stop(true);
  await rm(DATA_DIR, { recursive: true, force: true });
});

describe("a stored setting the installed version no longer accepts", () => {
  test("the bridge still loads and reports itself configured", async () => {
    const res = await fetch(`${baseUrl}/bridges/example`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { missingRequired: string[] };
    expect(body.missingRequired).toEqual([]);
  });

  test("it appears in the bridge list", async () => {
    const res = await fetch(`${baseUrl}/bridges`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as { info: { id: string }; configured: boolean }[];
    expect(list.find((b) => b.info.id === "example")?.configured).toBe(true);
  });

  test("saving a new value is still validated strictly", async () => {
    const bad = await fetch(`${baseUrl}/bridges/example/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultSort: "popularity" }),
    });
    expect(bad.status).toBe(400);
    const good = await fetch(`${baseUrl}/bridges/example/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultSort: "author" }),
    });
    expect(good.status).toBe(200);
  });
});
