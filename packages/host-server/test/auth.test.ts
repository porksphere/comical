/**
 * Tests the optional bearer token guard middleware. When `token` is provided in RouterOptions,
 * the /bridges/*, /library/*, and /trackers/* routes require a matching Authorization header.
 * /health remains public regardless.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-auth");
const TOKEN = "test-secret-token";

let baseUrl: string;
let stop: () => void;

beforeAll(() => {
  const manager = new BridgeManager({
    bridgesDir: BRIDGES_DIR,
    dataDir: DATA_DIR,
    settings: new SettingsStore(DATA_DIR),
  });
  const srv = Bun.serve({ port: 0, fetch: createRouter(manager, { token: TOKEN }).fetch });
  baseUrl = `http://localhost:${srv.port}`;
  stop = () => srv.stop(true);
});

afterAll(() => stop());

describe("bearer token auth guard", () => {
  test("GET /health is always public — no token required", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  test("GET /bridges without Authorization header → 401", async () => {
    const res = await fetch(`${baseUrl}/bridges`);
    expect(res.status).toBe(401);
  });

  test("GET /bridges with wrong token → 401", async () => {
    const res = await fetch(`${baseUrl}/bridges`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  test("GET /bridges with correct token → 200", async () => {
    const res = await fetch(`${baseUrl}/bridges`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  test("malformed Authorization (no Bearer prefix) → 401", async () => {
    const res = await fetch(`${baseUrl}/bridges`, {
      headers: { Authorization: TOKEN },
    });
    expect(res.status).toBe(401);
  });
});
