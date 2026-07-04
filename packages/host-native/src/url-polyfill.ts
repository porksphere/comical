/**
 * A small `URL` polyfill for the on-device JS engines (QuickJS on Android; JavaScriptCore on iOS
 * injects an equivalent from Swift — keep the two in lockstep). JSC/QuickJS don't ship `URL`, and
 * bridge code plus Zod's `z.string().url()` rely on it.
 *
 * The previous stub only validated and set `.href`. That silently broke session auth: core's
 * `CookieJar` keys cookies on `new URL(url).host`, so with no `.host` the login `Set-Cookie` was
 * never stored and no `Cookie` header was ever replayed → authenticated calls (e.g. favorites) came
 * back 401. This parses the standard components so `.host`/`.hostname`/`.pathname`/… work.
 *
 * Intentionally minimal: absolute `http(s)` URLs only (what bridges use), no `base` argument, no
 * normalization. Throws `TypeError` on anything else, matching the old stub's validation contract.
 */
export class ComicalURL {
  href: string;
  protocol: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
  origin: string;
  searchParams: URLSearchParams;

  constructor(url: string) {
    if (typeof url !== "string" || !/^https?:\/\/./.test(url)) {
      throw new TypeError("Invalid URL: " + url);
    }
    this.href = url;
    const schemeEnd = url.indexOf("://");
    this.protocol = url.slice(0, schemeEnd) + ":"; // e.g. "https:"

    let rest = url.slice(schemeEnd + 3);
    const hashIdx = rest.indexOf("#");
    if (hashIdx >= 0) {
      this.hash = rest.slice(hashIdx);
      rest = rest.slice(0, hashIdx);
    } else {
      this.hash = "";
    }
    const qIdx = rest.indexOf("?");
    if (qIdx >= 0) {
      this.search = rest.slice(qIdx);
      rest = rest.slice(0, qIdx);
    } else {
      this.search = "";
    }
    const slashIdx = rest.indexOf("/");
    const authority = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
    this.pathname = slashIdx >= 0 ? rest.slice(slashIdx) : "/";

    // Strip any userinfo, then split host:port. `.host` keeps the port; `.hostname` doesn't.
    const at = authority.indexOf("@");
    const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
    this.host = hostPort;
    const colon = hostPort.lastIndexOf(":");
    this.hostname = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
    this.port = colon >= 0 ? hostPort.slice(colon + 1) : "";

    this.origin = this.protocol + "//" + this.host;
    this.searchParams = new URLSearchParams(this.search);
  }

  toString(): string {
    return this.href;
  }
}
