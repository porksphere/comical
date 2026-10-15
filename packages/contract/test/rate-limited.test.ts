/**
 * The rate-limited signal: a marker a bridge embeds in a thrown message so hosts can recover the
 * wait after the sandbox has flattened the error to a string, plus `Retry-After` parsing.
 */
import { describe, expect, test } from "bun:test";
import { parseRateLimited, rateLimitedMessage, retryAfterMs } from "../src/rate-limited.ts";

describe("rateLimitedMessage / parseRateLimited", () => {
  test("round-trips the wait, even wrapped in a runtime error message", () => {
    const msg = `resolvePage threw: ${rateLimitedMessage(3_600_000, "quota exceeded")}`;
    expect(parseRateLimited(msg)).toEqual({ retryAfterMs: 3_600_000 });
    expect(msg).toContain("quota exceeded");
  });

  test("clamps a negative or non-finite wait to 0 and rounds fractions", () => {
    expect(parseRateLimited(rateLimitedMessage(-5))).toEqual({ retryAfterMs: 0 });
    expect(parseRateLimited(rateLimitedMessage(Number.NaN))).toEqual({ retryAfterMs: 0 });
    expect(parseRateLimited(rateLimitedMessage(1500.6))).toEqual({ retryAfterMs: 1501 });
  });

  test("returns null for an ordinary error message", () => {
    expect(parseRateLimited("getChapterPages threw: HTTP 500")).toBeNull();
  });
});

describe("retryAfterMs", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");

  test("reads delta-seconds, case-insensitively", () => {
    expect(retryAfterMs({ "retry-after": "30" }, now)).toBe(30_000);
    expect(retryAfterMs({ "Retry-After": " 2 " }, now)).toBe(2_000);
  });

  test("reads an HTTP-date as the time until it", () => {
    expect(retryAfterMs({ "Retry-After": "Thu, 15 Oct 2026 12:01:00 GMT" }, now)).toBe(60_000);
    expect(retryAfterMs({ "Retry-After": "Thu, 15 Oct 2026 11:00:00 GMT" }, now)).toBe(0);
  });

  test("reads X-RateLimit-Retry-After as a UNIX timestamp in seconds", () => {
    expect(retryAfterMs({ "X-RateLimit-Retry-After": String(now / 1000 + 45) }, now)).toBe(45_000);
  });

  test("prefers Retry-After over the timestamp header", () => {
    expect(retryAfterMs({ "Retry-After": "5", "X-RateLimit-Retry-After": String(now / 1000 + 45) }, now)).toBe(5_000);
  });

  test("is undefined without a usable header", () => {
    expect(retryAfterMs(undefined, now)).toBeUndefined();
    expect(retryAfterMs({}, now)).toBeUndefined();
    expect(retryAfterMs({ "Retry-After": "soon" }, now)).toBeUndefined();
  });
});
