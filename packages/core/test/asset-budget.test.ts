/**
 * `assetBudgetFor` is how the image proxy and the download engine both read a bridge's
 * `assetRateLimit`: the default budget for every asset host, a `byHost` group's own budget for the
 * hosts it names (unlimited when it names none), and a proxied URL judged by its target.
 */
import { describe, expect, test } from "bun:test";
import type { AssetRateLimit } from "@comical/contract";
import { assetBudgetFor, assetHostOf } from "../src/net/asset-budget.ts";

const decl: AssetRateLimit = {
  maxConcurrent: 2,
  minIntervalMs: 500,
  byHost: [
    { hosts: ["tn.cdn.example"] },
    { hosts: ["cdn.example"], maxConcurrent: 6 },
  ],
};

describe("assetHostOf", () => {
  test("unwraps a server-relative or absolute img-proxy URL to its target host", () => {
    const target = encodeURIComponent("https://tn.cdn.example/t/1.webp");
    expect(assetHostOf(`/img-proxy?url=${target}`)).toBe("tn.cdn.example");
    expect(assetHostOf(`http://localhost:3100/img-proxy?url=${target}`)).toBe("tn.cdn.example");
    expect(assetHostOf(`/img-proxy?referer=x&url=${target}&v=2`)).toBe("tn.cdn.example");
    expect(assetHostOf("https://a.cdn.example/p/1.jpg")).toBe("a.cdn.example");
    expect(assetHostOf("/bridges/x/page-image/1")).toBeUndefined();
  });
});

describe("assetBudgetFor", () => {
  test("no declaration → unpaced", () => {
    expect(assetBudgetFor(undefined, "https://cdn.example/1.jpg")).toBeUndefined();
  });

  test("the first group naming the host wins and stands alone", () => {
    expect(assetBudgetFor(decl, "https://tn.cdn.example/t/1.webp")).toEqual({ key: "0", budget: {} });
    expect(assetBudgetFor(decl, "https://a1.cdn.example/p/1.jpg")).toEqual({ key: "1", budget: { maxConcurrent: 6 } });
  });

  test("a host no group names, or one the URL hides, gets the default budget", () => {
    const def = { key: "", budget: { maxConcurrent: 2, minIntervalMs: 500 } };
    expect(assetBudgetFor(decl, "https://pages.other.example/1.jpg")).toEqual(def);
    expect(assetBudgetFor(decl, "/bridges/x/page-image/1")).toEqual(def);
    expect(assetBudgetFor({ minIntervalMs: 100 }, "https://cdn.example/1.jpg")).toEqual({ key: "", budget: { minIntervalMs: 100 } });
  });

  test("a proxied asset is judged by its target", () => {
    const url = `/img-proxy?url=${encodeURIComponent("https://tn.cdn.example/t/1.webp")}`;
    expect(assetBudgetFor(decl, url)?.key).toBe("0");
  });
});
