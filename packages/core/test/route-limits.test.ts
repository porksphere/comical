/**
 * Per-route quotas (`info.rateLimit.routes`): a request on a budgeted route waits for that route's
 * sliding window on top of the bridge-wide pacing, and a "slow down" earned there holds only that
 * route — unrelated endpoints keep going. Also the URL matching the budgets rest on.
 */
import { describe, expect, test } from "bun:test";
import { parseRateLimited, type HttpRequest, type HttpResponse } from "@comical/contract";
import { createGatedNetwork } from "../src/net/gated-network.ts";
import { compilePathGlob, hostOf, pathOf } from "../src/net/url-match.ts";
import { WindowLimiter } from "../src/net/window-limiter.ts";

type Reply = Partial<HttpResponse> & { status: number };

function scripted(reply: (req: HttpRequest, n: number) => Reply) {
  const seen: Array<{ url: string; at: number }> = [];
  const raw = {
    request: async (req: HttpRequest): Promise<HttpResponse> => {
      seen.push({ url: req.url, at: Date.now() });
      return { url: req.url, statusText: "", headers: {}, body: "", ...reply(req, seen.length) };
    },
  };
  return { raw, seen };
}

const fast = { rateLimit: { minIntervalMs: 0, maxConcurrent: 10 }, throttle: { maxInlineWaitMs: 300, backoffStartMs: 50, backoffMaxMs: 120 } };
const ok = (): Reply => ({ status: 200, body: "{}" });

describe("url matching", () => {
  test("hostOf / pathOf read an absolute URL without throwing on odd ones", () => {
    expect(hostOf("https://API.example.net:8443/x/y?q=1#f")).toBe("api.example.net");
    expect(hostOf("https://user:pw@h.test/")).toBe("h.test");
    expect(hostOf("/relative")).toBeUndefined();
    expect(pathOf("https://h.test")).toBe("/");
    expect(pathOf("https://h.test/a/b?c=d#e")).toBe("/a/b");
  });

  test("a path glob matches whole: * one segment, ** the rest, trailing slash tolerated", () => {
    const one = compilePathGlob("/api/galleries/*");
    expect(one.test("/api/galleries/123")).toBe(true);
    expect(one.test("/api/galleries/123/")).toBe(true);
    expect(one.test("/api/galleries/123/related")).toBe(false);
    expect(one.test("/api/galleries")).toBe(false);
    const rest = compilePathGlob("/api/galleries/**");
    expect(rest.test("/api/galleries/123/related")).toBe(true);
    expect(compilePathGlob("/api/search").test("/api/search.json")).toBe(false);
    expect(compilePathGlob("/v1.0/a").test("/v1x0/a")).toBe(false);
  });
});

describe("WindowLimiter", () => {
  test("admits `limit` starts at once, then holds until the oldest ages out", async () => {
    const w = new WindowLimiter({ limit: 2, windowMs: 100 });
    const t0 = Date.now();
    await w.acquire();
    await w.acquire();
    expect(Date.now() - t0).toBeLessThan(50);
    expect(w.nextStartAt() - Date.now()).toBeGreaterThan(50);
    await w.acquire();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(95);
  });

  test("a pause holds starts and reconfigure takes effect on the next drain", async () => {
    const w = new WindowLimiter({ limit: 1, windowMs: 10_000 });
    await w.acquire();
    w.reconfigure({ limit: 5, windowMs: 10_000 });
    const t0 = Date.now();
    w.pauseUntil(t0 + 60);
    await w.acquire();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
  });
});

