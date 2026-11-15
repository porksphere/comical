/**
 * The cookie jar the gated network keeps per bridge: it stores what responses set and what the host
 * imports (cookies a person earned passing a site's check in a web view), and replays them on
 * matching requests. It follows the parts of RFC 6265 that matter here: a `Domain` cookie covers
 * the domain and its subdomains, a host-only one just its host; `Path` prefixes; `Expires` and
 * `Max-Age`. It serializes to a string so a host can keep it across launches.
 *
 * Imported cookies remember the User-Agent the check ran with: a site's clearance is tied to it, so
 * whoever replays the cookies outside the bridge's own requests (the image route) sends that
 * User-Agent too.
 */

export interface StoredCookie {
  name: string;
  value: string;
  /** Lowercase, without a leading dot. */
  domain: string;
  /** True when set without a `Domain` attribute: only this exact host. */
  hostOnly: boolean;
  path: string;
  /** Epoch ms; absent for a session cookie. */
  expires?: number;
  /** Imported from a web check, not set by a response. */
  imported?: boolean;
}

/** A cookie as a host imports it (from a web view's store). */
export interface ImportedCookie {
  name: string;
  value: string;
  /** Without a leading dot; the request host when absent. */
  domain?: string;
  path?: string;
  /** Epoch ms. */
  expires?: number;
}

interface Snapshot {
  v: 1;
  cookies: StoredCookie[];
  /** Site (domain) → the User-Agent its imported cookies were earned with. */
  agents: Record<string, string>;
}

export class CookieJar {
  private cookies: StoredCookie[] = [];
  private agents = new Map<string, string>();

