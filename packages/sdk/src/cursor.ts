/**
 * Cursor helpers for paged bridge/tracker reads.
 *
 * A `Cursor` is an opaque string: the bridge decides what goes in it and the host only stores and
 * echoes it (see `Cursor` in `@comical/contract`). These helpers cover the two shapes that come up
 * in practice, so a bridge never hand-rolls encoding:
 *
 * - **Structured state** — {@link encodeCursor} / {@link decodeCursor} round-trip a JSON-serializable
 *   value through base64url, which is URL-safe and survives the client's persisted query cache.
 * - **Plain page numbers** — {@link pageFromCursor} / {@link nextPageCursor} for the many backends
 *   that really are just `?page=N`, so those bridges stay one-liners.
 * - **Offset + total** — {@link offsetFromCursor} / {@link nextOffsetCursor} for APIs that report how
 *   many rows exist, where "is this the last window" is an exact answer rather than a guess.
 */
import { CURSOR_MAX_LENGTH, type Cursor } from "@comical/contract";

/** base64url alphabet, unpadded — safe in a query string with no escaping. */
const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/**
 * Encode a JSON-serializable value as an opaque cursor.
 *
 * Throws if the result would exceed `CURSOR_MAX_LENGTH` — a cursor is a token, not a place to stash
 * bulk state. If you hit this, keep the state in `host.storage` and put the key in the cursor.
 */
export function encodeCursor(value: unknown): Cursor {
  const cursor = toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  if (cursor.length > CURSOR_MAX_LENGTH) {
    throw new Error(
      `cursor is ${cursor.length} chars, over the ${CURSOR_MAX_LENGTH} limit — keep bulky resume state in host.storage and put its key in the cursor instead`,
    );
  }
  return cursor;
}

/**
 * Decode a cursor produced by {@link encodeCursor}. Returns `undefined` for an absent cursor (the
 * first page) *and* for a malformed one — a stale or corrupted cursor should restart the walk, not
 * throw at a user mid-scroll.
 */
export function decodeCursor<T>(cursor: Cursor | undefined): T | undefined {
  if (cursor === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(cursor))) as T;
  } catch {
    return undefined;
  }
}

/**
 * Read a 1-based page number out of a cursor, for backends that paginate by number. An absent or
 * unreadable cursor means page 1.
 */
export function pageFromCursor(cursor: Cursor | undefined): number {
  const decoded = decodeCursor<{ page?: unknown }>(cursor);
  const page = typeof decoded?.page === "number" ? decoded.page : Number.NaN;
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

/**
 * Build the cursor for the page after `page`, or `undefined` when there is nothing more — the
 * counterpart to {@link pageFromCursor}:
 *
 * ```ts
 * async getListItems(listId, req = {}) {
 *   const page = pageFromCursor(req.cursor);
 *   const { items, more } = await this.fetchPage(listId, page);
 *   return { items, nextCursor: nextPageCursor(page, more) };
 * }
 * ```
 */
export function nextPageCursor(page: number, hasMore: boolean): Cursor | undefined {
  return hasMore ? encodeCursor({ page: page + 1 }) : undefined;
}

/**
 * Read a 0-based row offset out of a cursor, for backends that page by `?offset=N&limit=N`. An absent
 * or unreadable cursor means the start of the collection.
 */
export function offsetFromCursor(cursor: Cursor | undefined): number {
  const decoded = decodeCursor<{ offset?: unknown }>(cursor);
  const offset = typeof decoded?.offset === "number" ? decoded.offset : Number.NaN;
  return Number.isInteger(offset) && offset >= 0 ? offset : 0;
}

/**
 * Cursor for the window after the one that started at `offset` and returned `count` rows out of
 * `total`, or `undefined` when that was the last window:
 *
 * ```ts
 * async getListItems(listId, req = {}) {
 *   const offset = offsetFromCursor(req.cursor);
 *   const { data, total } = await this.fetchWindow(listId, offset, LIMIT);
 *   return { items: data.map(toEntry), nextCursor: nextOffsetCursor(offset, data.length, total) };
 * }
 * ```
 *
 * An empty window ends the walk even if `total` claims more rows remain: a cursor that doesn't
 * advance is the infinite-scroll loop this whole design exists to make unrepresentable, and a
 * `total` that disagrees with the rows actually returned is the backend being wrong, not a reason
 * to keep asking.
 */
export function nextOffsetCursor(offset: number, count: number, total: number): Cursor | undefined {
  return count > 0 && offset + count < total ? encodeCursor({ offset: offset + count }) : undefined;
}
