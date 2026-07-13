/**
 * Failure classification: a transient/blocked network throw (Cloudflare/403/timeout/…) is a `warn`,
 * a real bridge-logic throw stays `fail`. Lets a nightly live audit not go red on a flaky/blocked site.
 */
import { describe, expect, test } from "bun:test";
import type { Bridge, BridgeInfo } from "@comical/contract";
import { evaluateBridge, isTransientError } from "../src/conformance.ts";

const INFO = (caps: BridgeInfo["capabilities"]): BridgeInfo => ({
  id: "t",
  name: "T",
  version: "0.0.0",
  contractVersion: "1.0.0",
  languages: ["en"],
  nsfw: false,
  capabilities: caps,
});

describe("isTransientError", () => {
  test.each([
    "HTTP 403 Forbidden",
    "Request failed with status 429",
    "503 Service Unavailable",
    "Just a moment... (cloudflare challenge)",
    "fetch failed",
    "ETIMEDOUT",
    "network request failed",
    "getaddrinfo ENOTFOUND example.test",
  ])("transient: %s", (m) => expect(isTransientError(new Error(m))).toBe(true));

  test.each([
    "boom",
    "Cannot read properties of undefined (reading 'id')",
    "unexpected token < in JSON at position 0",
    "assertion failed: id mismatch",
  ])("real: %s", (m) => expect(isTransientError(new Error(m))).toBe(false));
});

describe("evaluateBridge downgrades transient throws to warn", () => {
  const throwingSearch = (err: string): Bridge =>
    ({
      info: INFO(["search"]),
      getSearchResults: async () => {
        throw new Error(err);
      },
      getSeriesDetails: async (id: string) => ({ id, title: "A", status: "completed" }),
      getChapters: async () => [],
      getChapterPages: async () => [],
    }) as unknown as Bridge;

  test("Cloudflare/403 throw → search.threw is warn, verdict stays pass", async () => {
    const r = await evaluateBridge(throwingSearch("HTTP 403 Forbidden (cloudflare)"));
    expect(r.results.find((x) => x.id === "search.threw")?.severity).toBe("warn");
    expect(r.summary.verdict).toBe("pass");
  });

  test("a real (logic) throw → search.threw is fail, verdict fail", async () => {
    const r = await evaluateBridge(throwingSearch("Cannot read properties of undefined"));
    expect(r.results.find((x) => x.id === "search.threw")?.severity).toBe("fail");
    expect(r.summary.verdict).toBe("fail");
  });
});
