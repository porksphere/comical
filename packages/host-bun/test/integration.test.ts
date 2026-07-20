/**
 * Host-adapter integration: drives the real reference bridge over real HTTP through the Bun host
 * (native fetch + rate limiting), against the testkit fixture backend served on localhost.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadBridge } from "@comical/core";
import { FixtureBackend } from "@comical/testkit";
import { FileStorage, MemoryStorage, createBunHost, createBunNetwork } from "../src/index.ts";

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

    const results = await bridge.getSearchResults!("sherlock", 1);
    expect(results.items.length).toBeGreaterThan(0);
    expect(results.items[0]!.id).toBe("sherlock");

    const pages = await bridge.getChapterPages!("sherlock", "sherlock-1");
    expect(pages.length).toBe(4);
    expect(pages[0]!.imageUrl).toBe("https://picsum.photos/seed/sherlock-sherlock-1-1/700/1000");
  });
});

describe("binary response (responseType: base64)", () => {
  // Bytes that are NOT valid UTF-8 (0xff, 0xfe, lone 0x80) — a text decode mangles them, proving the
  // base64 path is lossless where the default text path would corrupt a binary index like a .nozomi.
  const RAW = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x80, 0x7f, 0x41]);

  test("base64 round-trips raw bytes that UTF-8 would corrupt", async () => {
    const srv = Bun.serve({ port: 0, fetch: () => new Response(RAW) });
    try {
      const net = createBunNetwork();
      const url = `http://localhost:${srv.port}/blob`;

      const b64 = await net.request({ url, responseType: "base64" });
      expect(new Uint8Array(Buffer.from(b64.body, "base64"))).toEqual(RAW);

      // The default text path can't reproduce these bytes (0xff etc. become U+FFFD) — confirm they differ.
      const text = await net.request({ url });
      expect(new TextEncoder().encode(text.body)).not.toEqual(RAW);
    } finally {
      srv.stop(true);
    }
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
