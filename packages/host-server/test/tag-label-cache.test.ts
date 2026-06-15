/**
 * Unit tests for TagLabelCache — the host-side id→label memory that lets the server fold tag names
 * back into id-only responses. Pure in-memory; no server needed.
 */
import { describe, expect, test } from "bun:test";
import { TagLabelCache, type ResolvableBridge } from "../src/tag-label-cache.ts";

function bridge(id: string, resolveTags?: ResolvableBridge["resolveTags"], capable = true): ResolvableBridge {
  return {
    info: { id, capabilities: capable ? ["resolve-tags"] : [] },
    ...(resolveTags ? { resolveTags } : {}),
  };
}

describe("TagLabelCache.remember / known", () => {
  test("remembers id→label pairs and returns the cached subset", () => {
    const cache = new TagLabelCache();
    cache.remember("b", [{ id: "1", label: "Action" }, { id: "2", label: "Romance" }]);
    expect(cache.known("b", ["1", "2", "3"])).toEqual({ "1": "Action", "2": "Romance" });
  });

  test("ignores a label equal to its id (free-form, no information)", () => {
    const cache = new TagLabelCache();
    cache.remember("b", [{ id: "x", label: "x" }, { id: "y", label: "" }]);
    expect(cache.known("b", ["x", "y"])).toEqual({});
  });

  test("keeps bridges in separate namespaces", () => {
    const cache = new TagLabelCache();
    cache.remember("a", [{ id: "1", label: "Alpha" }]);
    cache.remember("b", [{ id: "1", label: "Beta" }]);
    expect(cache.known("a", ["1"])).toEqual({ "1": "Alpha" });
    expect(cache.known("b", ["1"])).toEqual({ "1": "Beta" });
  });
});

describe("TagLabelCache.resolve", () => {
  test("serves cache hits without calling the bridge", async () => {
    const cache = new TagLabelCache();
    cache.remember("b", [{ id: "1", label: "Action" }]);
    let called = false;
    const out = await cache.resolve(bridge("b", () => { called = true; return Promise.resolve([]); }), ["1"]);
    expect(out).toEqual({ "1": "Action" });
    expect(called).toBe(false);
  });

  test("resolves only the misses via the bridge, then caches them", async () => {
    const cache = new TagLabelCache();
    cache.remember("b", [{ id: "1", label: "Action" }]);
    const seen: string[][] = [];
    const b = bridge("b", (ids) => {
      seen.push(ids);
      return Promise.resolve(ids.map((id) => ({ id, label: `L${id}` })));
    });

    const out = await cache.resolve(b, ["1", "2", "3"]);
    expect(out).toEqual({ "1": "Action", "2": "L2", "3": "L3" });
    expect(seen).toEqual([["2", "3"]]); // only the misses

    // Second call is fully cached — the bridge isn't hit again.
    const again = await cache.resolve(b, ["1", "2", "3"]);
    expect(again).toEqual({ "1": "Action", "2": "L2", "3": "L3" });
    expect(seen).toHaveLength(1);
  });

  test("does not call a bridge lacking the resolve-tags capability", async () => {
    const cache = new TagLabelCache();
    let called = false;
    const out = await cache.resolve(bridge("b", () => { called = true; return Promise.resolve([]); }, false), ["1"]);
    expect(out).toEqual({}); // miss stays unresolved → caller shows the id
    expect(called).toBe(false);
  });

  test("tolerates a throwing resolveTags — returns the cached subset", async () => {
    const cache = new TagLabelCache();
    cache.remember("b", [{ id: "1", label: "Action" }]);
    const out = await cache.resolve(bridge("b", () => Promise.reject(new Error("boom"))), ["1", "2"]);
    expect(out).toEqual({ "1": "Action" });
  });
});
