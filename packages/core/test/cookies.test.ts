/** The gated network's cookie jar: a Set-Cookie response is replayed on same-host requests. */
import { describe, expect, test } from "bun:test";
import type { HttpRequest, HttpResponse } from "@comical/contract";
import { createGatedNetwork } from "../src/net/gated-network.ts";

function recorder(setOn?: (req: HttpRequest) => string[] | undefined) {
  const seen: HttpRequest[] = [];
  const raw = {
    request: async (req: HttpRequest): Promise<HttpResponse> => {
      seen.push(req);
      const res: HttpResponse = { url: req.url, status: 200, statusText: "OK", headers: {}, body: "" };
      const sc = setOn?.(req);
      if (sc) res.setCookies = sc;
      return res;
    },
  };
  return { raw, seen };
}

const cookieOf = (req: HttpRequest | undefined): string | undefined =>
  Object.entries(req?.headers ?? {}).find(([k]) => k.toLowerCase() === "cookie")?.[1];

describe("gated network cookie jar", () => {
  test("replays a Set-Cookie session on same-host requests only", async () => {
    const { raw, seen } = recorder((req) =>
      req.url.endsWith("/login") ? ["sid=abc; Path=/; HttpOnly"] : undefined,
    );
    const { network } = createGatedNetwork(raw, { rateLimit: { minIntervalMs: 0 } });

    await network.request({ url: "https://x.test/login", method: "POST" });
    await network.request({ url: "https://x.test/me" });
    await network.request({ url: "https://other.test/me" });

    expect(cookieOf(seen[0])).toBeUndefined(); // login: no cookie yet
    expect(cookieOf(seen[1])).toBe("sid=abc"); // same host: session replayed
    expect(cookieOf(seen[2])).toBeUndefined(); // different host: not sent
  });

  test("does not override a Cookie header the bridge set itself", async () => {
    const { raw, seen } = recorder((req) => (req.url.endsWith("/login") ? ["sid=abc"] : undefined));
    const { network } = createGatedNetwork(raw, { rateLimit: { minIntervalMs: 0 } });

    await network.request({ url: "https://x.test/login" });
    await network.request({ url: "https://x.test/me", headers: { Cookie: "manual=1" } });

    expect(cookieOf(seen[1])).toBe("manual=1");
  });
});
