/**
 * Integration tests for the per-bridge "excluded tags" feature (capability "exclude-tags").
 *
 * Spins up the full server against two backends:
 *   - `example` → FixtureBackend (advertises "exclude-tags"; honours options.excludedTags by
 *     pushing an `excludeGenre` negation down to the backend).
 *   - `direct-example` → DirectFixtureBackend (does NOT advertise "exclude-tags"; exclusions are
 *     stored but inert — results must be untouched).
 *
 * Isolated from server.test.ts (own DATA_DIR) because that suite mutates the example baseUrl.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DirectFixtureBackend, FixtureBackend } from "@comical/testkit";
import { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-excluded-tags");

let baseUrl: string;
let stop: () => void;
let fixtureStop: () => void;
let directStop: () => void;

type SearchBody = { items: Array<{ id: string }> };
type DetailBody = { info: { id: string; capabilities?: string[] }; excludedTags?: string[] };

async function setExcluded(bridgeId: string, tags: string[]): Promise<Response> {
  return fetch(`${baseUrl}/bridges/${bridgeId}/excluded-tags`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags }),
  });
}

async function searchIds(bridgeId: string, q: string): Promise<string[]> {
  const data = (await fetch(`${baseUrl}/bridges/${bridgeId}/search?q=${encodeURIComponent(q)}`).then((r) => r.json())) as SearchBody;
  return data.items.map((i) => i.id);
}

beforeAll(async () => {
  const fixture = new FixtureBackend().serve();
  fixtureStop = fixture.stop;
  const direct = new DirectFixtureBackend().serve();
  directStop = direct.stop;

  const settings = new SettingsStore(DATA_DIR);
  await settings.set("example", { baseUrl: fixture.url });
  await settings.set("direct-example", { baseUrl: direct.url });

  const manager = new BridgeManager({ bridgesDir: BRIDGES_DIR, dataDir: DATA_DIR, settings });
  const srv = Bun.serve({ port: 0, fetch: createRouter(manager).fetch });
  baseUrl = `http://localhost:${srv.port}`;
  stop = () => srv.stop(true);
});

afterAll(() => { stop(); fixtureStop(); directStop(); });

describe("PUT /bridges/:id/excluded-tags", () => {
  test("persists and round-trips in bridge detail", async () => {
    const res = await setExcluded("example", ["Horror", "Gothic"]);
    expect(res.status).toBe(200);
    expect((await res.json() as { excludedTags: string[] }).excludedTags).toEqual(["Horror", "Gothic"]);

    const detail = await fetch(`${baseUrl}/bridges/example`).then((r) => r.json()) as DetailBody;
    expect(detail.excludedTags).toEqual(["Horror", "Gothic"]);

    await setExcluded("example", []); // reset for other tests
  });

  test("dedupes and drops blank entries", async () => {
    const res = await setExcluded("example", ["Horror", "Horror", "  ", ""]);
    expect((await res.json() as { excludedTags: string[] }).excludedTags).toEqual(["Horror"]);
    await setExcluded("example", []);
  });

  test("rejects a non-array / non-string body", async () => {
    const bad = await fetch(`${baseUrl}/bridges/example/excluded-tags`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags: "Horror" }),
    });
    expect(bad.status).toBe(400);

    const badItem = await fetch(`${baseUrl}/bridges/example/excluded-tags`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags: ["ok", 5] }),
    });
    expect(badItem.status).toBe(400);
  });

  test("404 for an unknown bridge", async () => {
    const res = await setExcluded("nonexistent", ["Horror"]);
    expect(res.status).toBe(404);
  });

  test("the reserved key is not surfaced among descriptor values", async () => {
    await setExcluded("example", ["Horror"]);
    const detail = await fetch(`${baseUrl}/bridges/example`).then((r) => r.json()) as DetailBody & { values: Record<string, unknown> };
    expect(detail.values).not.toHaveProperty("excludedTags");
    await setExcluded("example", []);
  });
});

describe("native exclusion on a capable bridge (example)", () => {
  test("search omits excluded-genre series, keeps others", async () => {
    // Frankenstein/Dracula are Horror; Alice is Fantasy/Adventure.
    const before = await searchIds("example", "");
    expect(before).toContain("frankenstein");
    expect(before).toContain("alice");

    await setExcluded("example", ["Horror"]);
    const after = await searchIds("example", "");
    expect(after).not.toContain("frankenstein");
    expect(after).not.toContain("dracula");
    expect(after).toContain("alice");

    await setExcluded("example", []);
  });

  test("a query that only matches an excluded series returns nothing", async () => {
    expect(await searchIds("example", "frankenstein")).toEqual(["frankenstein"]);
    await setExcluded("example", ["Horror"]);
    expect(await searchIds("example", "frankenstein")).toEqual([]);
    await setExcluded("example", []);
  });

  test("empty/cleared exclusions are a no-op", async () => {
    await setExcluded("example", []);
    expect(await searchIds("example", "frankenstein")).toEqual(["frankenstein"]);
  });

  test("list results also drop excluded-genre series", async () => {
    type ListBody = { items: Array<{ id: string }> };
    const url = `${baseUrl}/bridges/example/lists/completed?q=frankenstein`;
    const before = (await fetch(url).then((r) => r.json())) as ListBody;
    expect(before.items.map((i) => i.id)).toContain("frankenstein");

    await setExcluded("example", ["Horror"]);
    const after = (await fetch(url).then((r) => r.json())) as ListBody;
    expect(after.items.map((i) => i.id)).not.toContain("frankenstein");

    await setExcluded("example", []);
  });
});

describe("inert exclusion on a non-capable bridge (direct-example)", () => {
  test("exclusions are stored but results are unchanged", async () => {
    const detail0 = await fetch(`${baseUrl}/bridges/direct-example`).then((r) => r.json()) as DetailBody;
    expect(detail0.info.capabilities).not.toContain("exclude-tags");

    type ListBody = { items: Array<{ id: string }> };
    const listUrl = `${baseUrl}/bridges/direct-example/lists/all`;
    const before = ((await fetch(listUrl).then((r) => r.json())) as ListBody).items.map((i) => i.id);
    expect(before).toContain("raven"); // raven is tagged Horror in the direct catalog

    const put = await setExcluded("direct-example", ["Horror"]);
    expect(put.status).toBe(200); // stored even though inert

    const detail = await fetch(`${baseUrl}/bridges/direct-example`).then((r) => r.json()) as DetailBody;
    expect(detail.excludedTags).toEqual(["Horror"]);

    const after = ((await fetch(listUrl).then((r) => r.json())) as ListBody).items.map((i) => i.id);
    expect(after).toEqual(before); // unchanged — no host-side filtering, bridge never sees the exclusion

    await setExcluded("direct-example", []);
  });
});
