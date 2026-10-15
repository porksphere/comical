/**
 * Schema tests for `bridgeInfoSchema.iconUrl` — a small square icon representing the bridge's
 * source, rendered by clients (e.g. comical-app's bridge picker) as a plain image URL. Optional
 * and additive so bridges that predate the field still validate.
 */
import { describe, expect, test } from "bun:test";
import { bridgeInfoSchema, parseBridgeId } from "../src/models.ts";

const BASE = {
  id: "example",
  name: "Example",
  version: "0.1.0",
  contractVersion: "2.0.0",
  languages: ["en"],
  nsfw: false,
  capabilities: [],
};

describe("bridgeInfoSchema iconUrl", () => {
  test("accepts an absolute URL", () => {
    const info = bridgeInfoSchema.parse({ ...BASE, iconUrl: "https://example.com/favicon.ico" });
    expect(info.iconUrl).toBe("https://example.com/favicon.ico");
  });

  test("parses when omitted (backward-compatible with existing bridges)", () => {
    const info = bridgeInfoSchema.parse({ ...BASE });
    expect(info.iconUrl).toBeUndefined();
  });

  test("rejects a non-URL string", () => {
    expect(() => bridgeInfoSchema.parse({ ...BASE, iconUrl: "not-a-url" })).toThrow();
  });
});

describe("bridgeInfoSchema id scoping", () => {
  test("accepts a bare (unscoped) id — backward compatible", () => {
    expect(bridgeInfoSchema.parse({ ...BASE, id: "example" }).id).toBe("example");
  });

  test("accepts a publisher-scoped id (scope.name)", () => {
    expect(bridgeInfoSchema.parse({ ...BASE, id: "acme.example" }).id).toBe("acme.example");
  });

  test("accepts a multi-level scope (reverse-DNS)", () => {
    expect(bridgeInfoSchema.parse({ ...BASE, id: "com.acme.example" }).id).toBe("com.acme.example");
  });

  test("rejects url-unsafe separators and path traversal", () => {
    for (const bad of ["acme/example", "..", "acme..example", ".example", "example.", "Acme.Example"]) {
      expect(() => bridgeInfoSchema.parse({ ...BASE, id: bad })).toThrow();
    }
  });

  test("parseBridgeId splits scope from name", () => {
    expect(parseBridgeId("acme.example")).toEqual({ scope: "acme", name: "example" });
    expect(parseBridgeId("com.acme.example")).toEqual({ scope: "com.acme", name: "example" });
    expect(parseBridgeId("example")).toEqual({ name: "example" });
  });
});

describe("bridgeInfoSchema cardSubtitles", () => {
  test("accepts true (bridge whose entries carry a subtitle line)", () => {
    expect(bridgeInfoSchema.parse({ ...BASE, cardSubtitles: true }).cardSubtitles).toBe(true);
  });

  test("parses when omitted (backward-compatible; means no subtitles)", () => {
    expect(bridgeInfoSchema.parse({ ...BASE }).cardSubtitles).toBeUndefined();
  });

  test("rejects a non-boolean", () => {
    expect(() => bridgeInfoSchema.parse({ ...BASE, cardSubtitles: "yes" })).toThrow();
  });
});

describe("bridgeInfoSchema ratings", () => {
  test("accepts true (bridge whose source has community ratings)", () => {
    expect(bridgeInfoSchema.parse({ ...BASE, ratings: true }).ratings).toBe(true);
  });

  test("parses when omitted (backward-compatible; means no ratings)", () => {
    expect(bridgeInfoSchema.parse({ ...BASE }).ratings).toBeUndefined();
  });

  test("accepts an explicit false", () => {
    expect(bridgeInfoSchema.parse({ ...BASE, ratings: false }).ratings).toBe(false);
  });

  test("rejects a non-boolean", () => {
    expect(() => bridgeInfoSchema.parse({ ...BASE, ratings: "yes" })).toThrow();
  });
});

