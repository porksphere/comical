/**
 * The gated network honors a source's "slow down": a 429 (or a 503 that names a Retry-After) pauses
 * every request sharing the bridge's limiter, a short wait is sat out and retried once, a long one is
 * handed back and fails later requests fast, and a bridge call failing during a throttle surfaces
 * as rate-limited so hosts back off.
 */
import { describe, expect, test } from "bun:test";
import { parseRateLimited, type HostCapabilities, type HttpRequest, type HttpResponse } from "@comical/contract";
import { BridgeRuntimeError, loadBridge } from "../src/index.ts";
import { createGatedNetwork } from "../src/net/gated-network.ts";
import { RateLimiter } from "../src/net/rate-limiter.ts";

type Reply = Partial<HttpResponse> & { status: number };

/** A raw network answering from a script of replies (the last one repeats). */
function scripted(replies: Reply[]) {
  const seen: Array<{ url: string; at: number }> = [];
  const raw = {
    request: async (req: HttpRequest): Promise<HttpResponse> => {
      seen.push({ url: req.url, at: Date.now() });
      const r = replies[Math.min(seen.length - 1, replies.length - 1)]!;
      return { url: req.url, statusText: "", headers: {}, body: "", ...r };
    },
  };
  return { raw, seen };
}

const fast = { rateLimit: { minIntervalMs: 0 }, throttle: { maxInlineWaitMs: 200, backoffStartMs: 50, backoffMaxMs: 120 } };

describe("RateLimiter.pauseUntil", () => {
  test("holds starts until the pause ends, and never shortens one in force", async () => {
    const limiter = new RateLimiter({ maxConcurrent: 5, minIntervalMs: 0 });
    const t0 = Date.now();
    limiter.pauseUntil(t0 + 80);
    limiter.pauseUntil(t0 + 10);
    expect(limiter.pausedUntilMs).toBe(t0 + 80);
    const release = await limiter.acquire();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(75);
    release();
  });
});

describe("gated network throttling", () => {
  test("sits out a short Retry-After and retries once", async () => {
    const { raw, seen } = scripted([{ status: 429, headers: { "Retry-After": "0" } }, { status: 200, body: "ok" }]);
    const { network } = createGatedNetwork(raw, fast);
    const res = await network.request({ url: "https://x.test/a" });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  test("backs off exponentially when the 429 names no wait, then resets on success", async () => {
    const { raw, seen } = scripted([{ status: 429 }, { status: 200 }]);
    const { network, blockedUntil } = createGatedNetwork(raw, fast);
    const t0 = Date.now();
    expect((await network.request({ url: "https://x.test/a" })).status).toBe(200);
    expect(seen[1]!.at - t0).toBeGreaterThanOrEqual(45);
    expect(blockedUntil()).toBeLessThanOrEqual(Date.now());
  });

  test("retries only once — a second 429 goes back to the bridge", async () => {
    const { raw, seen } = scripted([{ status: 429, headers: { "retry-after": "0" } }]);
    const { network } = createGatedNetwork(raw, fast);
    expect((await network.request({ url: "https://x.test/a" })).status).toBe(429);
    expect(seen).toHaveLength(2);
  });

  test("hands a long wait straight back and fails later requests fast without sending them", async () => {
    const { raw, seen } = scripted([{ status: 429, headers: { "Retry-After": "600" } }, { status: 200 }]);
    const { network, blockedUntil } = createGatedNetwork(raw, fast);
    const first = await network.request({ url: "https://x.test/a" });
    expect(first.status).toBe(429);
    expect(blockedUntil() - Date.now()).toBeGreaterThan(590_000);

    const second = await network.request({ url: "https://x.test/b" });
    expect(second.status).toBe(429);
    expect(Number(second.headers["retry-after"])).toBeGreaterThan(590);
    expect(seen).toHaveLength(1);
  });

  test("honors X-RateLimit-Retry-After as a UNIX timestamp", async () => {
    const at = Math.ceil(Date.now() / 1000) + 3600;
    const { raw } = scripted([{ status: 429, headers: { "X-RateLimit-Retry-After": String(at) } }]);
    const { network, blockedUntil } = createGatedNetwork(raw, fast);
    await network.request({ url: "https://x.test/a" });
    expect(blockedUntil()).toBe(at * 1000);
  });

  test("a 503 is a throttle only when it names a wait", async () => {
    const plain = scripted([{ status: 503 }, { status: 200 }]);
    const a = createGatedNetwork(plain.raw, fast);
    expect((await a.network.request({ url: "https://x.test/a" })).status).toBe(503);
    expect(plain.seen).toHaveLength(1);

    const named = scripted([{ status: 503, headers: { "Retry-After": "0" } }, { status: 200 }]);
    const b = createGatedNetwork(named.raw, fast);
    expect((await b.network.request({ url: "https://x.test/a" })).status).toBe(200);
    expect(named.seen).toHaveLength(2);
  });

  test("the backoff caps at its maximum", async () => {
    const { raw } = scripted([{ status: 429 }]);
    const { network, blockedUntil } = createGatedNetwork(raw, { ...fast, throttle: { ...fast.throttle, maxInlineWaitMs: 0 } });
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, Math.max(0, blockedUntil() - Date.now())));
      await network.request({ url: "https://x.test/a" });
    }
    expect(blockedUntil() - Date.now()).toBeLessThanOrEqual(120);
  });

});

describe("a bridge call during a throttle", () => {
  const host = (reply: () => Partial<HttpResponse> & { status: number }): HostCapabilities => ({
    network: { request: async (req) => ({ url: req.url, statusText: "", headers: {}, body: "", ...reply() }) },
    storage: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      keys: async () => [],
      secure: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    settings: {},
  });
  const code = (body: string) =>
    `module.exports = { default: (host) => ({
      info: { id: "t", name: "T", version: "0.0.0", contractVersion: "2.0.0", languages: ["en"], nsfw: false, capabilities: [] },
      getSeriesDetails: async (id) => { ${body} },
      getChapters: async () => [],
      getChapterPages: async () => [],
    }) };`;

  test("surfaces as rate-limited with the remaining wait", async () => {
    const b = await loadBridge({
      code: code(`const r = await host.network.request({ url: "https://x.test/" + id }); throw new Error("HTTP " + r.status);`),
      capabilities: host(() => ({ status: 429, headers: { "Retry-After": "120" } })),
    });
    const err = await b.getSeriesDetails("s").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeRuntimeError);
    const parsed = parseRateLimited((err as Error).message);
    expect(parsed?.retryAfterMs).toBeGreaterThan(110_000);
    expect((err as Error).message).toContain("HTTP 429");
  });

  test("keeps the wait a bridge tagged itself", async () => {
    const b = await loadBridge({
      code: code(`throw new Error("[rate-limited:3600000] image quota exceeded");`),
      capabilities: host(() => ({ status: 200 })),
    });
    const err = await b.getSeriesDetails("s").catch((e: unknown) => e);
    expect(parseRateLimited((err as Error).message)).toEqual({ retryAfterMs: 3_600_000 });
  });

  test("an ordinary failure stays untagged", async () => {
    const b = await loadBridge({
      code: code(`const r = await host.network.request({ url: "https://x.test/" }); throw new Error("HTTP " + r.status);`),
      capabilities: host(() => ({ status: 500 })),
    });
    const err = await b.getSeriesDetails("s").catch((e: unknown) => e);
    expect(parseRateLimited((err as Error).message)).toBeNull();
  });
});
