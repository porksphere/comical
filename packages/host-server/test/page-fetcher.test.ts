/**
 * The server page fetcher turns a source's "slow down" — a 429 upstream, or the router relaying a
 * bridge's rate-limited error — into a `PageRateLimitedError`, so the engine holds the bridge instead
 * of failing the page; any other failure stays a plain error.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PageRateLimitedError, rateLimitWaitOf } from "@comical/downloads";
import { createServerPageFetcher } from "../src/page-fetcher.ts";

const CTX = { bridgeId: "b", seriesId: "s", chapterId: "c" };
const page = (sourceUrl: string) => ({ index: 0, sourceUrl, file: "", bytes: 0, state: "pending" as const });

let upstream: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/limited") return new Response("slow down", { status: 429, headers: { "Retry-After": "90" } });
      if (path === "/gone") return new Response("no", { status: 404 });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } });
    },
  });
  base = `http://localhost:${upstream.port}`;
});

afterAll(() => upstream.stop(true));

const noRouter = () => () => new Response(null, { status: 503 });

describe("createServerPageFetcher rate limits", () => {
  test("a direct 429 becomes a rate-limited error carrying Retry-After", async () => {
    const err = await createServerPageFetcher(noRouter)(CTX, page(`${base}/limited`)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PageRateLimitedError);
    expect(rateLimitWaitOf(err)).toBe(90_000);
  });

  test("a direct 404 stays a plain failure", async () => {
    const err = await createServerPageFetcher(noRouter)(CTX, page(`${base}/gone`)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(rateLimitWaitOf(err)).toBeUndefined();
  });

  test("a routed 429 (a bridge's relayed rate limit) becomes a rate-limited error", async () => {
    const fetcher = createServerPageFetcher(() => () =>
      new Response(JSON.stringify({ error: "slow down" }), { status: 429, headers: { "Retry-After": "3600" } }),
    );
    const err = await fetcher(CTX, page("/bridges/b/page-image/x")).catch((e: unknown) => e);
    expect(rateLimitWaitOf(err)).toBe(3_600_000);
  });

  test("a page-image redirect to a limited CDN is caught on the followed fetch", async () => {
    const fetcher = createServerPageFetcher(() => () =>
      new Response(null, { status: 302, headers: { Location: `${base}/limited` } }),
    );
    const err = await fetcher(CTX, page("/bridges/b/page-image/x")).catch((e: unknown) => e);
    expect(rateLimitWaitOf(err)).toBe(90_000);
  });

  test("a healthy page still lands with its content type", async () => {
    const got = await createServerPageFetcher(noRouter)(CTX, page(`${base}/ok`));
    expect([...got.data]).toEqual([1, 2, 3]);
    expect(got.contentType).toBe("image/png");
  });
});
