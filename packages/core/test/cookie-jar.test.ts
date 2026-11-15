/** The cookie jar's RFC 6265 subset: domains, paths, expiry, imports, persistence. */
import { describe, expect, test } from "bun:test";
import { CookieJar } from "../src/net/cookie-jar.ts";

describe("cookie jar", () => {
  test("a Domain cookie covers subdomains; a host-only one only its host", () => {
    const jar = new CookieJar();
    jar.store("https://www.site.test/a", ["wide=1; Domain=.site.test; Path=/", "narrow=2; Path=/"]);
    expect(jar.header("https://www.site.test/x")).toBe("wide=1; narrow=2");
    expect(jar.header("https://img.site.test/x")).toBe("wide=1");
    expect(jar.header("https://other.test/x")).toBeUndefined();
  });

  test("a response can't set a cookie for a domain it isn't in", () => {
    const jar = new CookieJar();
    jar.store("https://site.test/", ["evil=1; Domain=other.test"]);
    expect(jar.header("https://other.test/")).toBeUndefined();
  });

  test("paths, longest first", () => {
    const jar = new CookieJar();
    jar.store("https://s.test/", ["a=root; Path=/", "a=deep; Path=/reader"]);
    expect(jar.header("https://s.test/reader/1")).toBe("a=deep; a=root");
    expect(jar.header("https://s.test/readers")).toBe("a=root");
  });

  test("Max-Age and Expires; an expired Set-Cookie deletes", () => {
    let now = 1_000_000;
    const jar = new CookieJar(undefined, () => now);
    jar.store("https://s.test/", ["short=1; Max-Age=10; Path=/", "gone=1; Path=/"]);
    jar.store("https://s.test/", ["gone=; Max-Age=0; Path=/"]);
    expect(jar.header("https://s.test/")).toBe("short=1");
    now += 11_000;
    expect(jar.header("https://s.test/")).toBeUndefined();
  });

  test("imports keep their User-Agent per site, and can be sent on their own", () => {
    const jar = new CookieJar();
    jar.store("https://s.test/", ["session=1; Path=/"]);
    jar.import("https://www.s.test/x", [{ name: "cf_clearance", value: "abc", domain: ".s.test" }, { name: "stray", value: "1", domain: "elsewhere.test" }], "UA/1");
    expect(jar.header("https://www.s.test/")).toBe("cf_clearance=abc");
    expect(jar.header("https://s.test/", { importedOnly: true })).toBe("cf_clearance=abc");
    expect(jar.header("https://elsewhere.test/")).toBeUndefined();
    expect(jar.userAgent("https://img.s.test/p.jpg")).toBe("UA/1");
    expect(jar.get("https://s.test/", "cf_clearance")).toBe("abc");
  });

  test("clear a site, or everything", () => {
    const jar = new CookieJar();
    jar.import("https://a.test/", [{ name: "x", value: "1" }], "UA");
    jar.import("https://b.test/", [{ name: "y", value: "2" }]);
    jar.clear("https://a.test/");
    expect(jar.header("https://a.test/")).toBeUndefined();
    expect(jar.userAgent("https://a.test/")).toBeUndefined();
    expect(jar.header("https://b.test/")).toBe("y=2");
    jar.clear();
    expect(jar.header("https://b.test/")).toBeUndefined();
  });

  test("serializes live cookies and restores them; a bad snapshot is ignored", () => {
    let changes = 0;
    const jar = new CookieJar(() => changes++);
    jar.import("https://s.test/", [{ name: "c", value: "1", domain: "s.test", expires: Date.now() + 60_000 }], "UA");
    expect(changes).toBe(1);
    const copy = new CookieJar();
    copy.restore(jar.serialize());
    expect(copy.header("https://s.test/")).toBe("c=1");
    expect(copy.userAgent("https://s.test/")).toBe("UA");
    copy.restore("{not json");
    copy.restore(JSON.stringify({ v: 2, cookies: [] }));
    expect(copy.header("https://s.test/")).toBe("c=1");
  });
});
