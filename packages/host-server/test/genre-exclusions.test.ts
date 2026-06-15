/**
 * Integration tests for the per-bridge "excluded genres" feature (capability "exclude-genres").
 *
 * Unlike excluded tags (host-stored + query-injected), genre exclusions live on the bridge's backend
 * account, so the host neither persists nor injects them — it just reads/writes through the bridge.
 * The in-repo `example` bridge advertises "exclude-genres" and keeps an in-memory exclusion set on its
 * (manager-cached) instance, which is enough to exercise the GET/PUT round-trip. `direct-example` does
 * NOT advertise the capability, so both endpoints must 400.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DirectFixtureBackend, FixtureBackend } from "@comical/testkit";
import { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-genre-exclusions");

let baseUrl: string;
let stop: () => void;
let fixtureStop: () => void;
let directStop: () => void;

type GenreExclusions = { available: { id: string; label: string }[]; excluded: string[] };

function getGenres(bridgeId: string): Promise<Response> {
  return fetch(`${baseUrl}/bridges/${bridgeId}/genre-exclusions`);
}

function setGenres(bridgeId: string, genres: unknown): Promise<Response> {
  return fetch(`${baseUrl}/bridges/${bridgeId}/genre-exclusions`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ genres }),
  });
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

describe("GET/PUT /bridges/:id/genre-exclusions on a capable bridge (example)", () => {
  test("GET returns the pickable genres and an (initially empty) exclusion set", async () => {
    const res = await getGenres("example");
    expect(res.status).toBe(200);
    const body = (await res.json()) as GenreExclusions;
    expect(body.available.map((g) => g.id)).toContain("Horror");
    expect(body.excluded).toEqual([]);
  });

  test("PUT replaces the exclusion set and returns the new state", async () => {
    const res = await setGenres("example", ["Horror", "Gothic"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GenreExclusions;
    expect(new Set(body.excluded)).toEqual(new Set(["Horror", "Gothic"]));

    // The account (here, the cached instance) is the source of truth — a fresh GET reflects it.
    const after = (await getGenres("example").then((r) => r.json())) as GenreExclusions;
    expect(new Set(after.excluded)).toEqual(new Set(["Horror", "Gothic"]));

    await setGenres("example", []); // reset for other tests
  });

  test("PUT drops ids that aren't real genres", async () => {
    const res = await setGenres("example", ["Horror", "NotAGenre"]);
    const body = (await res.json()) as GenreExclusions;
    expect(body.excluded).toEqual(["Horror"]);
    await setGenres("example", []);
  });

  test("PUT rejects a non-array / non-string body", async () => {
    expect((await setGenres("example", "Horror")).status).toBe(400);
    expect((await setGenres("example", ["ok", 5])).status).toBe(400);
  });

  test("PUT 404s for an unknown bridge", async () => {
    expect((await setGenres("nonexistent", ["Horror"])).status).toBe(404);
  });
});

describe("genre exclusions on a non-capable bridge (direct-example)", () => {
  test("both endpoints 400 (capability + method absent)", async () => {
    const detail = (await fetch(`${baseUrl}/bridges/direct-example`).then((r) => r.json())) as {
      info: { capabilities?: string[] };
    };
    expect(detail.info.capabilities).not.toContain("exclude-genres");

    expect((await getGenres("direct-example")).status).toBe(400);
    expect((await setGenres("direct-example", ["Horror"])).status).toBe(400);
  });
});
