/**
 * Host-adapter integration: drives the real reference bridge over real HTTP through the Bun host
 * (native fetch + rate limiting), against the testkit fixture backend served on localhost.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadBridge } from "@comical/core";
import { FixtureBackend } from "@comical/testkit";
import { FileStorage, MemoryStorage, createBunHost } from "../src/index.ts";

const BUNDLE = readFileSync(
  join(import.meta.dir, "..", "..", "..", "bridges", "example-bridge", "dist", "bridge.js"),
  "utf8",
);

let server: { url: string; stop: () => void };

beforeAll(() => {
  server = new FixtureBackend().serve();
});
afterAll(() => server.stop());

describe("host-bun integration (real HTTP)", () => {
  test("loads the bridge and fetches search results over HTTP", async () => {
    const bridge = loadBridge({
      code: BUNDLE,
      capabilities: createBunHost({ bridgeId: "example", settings: { baseUrl: server.url } }),
      expectedId: "example",
    });

    const results = await bridge.getSearchResults("sherlock", 1);
    expect(results.items.length).toBeGreaterThan(0);
    expect(results.items[0]!.id).toBe("sherlock");

    const pages = await bridge.getChapterPages("sherlock", "sherlock-1");
    expect(pages.length).toBe(4);
    expect(pages[0]!.imageUrl).toBe(`${server.url}/img/sherlock/sherlock-1/1.png`);
  });
});

describe("storage", () => {
  test("MemoryStorage round-trips", async () => {
    const s = new MemoryStorage();
    await s.set("k", "v");
    expect(await s.get("k")).toBe("v");
    expect(await s.keys()).toEqual(["k"]);
    await s.delete("k");
    expect(await s.get("k")).toBeUndefined();
  });

  test("FileStorage persists across instances and is namespaced per bridge", async () => {
    const dir = join(import.meta.dir, ".tmp-storage", String(Date.now()));
    const a = new FileStorage(dir, "example");
    await a.set("token", "abc");

    const reopened = new FileStorage(dir, "example");
    expect(await reopened.get("token")).toBe("abc");

    const other = new FileStorage(dir, "another-bridge");
    expect(await other.get("token")).toBeUndefined();
  });
});
