/**
 * `GET /bridges/:id/series/:seriesId/comments` (capability "comments"): the source's own threads,
 * read through the loaded bridge so the core's request checks and output validation are in the path.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loginRequiredMessage, type HostCapabilities } from "@comical/contract";
import { loadBridge, type LoadedBridge } from "@comical/core";
import type { BridgeProvider } from "../src/bridge-provider.ts";
import { createRouter } from "../src/router.ts";

const host: HostCapabilities = {
  network: { request: async () => ({ url: "", status: 200, statusText: "OK", headers: {}, body: "" }) },
  storage: {
    get: async () => undefined,
    set: async () => {},
    delete: async () => {},
    keys: async () => [],
    secure: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
  },
  log: { debug() {}, info() {}, warn() {}, error() {} },
  settings: {},
};

const bundle = (id: string, extra: string) => `module.exports = { default: (host) => ({
  info: {
    id: "${id}", name: "${id}", version: "1.0.0", contractVersion: "2.2.0", languages: ["en"], nsfw: false,
    capabilities: ${extra ? `["comments"]` : "[]"},
    ${extra ? `comments: { scopes: ["series", "chapter"], sorts: [{ id: "new", label: "Newest" }, { id: "top", label: "Top" }] },` : ""}
  },
  getSeriesDetails: async (id) => ({ id, title: "T" }),
  ${extra}
}) };`;

// Answers with the request it got, so the route's query → request mapping is visible.
const ECHO = `getComments: async (req) => {
  if (req.target.seriesId === "locked") throw new Error(${JSON.stringify(loginRequiredMessage("cookies", "Sign in to read comments"))});
  if (req.target.seriesId === "broken") return { items: [{ id: "" }] };
  return {
    items: [{ id: "c1", author: { name: "a" }, body: [{ type: "text", text: JSON.stringify(req) }], votes: { up: 2 } }],
    total: 1,
    webUrl: "https://site.test/thread",
  };
}`;

let srv: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(async () => {
  const bridges: Record<string, LoadedBridge> = {
    cmt: await loadBridge({ code: bundle("cmt", ECHO), capabilities: host }),
    plain: await loadBridge({ code: bundle("plain", ""), capabilities: host }),
  };
  const manager: BridgeProvider = {
    list: async () => [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: async (id: string): Promise<any> => {
      const b = bridges[id];
      if (!b) throw new Error(`bridge not found: ${id}`);
      return b;
    },
    missingRequired: async () => [],
    storedSettings: async () => ({}),
    updateSettings: async () => ({}),
    invalidate: () => {},
    refresh: () => {},
  };
  srv = Bun.serve({ port: 0, fetch: createRouter(manager).fetch });
  base = `http://localhost:${srv.port}`;
});

afterAll(() => srv.stop(true));

const get = (path: string) => fetch(`${base}${path}`);
const echoed = async (res: Response) => {
  const body = (await res.json()) as { items: Array<{ body: Array<{ text: string }> }> };
  return JSON.parse(body.items[0]!.body[0]!.text) as Record<string, unknown>;
};

describe("comments route", () => {
  test("reads the series thread", async () => {
    const res = await get("/bridges/cmt/series/s1/comments");
    expect(res.status).toBe(200);
    const body = (await res.clone().json()) as { total: number; webUrl: string; items: Array<{ votes: unknown }> };
    expect(body.total).toBe(1);
    expect(body.webUrl).toBe("https://site.test/thread");
    expect(body.items[0]!.votes).toEqual({ up: 2 });
    expect(await echoed(res)).toEqual({ target: { seriesId: "s1" } });
  });

  test("maps chapterId, sort, parentId and cursor onto the request", async () => {
    const res = await get("/bridges/cmt/series/s1/comments?chapterId=ch2&sort=top&parentId=c9&cursor=p2");
    expect(res.status).toBe(200);
    expect(await echoed(res)).toEqual({ target: { seriesId: "s1", chapterId: "ch2" }, sort: "top", parentId: "c9", cursor: "p2" });
  });

  test("a sort the bridge doesn't offer is a 400", async () => {
    const res = await get("/bridges/cmt/series/s1/comments?sort=hot");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("not one of this bridge's comment sorts");
  });

  test("an over-long cursor is a 400", async () => {
    const res = await get(`/bridges/cmt/series/s1/comments?cursor=${"x".repeat(5000)}`);
    expect(res.status).toBe(400);
  });

  test("a thread that needs sign-in answers 401 naming the setting", async () => {
    const res = await get("/bridges/cmt/series/locked/comments");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { loginRequired: unknown }).loginRequired).toEqual({
      key: "cookies",
      reason: "Sign in to read comments",
    });
  });

  test("a page the bridge got wrong is a 500", async () => {
    expect((await get("/bridges/cmt/series/broken/comments")).status).toBe(500);
  });

  test("a bridge without comments answers not supported", async () => {
    const res = await get("/bridges/plain/series/s1/comments");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "not supported" });
  });

  test("an unknown bridge is a 404", async () => {
    expect((await get("/bridges/nope/series/s1/comments")).status).toBe(404);
  });
});
