/** The gated network's part in a web check: detecting a challenge, holding the host, the import that ends it, persistence. */
import { describe, expect, test } from "bun:test";
import { type HttpRequest, type HttpResponse, parseChallenge } from "@comical/contract";
import { createGatedNetwork } from "../src/net/gated-network.ts";

function site(challengeWhile: () => boolean) {
  const seen: HttpRequest[] = [];
  const raw = {
    request: async (req: HttpRequest): Promise<HttpResponse> => {
      seen.push(req);
      const challenged = challengeWhile();
      return {
        url: req.url,
        status: challenged ? 403 : 200,
        statusText: "",
        headers: challenged ? { "CF-Mitigated": "challenge", server: "cloudflare" } : {},
        body: challenged ? "<title>Just a moment...</title>" : "ok",
      };
    },
  };
  return { raw, seen };
}

const cookieOf = (req: HttpRequest | undefined) => Object.entries(req?.headers ?? {}).find(([k]) => k.toLowerCase() === "cookie")?.[1];

describe("challenges", () => {
  test("a challenge page throws the challenge with the URL and the request's User-Agent", async () => {
    const { raw } = site(() => true);
    const { network } = createGatedNetwork(raw, { rateLimit: { minIntervalMs: 0 } });
    const err = await network.request({ url: "https://s.test/list?page=2", headers: { "User-Agent": "UA/1" } }).catch((e: Error) => e);
    expect(parseChallenge((err as Error).message)).toMatchObject({ url: "https://s.test/list?page=2", userAgent: "UA/1" });
  });

  test("a non-GET request is checked on the site's root; with no User-Agent, the host's default", async () => {
    const { raw } = site(() => true);
    const { network } = createGatedNetwork(raw, { rateLimit: { minIntervalMs: 0 }, defaultUserAgent: "Host/2" });
    const err = await network.request({ url: "https://s.test/api/x", method: "POST", body: "{}" }).catch((e: Error) => e);
    expect(parseChallenge((err as Error).message)).toMatchObject({ url: "https://s.test/", userAgent: "Host/2" });
  });

  test("while a check waits, the host's requests fail fast; the import lets them through with the clearance", async () => {
    let challenged = true;
    const { raw, seen } = site(() => challenged);
    const { network, session } = createGatedNetwork(raw, { rateLimit: { minIntervalMs: 0 } });
    await network.request({ url: "https://www.s.test/a" }).catch(() => {});
    await expect(network.request({ url: "https://www.s.test/b" })).rejects.toThrow(/\[challenge:/);
    expect(seen).toHaveLength(1);
    // Another site isn't held.
    challenged = false;
    await network.request({ url: "https://other.test/" });
    await session.importCookies("https://www.s.test/a", [{ name: "cf_clearance", value: "ok", domain: ".s.test" }], "UA/1");
    const res = await network.request({ url: "https://www.s.test/b", headers: { Cookie: "own=1" } });
    expect(res.status).toBe(200);
    expect(cookieOf(seen.at(-1))).toBe("own=1; cf_clearance=ok");
    expect(await session.sessionCookies("https://img.s.test/p.jpg")).toEqual({ cookie: "cf_clearance=ok", userAgent: "UA/1" });
  });

  test("the hold runs out", async () => {
    const { raw, seen } = site(() => true);
    const { network } = createGatedNetwork(raw, { rateLimit: { minIntervalMs: 0 }, challengeHoldMs: 0 });
    await network.request({ url: "https://s.test/a" }).catch(() => {});
    await network.request({ url: "https://s.test/a" }).catch(() => {});
    expect(seen).toHaveLength(2);
  });

  test("the jar is restored before the first request and saved after a change", async () => {
    const saved: string[] = [];
    const store = { load: async () => JSON.stringify({ v: 1, cookies: [{ name: "keep", value: "1", domain: "s.test", hostOnly: true, path: "/", imported: true }], agents: {} }), save: async (v: string) => void saved.push(v) };
    const { raw, seen } = site(() => false);
    const { network, session } = createGatedNetwork(raw, { rateLimit: { minIntervalMs: 0 }, cookieStore: store });
    await network.request({ url: "https://s.test/" });
    expect(cookieOf(seen[0])).toBe("keep=1");
    await session.clearCookies("https://s.test/");
    await Promise.resolve();
    await Promise.resolve();
    expect(saved.length).toBeGreaterThan(0);
    expect(JSON.parse(saved.at(-1)!).cookies).toEqual([]);
  });
});