  constructor(
    private readonly onChange?: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** The `Cookie` header value to send for `url`, or undefined if none apply. */
  header(url: string, opts: { importedOnly?: boolean } = {}): string | undefined {
    const pairs = this.matching(url)
      .filter((c) => !opts.importedOnly || c.imported)
      .map((c) => `${c.name}=${c.value}`);
    return pairs.length ? pairs.join("; ") : undefined;
  }

  /** The value of cookie `name` that would be sent to `url`. */
  get(url: string, name: string): string | undefined {
    return this.matching(url).find((c) => c.name === name)?.value;
  }

  /** The User-Agent `url`'s site's imported cookies were earned with, if any. */
  userAgent(url: string): string | undefined {
    const host = hostOf(url);
    if (!host) return undefined;
    for (const [site, ua] of this.agents) if (domainMatches(host, site)) return ua;
    return undefined;
  }

  /** Record `Set-Cookie` header values returned for `url`. */
  store(url: string, setCookies: readonly string[]): void {
    const host = hostOf(url);
    if (!host || setCookies.length === 0) return;
    let changed = false;
    for (const raw of setCookies) {
      const c = parseSetCookie(raw, host, pathOf(url), this.now());
      if (c) changed = this.put(c) || changed;
    }
    if (changed) this.onChange?.();
  }

  /** Add cookies a person earned for `url`'s site, and the User-Agent they were earned with. */
  import(url: string, cookies: readonly ImportedCookie[], userAgent?: string): void {
    const host = hostOf(url);
    if (!host) return;
    let site: string | undefined;
    for (const c of cookies) {
      if (!c.name) continue;
      const domain = (c.domain ?? host).replace(/^\./, "").toLowerCase();
      // A web view can hand over cookies for other sites; only this site's (or a parent's) count.
      if (!domainMatches(host, domain) && !domainMatches(domain, host)) continue;
      const stored: StoredCookie = { name: c.name, value: c.value, domain, hostOnly: c.domain === undefined, path: c.path || "/", imported: true };
      if (c.expires !== undefined) stored.expires = c.expires;
      this.put(stored);
      if (!site || domain.length < site.length) site = domain;
    }
    if (userAgent) this.agents.set(site ?? host, userAgent);
    this.onChange?.();
  }

  /** Forget `url`'s site's cookies (all of them, or only `names`), or everything with no `url`. */
  clear(url?: string, names?: readonly string[]): void {
    if (url === undefined) {
      this.cookies = [];
      this.agents.clear();
    } else {
      const host = hostOf(url);
      if (!host) return;
      this.cookies = this.cookies.filter((c) => !(domainMatches(host, c.domain) || domainMatches(c.domain, host)) || (names && !names.includes(c.name)));
      if (!names) for (const site of [...this.agents.keys()]) if (domainMatches(host, site) || domainMatches(site, host)) this.agents.delete(site);
    }
    this.onChange?.();
  }

  serialize(): string {
    const live = this.cookies.filter((c) => c.expires === undefined || c.expires > this.now());
    const snap: Snapshot = { v: 1, cookies: live, agents: Object.fromEntries(this.agents) };
    return JSON.stringify(snap);
  }

  /** Replace the contents with a {@link serialize}d snapshot; a malformed one is ignored. */
  restore(serialized: string | undefined): void {
    if (!serialized) return;
    try {
      const snap = JSON.parse(serialized) as Partial<Snapshot>;
      if (snap.v !== 1 || !Array.isArray(snap.cookies)) return;
      const now = this.now();
      this.cookies = snap.cookies.filter(
        (c): c is StoredCookie =>
          !!c && typeof c.name === "string" && typeof c.value === "string" && typeof c.domain === "string" && typeof c.path === "string" && (c.expires === undefined || c.expires > now),
      );
      this.agents = new Map(Object.entries(snap.agents ?? {}).filter(([, v]) => typeof v === "string"));
    } catch {
      // Not ours, or corrupt: start empty.
    }
  }

  private matching(url: string): StoredCookie[] {
    const host = hostOf(url);
    if (!host) return [];
    const path = pathOf(url);
    const now = this.now();
    this.cookies = this.cookies.filter((c) => c.expires === undefined || c.expires > now);
    return this.cookies
      .filter((c) => (c.hostOnly ? host === c.domain : domainMatches(host, c.domain)) && pathMatches(path, c.path))
      .sort((a, b) => b.path.length - a.path.length);
  }

  /** Insert or replace by (name, domain, path); an already-expired cookie deletes. Whether anything changed. */
  private put(c: StoredCookie): boolean {
    const i = this.cookies.findIndex((x) => x.name === c.name && x.domain === c.domain && x.path === c.path);
    const expired = c.expires !== undefined && c.expires <= this.now();
    if (expired) {
      if (i < 0) return false;
      this.cookies.splice(i, 1);
      return true;
    }
    if (i >= 0) this.cookies[i] = c;
    else this.cookies.push(c);
    return true;
  }
}

/** Whether `host` is `domain` or a subdomain of it. */
function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function parseSetCookie(raw: string, host: string, requestPath: string, now: number): StoredCookie | undefined {
  const [first, ...attrs] = raw.split(";");
  const eq = first?.indexOf("=") ?? -1;
  if (!first || eq <= 0) return undefined;
  const c: StoredCookie = {
    name: first.slice(0, eq).trim(),
    value: first.slice(eq + 1).trim(),
    domain: host,
    hostOnly: true,
    path: defaultPath(requestPath),
  };
  let maxAge: number | undefined;
  let expires: number | undefined;
  for (const attr of attrs) {
    const i = attr.indexOf("=");
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? "" : attr.slice(i + 1).trim();
    if (key === "domain" && val) {
      const d = val.replace(/^\./, "").toLowerCase();
      // A response may only set cookies for its own domain or a parent of it.
      if (!domainMatches(host, d)) return undefined;
      c.domain = d;
      c.hostOnly = false;
    } else if (key === "path" && val.startsWith("/")) {
      c.path = val;
    } else if (key === "max-age" && /^-?\d+$/.test(val)) {
      maxAge = Number(val);
    } else if (key === "expires") {
      const t = Date.parse(val);
      if (Number.isFinite(t)) expires = t;
    }
  }
  if (maxAge !== undefined) c.expires = now + maxAge * 1000;
  else if (expires !== undefined) c.expires = expires;
  return c;
}

/** RFC 6265's default path: the request path up to its last `/`. */
function defaultPath(path: string): string {
  if (!path.startsWith("/")) return "/";
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return "/";
  }
}
