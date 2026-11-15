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
 *
 * Some sites leave their clearance in the page's localStorage instead of a cookie, for the site's
 * own script to send along. A bridge for one names the keys in `storage`: the check is done once
 * they're all set, and their values come back with the cookies, kept in the bridge's secure storage
 * under {@link webCheckStorageKey}, where the bridge reads them.
 */

const PREFIX = "[challenge:";

export interface Challenge {
  /** The page to open in the web view. */
  url: string;
  /** The User-Agent the challenged request sent, when known. */
  userAgent?: string;
  /** Page localStorage keys the check leaves the clearance in, when it isn't (only) a cookie. */
  storage?: string[];
  /** A short user-facing reason. */
  reason: string;
}

/** An error message carrying a challenge to pass. `url` and `userAgent` are encoded so any URL survives. */
export function challengeMessage(c: { url: string; userAgent?: string; storage?: readonly string[]; reason?: string }): string {
  const ua = c.userAgent || c.storage?.length ? `|${encodeURIComponent(c.userAgent ?? "")}` : "";
  const storage = c.storage?.length ? `|${c.storage.map(encodeURIComponent).join(",")}` : "";
  return `${PREFIX}${encodeURIComponent(c.url)}${ua}${storage}] ${c.reason ?? "the site wants to check this is a person"}`;
}

/** Where a value a web check read from the page's localStorage is kept, in the bridge's secure storage. */
export function webCheckStorageKey(name: string): string {
  return `web-check:${name}`;
}

/** The challenge encoded by {@link challengeMessage} anywhere in `message`, or null. */
export function parseChallenge(message: string): Challenge | null {
  const at = message.indexOf(PREFIX);
  if (at < 0) return null;
  const close = message.indexOf("]", at + PREFIX.length);
  if (close < 0) return null;
  const [rawUrl, rawUa, rawStorage] = message.slice(at + PREFIX.length, close).split("|");
  let url: string;
  let userAgent: string | undefined;
  let storage: string[] | undefined;
  try {
    url = decodeURIComponent(rawUrl ?? "");
    userAgent = rawUa ? decodeURIComponent(rawUa) : undefined;
    storage = rawStorage ? rawStorage.split(",").map(decodeURIComponent).filter(Boolean) : undefined;
  } catch {
    return null;
  }
  if (!/^https?:\/\//i.test(url)) return null;
  const reason = message.slice(close + 1).trim() || "the site wants to check this is a person";
  return { url, ...(userAgent ? { userAgent } : {}), ...(storage?.length ? { storage } : {}), reason };
}
