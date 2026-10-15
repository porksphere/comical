/**
 * URL matching shared by the politeness layers: a host allow-list entry matches a hostname exactly
 * or as a parent domain, and a route glob matches a pathname whole (`*` one segment, `**` the rest).
 * Regex-based rather than `new URL` so a bridge's odd-but-harmless URL never throws here.
 */

/** The lowercase hostname of an absolute http(s) URL, or undefined when it has none. */
export function hostOf(url: string): string | undefined {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^:/?#]+)/i.exec(url);
  return m?.[1]?.toLowerCase();
}

/** The pathname of an absolute URL (`/` when it has none), without query or fragment. */
export function pathOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(url);
  const path = m?.[1] ?? "";
  return path === "" ? "/" : path;
}

/** Whether `host` is `rule` itself or a subdomain of it (both lowercase). */
export function hostMatches(host: string, rule: string): boolean {
  return host === rule || host.endsWith(`.${rule}`);
}

/** The first of `rules` that `host` matches, by index. */
export function findHostRule(host: string, rules: readonly string[]): number {
  return rules.findIndex((r) => hostMatches(host, r.toLowerCase()));
}

/** Compile a path glob: `*` matches one segment, `**` anything (including `/`); other text is literal. */
export function compilePathGlob(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]+";
    } else re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}/?$`);
}
