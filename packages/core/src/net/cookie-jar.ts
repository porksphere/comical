/**
 * A minimal cookie jar: stores cookies per host and replays them on same-host requests.
 * Intentionally simple (no path/expiry/secure semantics) — enough for the session cookies a backend
 * sets after login. Lives in the gated network so every host gets uniform session handling; a host
 * with stricter needs can still attach cookies itself.
 */
export class CookieJar {
  private readonly byHost = new Map<string, Map<string, string>>();

  /** The `Cookie` header value to send for `url`, or undefined if none apply. */
  header(url: string): string | undefined {
    const host = hostOf(url);
    if (!host) return undefined;
    const jar = this.byHost.get(host);
    if (!jar || jar.size === 0) return undefined;
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  /** Record `Set-Cookie` header values returned for `url`. */
  store(url: string, setCookies: readonly string[]): void {
    const host = hostOf(url);
    if (!host || setCookies.length === 0) return;
    const jar = this.byHost.get(host) ?? new Map<string, string>();
    for (const raw of setCookies) {
      const first = raw.split(";", 1)[0]?.trim();
      if (!first) continue;
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
    this.byHost.set(host, jar);
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
