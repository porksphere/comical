import { describe, expect, test } from "bun:test";
import type { HostCapabilities } from "@comical/contract";
import { bridgeImagePath } from "@comical/contract";
import { BridgeContractError, BridgeValidationError, loadBridge } from "../src/index.ts";

function mockHost(warnings: string[] = []): HostCapabilities {
  return {
    network: { request: async () => ({ url: "", status: 200, statusText: "OK", headers: {}, body: "" }) },
    storage: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      keys: async () => [],
      secure: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
    },
    log: { debug() {}, info() {}, warn: (m: string) => void warnings.push(m), error() {} },
    settings: {},
  };
}

const COMMENTS = { scopes: ["series"], sorts: [{ id: "new", label: "Newest" }, { id: "top", label: "Top" }], votes: "up-down" };

const info = (extra: Record<string, unknown> = {}, capabilities: string[] = ["comments"]) =>
  JSON.stringify({
    id: "cmt",
    name: "Cmt",
    version: "0.0.0",
    contractVersion: "2.2.0",
    languages: ["en"],
    nsfw: false,
    capabilities,
    comments: COMMENTS,
    ...extra,
  });

const bundle = (infoJson: string, body: string) =>
  `module.exports = { default: (host) => ({ info: ${infoJson}, getSeriesDetails: async (id) => ({ id, title: "T" }), ${body} }) };`;

// Echoes the request back in a comment, so a test can see exactly what reached the bridge.
const ECHO = `getComments: async (req) => ({ items: [{ id: "1", author: { name: "a" }, body: [{ type: "text", text: JSON.stringify(req) }] }] })`;

const echoed = (page: { items: Array<{ body: Array<{ type: string; text?: string }> }> }) =>
  JSON.parse(page.items[0]!.body[0]!.text!) as Record<string, unknown>;

describe("loader getComments", () => {
  test("passes a valid request through and validates the page", async () => {
    const b = await loadBridge({ code: bundle(info(), ECHO), capabilities: mockHost() });
    const page = await b.getComments!({ target: { seriesId: "s" }, sort: "top", cursor: "c2" });
    expect(echoed(page)).toEqual({ target: { seriesId: "s" }, sort: "top", cursor: "c2" });
  });

  test("rejects a scope the bridge doesn't declare, before calling it", async () => {
    const b = await loadBridge({ code: bundle(info(), ECHO), capabilities: mockHost() });
    const err = await b.getComments!({ target: { seriesId: "s", chapterId: "c" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeValidationError);
    expect((err as Error).message).toContain("rejected before calling the bridge");
    expect((err as Error).message).toContain("no chapter threads");
  });

  test("rejects a sort the bridge doesn't offer, and any sort when it offers none", async () => {
    const b = await loadBridge({ code: bundle(info(), ECHO), capabilities: mockHost() });
    await expect(b.getComments!({ target: { seriesId: "s" }, sort: "hot" })).rejects.toBeInstanceOf(BridgeValidationError);
    const unsorted = await loadBridge({
      code: bundle(info({ comments: { scopes: ["series"] } }), ECHO),
      capabilities: mockHost(),
    });
    await expect(unsorted.getComments!({ target: { seriesId: "s" }, sort: "new" })).rejects.toBeInstanceOf(BridgeValidationError);
    expect(echoed(await unsorted.getComments!({ target: { seriesId: "s" } }))).toEqual({ target: { seriesId: "s" } });
  });

  test("rejects a malformed request", async () => {
    const b = await loadBridge({ code: bundle(info(), ECHO), capabilities: mockHost() });
    await expect(b.getComments!({ target: { seriesId: "" } })).rejects.toBeInstanceOf(BridgeValidationError);
  });

  test("rejects a page that breaks the schema", async () => {
    const b = await loadBridge({
      code: bundle(info(), `getComments: async () => ({ items: [{ id: "", author: { name: "a" }, body: [] }] })`),
      capabilities: mockHost(),
    });
    await expect(b.getComments!({ target: { seriesId: "s" } })).rejects.toBeInstanceOf(BridgeValidationError);
  });

  test("routes avatars and inline images (in quotes and replies too) through the image route", async () => {
    const images = { hosts: ["cdn.test"], headers: { Referer: "https://site.test/" } };
    const b = await loadBridge({
      code: bundle(
        info({ images }),
        `getComments: async () => ({ items: [{
          id: "1",
          author: { name: "a", avatar: "https://cdn.test/a.png" },
          body: [
            { type: "image", url: "https://cdn.test/1.gif" },
            { type: "quote", children: [{ type: "image", url: "https://cdn.test/2.png" }] },
            { type: "image", url: "https://elsewhere.test/3.png" },
          ],
          replies: [{ id: "2", author: { name: "b", avatar: "https://cdn.test/b.png" }, body: [] }],
        }] })`,
      ),
      capabilities: mockHost(),
    });
    const [c] = (await b.getComments!({ target: { seriesId: "s" } })).items;
    expect(c!.author.avatar).toBe(bridgeImagePath("cmt", "https://cdn.test/a.png"));
    expect(c!.body[0]).toEqual({ type: "image", url: bridgeImagePath("cmt", "https://cdn.test/1.gif") });
    expect(c!.body[1]).toEqual({ type: "quote", children: [{ type: "image", url: bridgeImagePath("cmt", "https://cdn.test/2.png") }] });
    // Off the declared hosts: left for the client to load directly.
    expect(c!.body[2]).toEqual({ type: "image", url: "https://elsewhere.test/3.png" });
    expect(c!.replies![0]!.author.avatar).toBe(bridgeImagePath("cmt", "https://cdn.test/b.png"));
  });
});

describe("loader comments declaration", () => {
  test("refuses capability comments without info.comments", async () => {
    const err = await loadBridge({ code: bundle(info({ comments: undefined }), ECHO), capabilities: mockHost() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeContractError);
    expect((err as Error).message).toContain("no info.comments");
  });

  test("refuses info.comments without capability comments", async () => {
    const err = await loadBridge({ code: bundle(info({}, []), ECHO), capabilities: mockHost() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeContractError);
    expect((err as Error).message).toContain("without capability");
  });

  test("refuses capability comments without getComments", async () => {
    const err = await loadBridge({ code: bundle(info(), ""), capabilities: mockHost() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeContractError);
    expect((err as Error).message).toContain("no getComments");
  });

  test("a bridge without the capability exposes no getComments, even if it has the method", async () => {
    const b = await loadBridge({ code: bundle(info({ comments: undefined }, []), ECHO), capabilities: mockHost() });
    expect(b.getComments).toBeUndefined();
  });
});

describe("loader unknown capabilities", () => {
  test("loads the bridge without them and logs which were dropped", async () => {
    const warnings: string[] = [];
    const b = await loadBridge({
      code: bundle(info({ comments: undefined }, ["search", "from-the-future"]), ""),
      capabilities: mockHost(warnings),
    });
    expect(b.info.capabilities).toEqual(["search"]);
    expect(warnings.some((w) => w.includes("from-the-future"))).toBe(true);
  });
});
