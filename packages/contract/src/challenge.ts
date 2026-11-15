/**
 * A typed "a person has to pass the site's check" signal (contract 2.1): the source answered with an
 * anti-bot challenge page instead of content. It rides the error message like
 * {@link loginRequiredMessage}: the runtime's network layer throws
 * `new Error(challengeMessage({ url, userAgent }))` when it sees one (a bridge's own detection can
 * throw it too), and a host recovers it with `parseChallenge(message)`. The router answers 403 with
 * the details; the app opens `url` in a web view with `userAgent` as the browser's User-Agent, the
 * user passes the check, and the cookies it leaves are imported into the bridge's cookie jar.
 *
 * `userAgent` is the User-Agent the challenged request sent. The check has to run with the same one:
 * the clearance a site hands out is tied to the User-Agent (and network) that earned it.
 */

const PREFIX = "[challenge:";

export interface Challenge {
  /** The page to open in the web view. */
  url: string;
  /** The User-Agent the challenged request sent, when known. */
  userAgent?: string;
  /** A short user-facing reason. */
  reason: string;
}

/** An error message carrying a challenge to pass. `url` and `userAgent` are encoded so any URL survives. */
export function challengeMessage(c: { url: string; userAgent?: string; reason?: string }): string {
  const ua = c.userAgent ? `|${encodeURIComponent(c.userAgent)}` : "";
  return `${PREFIX}${encodeURIComponent(c.url)}${ua}] ${c.reason ?? "the site wants to check this is a person"}`;
}

/** The challenge encoded by {@link challengeMessage} anywhere in `message`, or null. */
export function parseChallenge(message: string): Challenge | null {
  const at = message.indexOf(PREFIX);
  if (at < 0) return null;
  const close = message.indexOf("]", at + PREFIX.length);
  if (close < 0) return null;
  const [rawUrl, rawUa] = message.slice(at + PREFIX.length, close).split("|");
  let url: string;
  let userAgent: string | undefined;
  try {
    url = decodeURIComponent(rawUrl ?? "");
    userAgent = rawUa ? decodeURIComponent(rawUa) : undefined;
  } catch {
    return null;
  }
  if (!/^https?:\/\//i.test(url)) return null;
  const reason = message.slice(close + 1).trim() || "the site wants to check this is a person";
  return userAgent ? { url, userAgent, reason } : { url, reason };
}
