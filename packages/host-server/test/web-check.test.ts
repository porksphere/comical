/**
 * Web checks through the router: a bridge call that met a site's anti-bot check answers 403 with
 * the challenge; `POST /bridges/:id/cookies` imports what the person earned; routed images carry
 * the session (and a challenged image answers like a bridge call).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bridgeImagePath, challengeMessage } from "@comical/contract";
import type { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";

let cdn: ReturnType<typeof Bun.serve>;
let seen: { path: string; cookie: string | null; ua: string | null }[] = [];
beforeAll(() => {
  cdn = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, cookie: req.headers.get("cookie"), ua: req.headers.get("user-agent") });
      if (url.pathname.startsWith("/guarded") && !req.headers.get("cookie")?.includes("cf_clearance=ok")) {
        return new Response("<title>Just a moment...</title>", { status: 403, headers: { "cf-mitigated": "challenge" } });
      }
      return new Response("png", { headers: { "Content-Type": "image/png" } });
    },
  });
});
afterAll(() => cdn.stop(true));

function serve(opts: { peek?: boolean } = {}) {
  const imported: unknown[] = [];
  const cleared: (string | undefined)[] = [];
  let session: { cookie?: string; userAgent?: string } = {};
  const bridge = {
    getSeriesDetails: async () => {
      throw new Error(`getSeriesDetails threw: ${challengeMessage({ url: "https://s.test/series/1", userAgent: "UA/1" })}`);
    },
    importCookies: async (url: string, cookies: unknown[], userAgent?: string, values?: Record<string, string>) => {
      imported.push(values ? { url, cookies, userAgent, values } : { url, cookies, userAgent });
      session = { cookie: "cf_clearance=ok", userAgent: userAgent ?? "" };
    },
    clearCookies: async (url?: string) => void cleared.push(url),
    sessionCookies: async () => session,
  };
  const info = {
    id: "wc", name: "WC", version: "1.0.0", contractVersion: "2.1.0", languages: ["en"], nsfw: false, capabilities: [],
    images: { hosts: ["127.0.0.1"], headers: { Referer: "https://s.test/" } },
  };
  let loaded = false;
  const mgr = {
    list: async () => [{ info, settings: [], configured: true, missingRequired: [], source: "registry" as const }],
    get: async (id: string) => {
      if (id !== "wc") throw new Error(`not found: ${id}`);
      loaded = true;
      return bridge;
    },
    peek: (id: string) => (opts.peek !== false && loaded && id === "wc" ? bridge : undefined),
    missingRequired: async () => [],
    storedSettings: async () => ({}),
  } as unknown as BridgeManager;
  const srv = Bun.serve({ port: 0, fetch: createRouter(mgr).fetch });
  const base = `http://localhost:${srv.port}`;
  return { base, imported, cleared, stop: () => srv.stop(true) };
}

describe("web checks", () => {
  test("a challenged bridge call answers 403 with where to check and with which User-Agent", async () => {
    const s = serve();
    try {
      const res = await fetch(`${s.base}/bridges/wc/series/1`);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { challenge: unknown };
      expect(body.challenge).toEqual({ url: "https://s.test/series/1", userAgent: "UA/1", reason: "the site wants to check this is a person" });
    } finally {
      s.stop();
    }
  });

  test("cookies are imported, and checked first", async () => {
    const s = serve();
    try {
      const ok = await fetch(`${s.base}/bridges/wc/cookies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://s.test/", userAgent: "UA/1", cookies: [{ name: "cf_clearance", value: "ok", domain: ".s.test", expires: Date.now() + 1000 }] }),
      });
      expect(ok.status).toBe(200);
      expect(s.imported).toEqual([{ url: "https://s.test/", userAgent: "UA/1", cookies: [{ name: "cf_clearance", value: "ok", domain: ".s.test", expires: expect.any(Number) }] }]);

      const withValues = await fetch(`${s.base}/bridges/wc/cookies`, {
        method: "POST",
        body: JSON.stringify({ url: "https://s.test/", cookies: [], values: { clearance: "tok" } }),
      });
      expect(withValues.status).toBe(200);
      expect(s.imported.at(-1)).toEqual({ url: "https://s.test/", cookies: [], userAgent: undefined, values: { clearance: "tok" } });
      const badValues = await fetch(`${s.base}/bridges/wc/cookies`, { method: "POST", body: JSON.stringify({ url: "https://s.test/", cookies: [], values: { clearance: 1 } }) });
      expect(badValues.status).toBe(400);
      expect(((await badValues.json()) as { issues: string[] }).issues).toEqual(["values.clearance must be a string"]);
      expect((await fetch(`${s.base}/bridges/wc/cookies`, { method: "POST", body: JSON.stringify({ url: "https://s.test/", cookies: [], values: ["x"] }) })).status).toBe(400);

      const bad = await fetch(`${s.base}/bridges/wc/cookies`, { method: "POST", body: JSON.stringify({ url: "ftp://x", cookies: [{ name: "" }] }) });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { issues: string[] }).issues).toEqual(["url must be an http(s) URL", "cookies[0] needs a name and a value"]);

      const unknown = await fetch(`${s.base}/bridges/nope/cookies`, { method: "POST", body: JSON.stringify({ url: "https://s.test/", cookies: [] }) });
      expect(unknown.status).toBe(404);

      expect((await fetch(`${s.base}/bridges/wc/cookies?url=https://s.test/`, { method: "DELETE" })).status).toBe(200);
      expect((await fetch(`${s.base}/bridges/wc/cookies`, { method: "DELETE" })).status).toBe(200);
      expect(s.cleared).toEqual(["https://s.test/", undefined]);
    } finally {
      s.stop();
    }
  });

  test("routed images carry the session once the bridge is loaded; a challenged image answers 403 with the challenge", async () => {
    const s = serve();
    seen = [];
    try {
      const image = (p: string) => fetch(`${s.base}${bridgeImagePath("wc", `http://127.0.0.1:${cdn.port}${p}`)}`, { redirect: "manual" });
      const blocked = await image("/guarded/1.png");
      expect(blocked.status).toBe(403);
      expect(((await blocked.json()) as { challenge: { url: string } }).challenge.url).toBe(`http://127.0.0.1:${cdn.port}/guarded/1.png`);
      // The person passes the check; the import loads the bridge, so its session now rides along.
      await fetch(`${s.base}/bridges/wc/cookies`, { method: "POST", body: JSON.stringify({ url: "https://s.test/", userAgent: "UA/1", cookies: [{ name: "cf_clearance", value: "ok" }] }) });
      const ok = await image("/guarded/2.png");
      expect(ok.status).toBe(200);
      expect(seen.at(-1)).toEqual({ path: "/guarded/2.png", cookie: "cf_clearance=ok", ua: "UA/1" });
    } finally {
      s.stop();
    }
  });
});
