/**
 * Integration tests for folding tag *names* into the id-only `excludedTags` response (capability
 * "resolve-tags" + the shared TagLabelCache). The `example` bridge advertises "resolve-tags" and
 * resolves t1→Action, t2→Romance, t3→Comedy; `direct-example` advertises neither, so its ids stay
 * bare. Each assertion uses a fresh server so the host cache starts cold.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DirectFixtureBackend, FixtureBackend } from "@comical/testkit";
import { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-excluded-tag-labels");

let baseUrl: string;
let stop: () => void;
let fixtureStop: () => void;
let directStop: () => void;

type DetailBody = { excludedTags?: string[]; excludedTagLabels?: Record<string, string> };

function putExcluded(bridgeId: string, body: { tags: string[]; labels?: Record<string, string> }): Promise<Response> {
  return fetch(`${baseUrl}/bridges/${bridgeId}/excluded-tags`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function detail(bridgeId: string): Promise<DetailBody> {
  return fetch(`${baseUrl}/bridges/${bridgeId}`).then((r) => r.json()) as Promise<DetailBody>;
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

describe("excludedTagLabels folding (example, resolve-tags-capable)", () => {
  test("a cold-cache detail load resolves ids via the bridge (the self-heal case)", async () => {
    // PUT bare ids with NO labels — exactly the stale-data case. The cache has never seen them.
    await putExcluded("example", { tags: ["t1", "t2"] });
    const body = await detail("example");
    expect(body.excludedTags).toEqual(["t1", "t2"]);
    expect(body.excludedTagLabels).toEqual({ t1: "Action", t2: "Romance" });
    await putExcluded("example", { tags: [] });
  });

  test("ids the bridge can't resolve are simply absent (client falls back to the id)", async () => {
    await putExcluded("example", { tags: ["t1", "unknown"] });
    const body = await detail("example");
    expect(body.excludedTagLabels).toEqual({ t1: "Action" }); // no entry for `unknown`
    await putExcluded("example", { tags: [] });
  });

  test("client-supplied labels on PUT seed the cache (no resolve needed)", async () => {
    // `custom` isn't in the bridge's resolve table, but the client knows its label.
    const res = await putExcluded("example", { tags: ["custom"], labels: { custom: "My Tag" } });
    expect(res.status).toBe(200);
    expect((await res.json() as DetailBody).excludedTagLabels).toEqual({ custom: "My Tag" });

    const body = await detail("example");
    expect(body.excludedTagLabels).toEqual({ custom: "My Tag" });
    await putExcluded("example", { tags: [] });
  });
});

describe("excludedTagLabels on a non-resolving bridge (direct-example)", () => {
  test("ids stay bare — no labels folded in", async () => {
    await putExcluded("direct-example", { tags: ["t1"] });
    const body = await detail("direct-example");
    expect(body.excludedTags).toEqual(["t1"]);
    expect(body.excludedTagLabels).toEqual({});
    await putExcluded("direct-example", { tags: [] });
  });
});
