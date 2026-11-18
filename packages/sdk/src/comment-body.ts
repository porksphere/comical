/**
 * Helpers for building comment bodies (`CommentNode[]`, capability "comments").
 *
 * A comment body is data, never markup: bridges turn whatever the source uses into nodes. These cover
 * the cases every bridge meets — plain text with line breaks in, a plain-text excerpt out — so the
 * per-source code only handles what is actually special about its format.
 */
import { COMMENT_LIMITS, type CommentInlineNode, type CommentNode } from "@comical/contract";

/**
 * A plain-text comment as nodes: one text run per line, with a `break` between lines. Runs of blank
 * lines collapse to a single paragraph gap (two breaks), and leading/trailing blank lines go. Text
 * past {@link COMMENT_LIMITS.textLength} in one line is cut.
 */
export function textToCommentBody(text: string): CommentInlineNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const nodes: CommentInlineNode[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      blanks++;
      continue;
    }
    if (nodes.length > 0) {
      nodes.push({ type: "break" });
      if (blanks > 0) nodes.push({ type: "break" });
    }
    blanks = 0;
    nodes.push({ type: "text", text: line.slice(0, COMMENT_LIMITS.textLength) });
    if (nodes.length >= COMMENT_LIMITS.bodyNodes) break;
  }
  return nodes.slice(0, COMMENT_LIMITS.bodyNodes);
}

/**
 * A body as plain text, cut to `maxLength` with an ellipsis — for `Comment.replyTo.excerpt`, which
 * quotes the start of the comment a reply answers. Spoiler text is masked, images become "[image]",
 * and quotes are skipped (they are someone else's words).
 */
export function commentBodyExcerpt(body: readonly CommentNode[], maxLength = 140): string {
  const parts: string[] = [];
  for (const node of body) {
    switch (node.type) {
      case "text":
        parts.push(node.spoiler ? "▒▒▒" : node.text);
        break;
      case "link":
        parts.push(node.text);
        break;
      case "mention":
        parts.push(`@${node.name}`);
        break;
      case "image":
        parts.push("[image]");
        break;
      case "break":
        parts.push(" ");
        break;
      case "quote":
        break;
    }
  }
  const text = parts.join("").replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
