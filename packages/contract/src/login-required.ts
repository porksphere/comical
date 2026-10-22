/**
 * A typed "sign in to do this" signal (contract 2.1): the site refused because nobody is signed in,
 * or the session the bridge sent has ended. It rides the error message like {@link seriesGoneMessage}:
 * a bridge throws `new Error(loginRequiredMessage("cookies", why))`, naming the setting that signs it
 * in, and a host recovers it with `parseLoginRequired(message)` — the router answers 401 and the app
 * points the user at that setting.
 *
 * Assert it only when the site said so (a sign-in page where content was expected, a 401 naming the
 * session). An outage or a parse failure is not a login problem.
 */

const PREFIX = "[login-required:";

/** An error message naming the setting that signs the bridge in, and a short user-facing reason. */
export function loginRequiredMessage(key: string, reason = "sign in to continue"): string {
  return `${PREFIX}${key}] ${reason}`;
}

/** The setting key and reason encoded by {@link loginRequiredMessage} anywhere in `message`, or null. */
export function parseLoginRequired(message: string): { key: string; reason: string } | null {
  const at = message.indexOf(PREFIX);
  if (at < 0) return null;
  const close = message.indexOf("]", at + PREFIX.length);
  if (close < 0) return null;
  const key = message.slice(at + PREFIX.length, close);
  if (!key) return null;
  const reason = message.slice(close + 1).trim();
  return { key, reason: reason || "sign in to continue" };
}
