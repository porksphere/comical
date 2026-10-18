/**
 * A typed "this series no longer exists on the source" signal — the source answered, and its answer
 * was that the series is gone (deleted, taken down, never existed under this id). It rides the error
 * message the same way {@link rateLimitedMessage} does, since bridge errors cross the sandbox as
 * message strings only: a bridge throws `new Error(seriesGoneMessage(why))`, and a host recovers it
 * with `parseSeriesGone(message)` — the router answers 410 and the library records the removal.
 *
 * Assert it only on positive evidence from the source (a 404 naming the series, an explicit "not
 * found" payload, a takedown notice). A timeout, a 5xx, a parse failure or an auth wall is NOT gone:
 * hosts act on this signal (badging the entry, stopping its sync), so a false one is user-visible.
 */

const MARKER = "[series-gone]";

/** An error message carrying the series-gone marker and a short user-facing reason. */
export function seriesGoneMessage(reason = "removed from the source"): string {
  return `${MARKER} ${reason}`;
}

/** The reason encoded by {@link seriesGoneMessage} anywhere in `message`, or null when absent. */
export function parseSeriesGone(message: string): { reason: string } | null {
  const at = message.indexOf(MARKER);
  if (at < 0) return null;
  const reason = message.slice(at + MARKER.length).trim();
  return { reason: reason || "removed from the source" };
}
