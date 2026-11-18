import { describe, expect, test } from "bun:test";
import { COMMENT_LIMITS, commentNodeSchema } from "@comical/contract";
import { commentBodyExcerpt, textToCommentBody } from "../src/comment-body.ts";

describe("textToCommentBody", () => {
  test("one run per line, a break between lines, two between paragraphs", () => {
    expect(textToCommentBody("one\ntwo\n\n\n\nthree")).toEqual([
      { type: "text", text: "one" },
      { type: "break" },
      { type: "text", text: "two" },
      { type: "break" },
      { type: "break" },
      { type: "text", text: "three" },
    ]);
  });

  test("drops leading and trailing blank lines and handles CRLF", () => {
    expect(textToCommentBody("\r\n\r\nhi\r\nthere\r\n\r\n")).toEqual([
      { type: "text", text: "hi" },
      { type: "break" },
      { type: "text", text: "there" },
    ]);
  });

  test("empty text is an empty body", () => {
    expect(textToCommentBody("")).toEqual([]);
    expect(textToCommentBody(" \n \n")).toEqual([]);
  });

  test("stays within the contract's limits", () => {
    const long = "x".repeat(COMMENT_LIMITS.textLength + 10);
    const [first] = textToCommentBody(long);
    expect(first).toEqual({ type: "text", text: "x".repeat(COMMENT_LIMITS.textLength) });
    const many = textToCommentBody(Array.from({ length: COMMENT_LIMITS.bodyNodes }, (_, i) => `l${i}`).join("\n"));
    expect(many.length).toBeLessThanOrEqual(COMMENT_LIMITS.bodyNodes);
    for (const node of many) expect(commentNodeSchema.safeParse(node).success).toBe(true);
  });
});

describe("commentBodyExcerpt", () => {
  test("flattens a body to one line, masking spoilers and skipping quotes", () => {
    expect(
      commentBodyExcerpt([
        { type: "quote", children: [{ type: "text", text: "someone else" }] },
        { type: "mention", name: "ann" },
        { type: "text", text: " the twist is " },
        { type: "text", text: "secret", spoiler: true },
        { type: "break" },
        { type: "image", url: "https://cdn.test/a.png" },
        { type: "link", text: "here", url: "https://site.test" },
      ]),
    ).toBe("@ann the twist is ▒▒▒ [image]here");
  });

  test("cuts long text with an ellipsis", () => {
    const out = commentBodyExcerpt([{ type: "text", text: "word ".repeat(100) }], 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith("…")).toBe(true);
  });
});
