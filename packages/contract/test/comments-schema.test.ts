import { describe, expect, test } from "bun:test";
import {
  COMMENT_LIMITS,
  bridgeCommentsSchema,
  bridgeInfoSchema,
  chapterSchema,
  commentNodeSchema,
  commentPageSchema,
  commentSchema,
  commentsRequestSchema,
  isBridgeCapability,
  seriesInfoSchema,
} from "../src/index.ts";

const comment = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  author: { name: "reader" },
  body: [{ type: "text", text: "hello" }],
  ...extra,
});

describe("comment bodies", () => {
  test("accept every inline node and a quote of inline nodes", () => {
    const body = [
      { type: "text", text: "bold", bold: true, spoiler: true },
      { type: "link", text: "site", url: "https://site.test" },
      { type: "mention", name: "someone" },
      { type: "image", url: "https://cdn.test/a.gif", animated: true, width: 200, height: 100 },
      { type: "break" },
      { type: "quote", author: "other", children: [{ type: "text", text: "quoted" }] },
    ];
    for (const node of body) expect(commentNodeSchema.safeParse(node).success).toBe(true);
    expect(commentSchema.safeParse(comment("1", { body })).success).toBe(true);
  });

  test("reject a quote inside a quote and unknown node types", () => {
    const nested = { type: "quote", children: [{ type: "quote", children: [] }] };
    expect(commentNodeSchema.safeParse(nested).success).toBe(false);
    expect(commentNodeSchema.safeParse({ type: "html", html: "<b>x</b>" }).success).toBe(false);
  });

  test("reject a body over the node limit", () => {
    const body = Array.from({ length: COMMENT_LIMITS.bodyNodes + 1 }, () => ({ type: "break" }));
    expect(commentSchema.safeParse(comment("1", { body })).success).toBe(false);
  });
});

describe("comments", () => {
  test("carry author, votes, reactions, flags and nested replies", () => {
    const parsed = commentSchema.parse(
      comment("1", {
        author: { name: "creator", avatar: "https://cdn.test/a.png", role: "creator", badges: ["VIP"] },
        createdAt: 1_700_000_000_000,
        edited: true,
        pinned: true,
        labels: ["Top"],
        votes: { up: 3, down: 1, mine: "up" },
        reactions: [{ id: "fire", count: 2 }],
        replyCount: 2,
        replies: [comment("2", { parentId: "1", replies: [comment("3", { parentId: "2", replyTo: { name: "x" } })] })],
      }),
    );
    expect(parsed.replies?.[0]?.replies?.[0]?.id).toBe("3");
  });

  test("reject an empty id, an empty author name and negative counts", () => {
    expect(commentSchema.safeParse(comment("")).success).toBe(false);
    expect(commentSchema.safeParse(comment("1", { author: { name: "" } })).success).toBe(false);
    expect(commentSchema.safeParse(comment("1", { votes: { up: -1 } })).success).toBe(false);
    expect(commentSchema.safeParse(comment("1", { replyCount: -1 })).success).toBe(false);
  });

  test("validate replies all the way down", () => {
    const bad = comment("1", { replies: [comment("2", { replies: [comment("")] })] });
    expect(commentSchema.safeParse(bad).success).toBe(false);
  });
});

describe("comment pages", () => {
  test("accept items, cursor, total, webUrl and closed", () => {
    const page = { items: [comment("1")], nextCursor: "p2", total: 40, webUrl: "https://site.test/t", closed: false };
    expect(commentPageSchema.safeParse(page).success).toBe(true);
    expect(commentPageSchema.safeParse({ items: [] }).success).toBe(true);
  });

  test("count embedded replies toward the page limit", () => {
    const replies = Array.from({ length: COMMENT_LIMITS.pageComments }, (_, i) => comment(`r${i}`));
    expect(commentPageSchema.safeParse({ items: [comment("1", { replies })] }).success).toBe(false);
    expect(commentPageSchema.safeParse({ items: [comment("1", { replies: replies.slice(1) })] }).success).toBe(true);
  });
});

describe("comments requests", () => {
  test("need a series id; chapter, sort, parent and cursor are optional", () => {
    expect(commentsRequestSchema.safeParse({ target: { seriesId: "s" } }).success).toBe(true);
    expect(
      commentsRequestSchema.safeParse({ target: { seriesId: "s", chapterId: "c" }, sort: "top", parentId: "1", cursor: "x" }).success,
    ).toBe(true);
    expect(commentsRequestSchema.safeParse({ target: { seriesId: "" } }).success).toBe(false);
    expect(commentsRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("BridgeInfo.comments", () => {
  test("needs at least one scope; sorts are bounded", () => {
    expect(bridgeCommentsSchema.safeParse({ scopes: ["series", "chapter"], votes: "up-down", maxDepth: 2 }).success).toBe(true);
    expect(bridgeCommentsSchema.safeParse({ scopes: [] }).success).toBe(false);
    expect(bridgeCommentsSchema.safeParse({ scopes: ["page"] }).success).toBe(false);
    const sorts = Array.from({ length: COMMENT_LIMITS.sorts + 1 }, (_, i) => ({ id: `s${i}`, label: `S${i}` }));
    expect(bridgeCommentsSchema.safeParse({ scopes: ["series"], sorts }).success).toBe(false);
    expect(bridgeCommentsSchema.safeParse({ scopes: ["series"], sorts: [] }).success).toBe(false);
  });
});

describe("comment counts", () => {
  test("are optional non-negative integers on chapters and series details", () => {
    expect(chapterSchema.safeParse({ id: "c", name: "C", commentCount: 12 }).success).toBe(true);
    expect(chapterSchema.safeParse({ id: "c", name: "C", commentCount: -1 }).success).toBe(false);
    expect(seriesInfoSchema.safeParse({ id: "s", title: "S", commentCount: 0 }).success).toBe(true);
    expect(seriesInfoSchema.safeParse({ id: "s", title: "S", commentCount: 1.5 }).success).toBe(false);
  });
});

describe("capabilities", () => {
  const info = (capabilities: unknown) => ({
    id: "b",
    name: "B",
    version: "1.0.0",
    contractVersion: "2.2.0",
    languages: ["en"],
    nsfw: false,
    capabilities,
  });

  test("unknown capabilities are dropped, not rejected", () => {
    const parsed = bridgeInfoSchema.parse(info(["search", "comments", "from-the-future"]));
    expect(parsed.capabilities).toEqual(["search", "comments"]);
  });

  test("a non-string capability is still rejected", () => {
    expect(bridgeInfoSchema.safeParse(info(["search", 3])).success).toBe(false);
  });

  test("isBridgeCapability knows comments", () => {
    expect(isBridgeCapability("comments")).toBe(true);
    expect(isBridgeCapability("from-the-future")).toBe(false);
  });
});
