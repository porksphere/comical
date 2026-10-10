import { describe, expect, test } from "bun:test";
import { describeMissingBridges, withRetired } from "../src/missing.ts";
import type { RegistryBridgeEntry, RetiredBridge } from "../src/schema.ts";

const A = "https://a.example/index.json";
const B = "https://b.example/index.json";

function entry(id: string, name: string, extra: Partial<RegistryBridgeEntry> = {}): RegistryBridgeEntry {
  return {
    id, name, version: "1.0.0", contractVersion: "2.0.0", languages: ["en"], nsfw: false, capabilities: [],
    url: "https://a.example/b.js", sha256: "a".repeat(64), ...extra,
  };
}

const retiredRec = (id: string, extra: Partial<RetiredBridge> = {}): RetiredBridge => ({
  id, registryUrl: A, uninstalledAt: "2026-10-01T00:00:00.000Z", ...extra,
});

describe("describeMissingBridges", () => {
  test("a retired snapshot wins over an index entry", async () => {
    const out = await describeMissingBridges(["x"], {
      retired: [retiredRec("x", { info: { name: "Kept", nsfw: true, capabilities: ["direct"] } })],
      cached: [{ entry: entry("x", "From index"), registryUrl: A }],
    });
    expect(out).toEqual([{ id: "x", name: "Kept", nsfw: true, capabilities: ["direct"], registryUrl: A }]);
  });

  test("prefers the registry it was installed from over another listing the same id", async () => {
    const out = await describeMissingBridges(["x"], {
      retired: [retiredRec("x", { registryUrl: B })],
      cached: [
        { entry: entry("x", "Someone else's", { nsfw: true }), registryUrl: A },
        { entry: entry("x", "The original"), registryUrl: B },
      ],
    });
    expect(out[0]).toMatchObject({ name: "The original", nsfw: false, registryUrl: B });
  });

  test("falls back to any registry when its own no longer lists it", async () => {
    const out = await describeMissingBridges(["x"], {
      retired: [retiredRec("x", { registryUrl: B })],
      cached: [{ entry: entry("x", "Elsewhere"), registryUrl: A }],
    });
    // Named from A, but still pointed back at where it came from.
    expect(out[0]).toMatchObject({ name: "Elsewhere", registryUrl: B });
  });

  test("only goes to the network for ids nothing local knows", async () => {
    let browsed = 0;
    const browseAll = async () => {
      browsed++;
      return [{ entry: entry("y", "Remote"), registryUrl: A }];
    };
    await describeMissingBridges(["x"], { retired: [], cached: [{ entry: entry("x", "Cached"), registryUrl: A }], browseAll });
    expect(browsed).toBe(0);
    const out = await describeMissingBridges(["x", "y"], {
      retired: [], cached: [{ entry: entry("x", "Cached"), registryUrl: A }], browseAll,
    });
    expect(browsed).toBe(1);
    expect(out.map((m) => m.name)).toEqual(["Cached", "Remote"]);
  });

  test("a registry that doesn't answer in time leaves the id unnamed", async () => {
    const started = Date.now();
    const out = await describeMissingBridges(["x"], {
      retired: [],
      cached: [],
      browseAll: () => new Promise(() => {}),
      timeoutMs: 20,
    });
    expect(out).toEqual([{ id: "x" }]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a failing browse leaves the id unnamed rather than throwing", async () => {
    const out = await describeMissingBridges(["x"], {
      retired: [], cached: [], browseAll: () => Promise.reject(new Error("offline")),
    });
    expect(out).toEqual([{ id: "x" }]);
  });

  test("keeps the order it was asked in", async () => {
    const out = await describeMissingBridges(["b", "a"], { retired: [], cached: [] });
    expect(out.map((m) => m.id)).toEqual(["b", "a"]);
  });
});

describe("withRetired", () => {
  test("replaces by id, or removes without a record", () => {
    const list = [retiredRec("x"), retiredRec("y")];
    expect(withRetired(list, "x", retiredRec("x", { registryUrl: B })).map((r) => [r.id, r.registryUrl])).toEqual([
      ["y", A],
      ["x", B],
    ]);
    expect(withRetired(list, "x").map((r) => r.id)).toEqual(["y"]);
  });
});