describe("bridgeInfoSchema assetProxy", () => {
  test("accepts declared hosts with a Referer", () => {
    const info = bridgeInfoSchema.parse({
      ...BASE,
      assetProxy: { hosts: ["cdn.example.net", "example.org"], referer: "https://example.org/" },
    });
    expect(info.assetProxy?.hosts).toEqual(["cdn.example.net", "example.org"]);
    expect(info.assetProxy?.referer).toBe("https://example.org/");
  });

  test("accepts hosts without a Referer", () => {
    const info = bridgeInfoSchema.parse({ ...BASE, assetProxy: { hosts: ["cdn.example.net"] } });
    expect(info.assetProxy?.referer).toBeUndefined();
  });

  test("parses when omitted (backward-compatible with bridges that proxy nothing)", () => {
    expect(bridgeInfoSchema.parse({ ...BASE }).assetProxy).toBeUndefined();
  });

  test("rejects an empty hosts list", () => {
    expect(() => bridgeInfoSchema.parse({ ...BASE, assetProxy: { hosts: [] } })).toThrow();
  });

  test("rejects a non-URL Referer", () => {
    expect(() =>
      bridgeInfoSchema.parse({ ...BASE, assetProxy: { hosts: ["x.example"], referer: "not-a-url" } }),
    ).toThrow();
  });
});

describe("bridgeInfoSchema assetRateLimit", () => {
  test("accepts a page-image budget alongside the request budget", () => {
    const info = bridgeInfoSchema.parse({
      ...BASE,
      rateLimit: { maxConcurrent: 1, minIntervalMs: 2000 },
      assetRateLimit: { maxConcurrent: 2, minIntervalMs: 500 },
    });
    expect(info.assetRateLimit).toEqual({ maxConcurrent: 2, minIntervalMs: 500 });
  });

  test("parses when omitted", () => {
    expect(bridgeInfoSchema.parse({ ...BASE }).assetRateLimit).toBeUndefined();
  });

  test("rejects a zero concurrency or a negative interval", () => {
    expect(() => bridgeInfoSchema.parse({ ...BASE, assetRateLimit: { maxConcurrent: 0 } })).toThrow();
    expect(() => bridgeInfoSchema.parse({ ...BASE, assetRateLimit: { minIntervalMs: -1 } })).toThrow();
  });
});

describe("bridgeInfoSchema per-route and per-host budgets", () => {
  test("accepts per-route quotas on the request budget", () => {
    const info = bridgeInfoSchema.parse({
      ...BASE,
      rateLimit: {
        minIntervalMs: 700,
        routes: [
          { match: "/api/search", limit: 10, windowMs: 60_000 },
          { match: "/api/galleries/**", host: "api.example.net", limit: 20, windowMs: 60_000 },
        ],
      },
    });
    expect(info.rateLimit?.routes).toHaveLength(2);
    expect(info.rateLimit?.routes?.[1]?.host).toBe("api.example.net");
  });

  test("rejects a route with no match, a zero limit or a zero window", () => {
    const route = (r: Record<string, unknown>) => bridgeInfoSchema.safeParse({ ...BASE, rateLimit: { routes: [r] } }).success;
    expect(route({ match: "", limit: 1, windowMs: 1000 })).toBe(false);
    expect(route({ match: "/a", limit: 0, windowMs: 1000 })).toBe(false);
    expect(route({ match: "/a", limit: 1, windowMs: 0 })).toBe(false);
    expect(route({ match: "/a", limit: 1, windowMs: 1000 })).toBe(true);
  });

  test("accepts per-host asset groups, including an unlimited one", () => {
    const info = bridgeInfoSchema.parse({
      ...BASE,
      assetRateLimit: { maxConcurrent: 2, byHost: [{ hosts: ["tn.example.net"] }, { hosts: ["a.example.net", "b.example.net"], minIntervalMs: 300 }] },
    });
    expect(info.assetRateLimit?.byHost?.[0]).toEqual({ hosts: ["tn.example.net"] });
    expect(info.assetRateLimit?.byHost?.[1]?.minIntervalMs).toBe(300);
  });

  test("rejects an asset group naming no hosts", () => {
    expect(bridgeInfoSchema.safeParse({ ...BASE, assetRateLimit: { byHost: [{ hosts: [] }] } }).success).toBe(false);
  });
});