describe("gated network route limits", () => {
  test("a budgeted route is held at its quota while an unbudgeted one flows", async () => {
    const { raw, seen } = scripted(ok);
    const { network, setRouteLimits } = createGatedNetwork(raw, fast);
    setRouteLimits([{ match: "/api/search", limit: 2, windowMs: 150 }]);
    const t0 = Date.now();
    await Promise.all([
      network.request({ url: "https://h.test/api/search?q=a" }),
      network.request({ url: "https://h.test/api/search?q=b" }),
      network.request({ url: "https://h.test/api/galleries?page=1" }),
    ]);
    expect(Date.now() - t0).toBeLessThan(80);
    await network.request({ url: "https://h.test/api/search?q=c" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    const paths = seen.map((s) => s.url.split("?")[0]);
    expect(paths.slice(0, 3).sort()).toEqual(["https://h.test/api/galleries", "https://h.test/api/search", "https://h.test/api/search"]);
    expect(paths[3]).toBe("https://h.test/api/search");
  });

  test("a route's host narrows it; first matching route wins", async () => {
    const { raw } = scripted(ok);
    const { network, setRouteLimits } = createGatedNetwork(raw, fast);
    setRouteLimits([
      { match: "/x/**", host: "other.test", limit: 1, windowMs: 60_000 },
      { match: "/x/*", limit: 1, windowMs: 100 },
      { match: "/x/**", limit: 50, windowMs: 100 },
    ]);
    const t0 = Date.now();
    await network.request({ url: "https://h.test/x/1" });
    await network.request({ url: "https://h.test/x/1/deep" });
    await network.request({ url: "https://h.test/x/1/deep" });
    expect(Date.now() - t0).toBeLessThan(60);
    await network.request({ url: "https://h.test/x/2" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(95);
  });

  test("a 429 on a budgeted route pauses that route alone", async () => {
    const { raw, seen } = scripted((req, n) =>
      req.url.includes("/api/search") && n === 1 ? { status: 429, headers: { "Retry-After": "600" } } : ok(),
    );
    const { network, setRouteLimits, blockedUntil } = createGatedNetwork(raw, fast);
    setRouteLimits([{ match: "/api/search", limit: 10, windowMs: 60_000 }]);
    const err = (await network.request({ url: "https://h.test/api/search?q=a" }).catch((e: unknown) => e)) as Error;
    expect(parseRateLimited(err.message)?.retryAfterMs).toBeGreaterThan(590_000);
    expect(err.message).toContain("HTTP 429 from h.test");
    expect(blockedUntil()).toBeLessThanOrEqual(Date.now());

    expect((await network.request({ url: "https://h.test/api/galleries" })).status).toBe(200);
    const again = (await network.request({ url: "https://h.test/api/search?q=b" }).catch((e: unknown) => e)) as Error;
    expect(parseRateLimited(again.message)).not.toBeNull();
    expect(seen.filter((s) => s.url.includes("/api/search"))).toHaveLength(1);
  });

  test("a short route pause is sat out and retried", async () => {
    const { raw, seen } = scripted((req, n) => (n === 1 ? { status: 429, headers: { "Retry-After": "0" } } : ok()));
    const { network, setRouteLimits } = createGatedNetwork(raw, fast);
    setRouteLimits([{ match: "/api/search", limit: 10, windowMs: 60_000 }]);
    expect((await network.request({ url: "https://h.test/api/search" })).status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  test("a bridge-wide pause still holds budgeted routes", async () => {
    const { raw } = scripted((_req, n) => (n === 1 ? { status: 429, headers: { "Retry-After": "600" } } : ok()));
    const { network, setRouteLimits } = createGatedNetwork(raw, fast);
    setRouteLimits([{ match: "/api/search", limit: 10, windowMs: 60_000 }]);
    await network.request({ url: "https://h.test/api/galleries" }).catch(() => {});
    const err = (await network.request({ url: "https://h.test/api/search" }).catch((e: unknown) => e)) as Error;
    expect(parseRateLimited(err.message)).not.toBeNull();
  });

  test("re-declaring the same routes keeps their windows; a changed route starts fresh", async () => {
    const { raw } = scripted(ok);
    const { network, setRouteLimits } = createGatedNetwork(raw, fast);
    setRouteLimits([{ match: "/a", limit: 1, windowMs: 100 }]);
    await network.request({ url: "https://h.test/a" });
    setRouteLimits([{ match: "/a", limit: 1, windowMs: 100 }]);
    const t0 = Date.now();
    await network.request({ url: "https://h.test/a" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80);
    setRouteLimits([{ match: "/a", host: "h.test", limit: 1, windowMs: 100 }]);
    const t1 = Date.now();
    await network.request({ url: "https://h.test/a" });
    expect(Date.now() - t1).toBeLessThan(50);
  });
});
