/**
 * Guards the on-device `URL` polyfill's component parsing — in particular `.host`, which core's
 * CookieJar keys session cookies on. A stub that only set `.href` silently broke authenticated
 * bridge calls (favorites → 401) because cookies could never be stored or replayed.
 */
import { describe, expect, test } from "bun:test";
import { CookieJar } from "@comical/core";
import { ComicalURL } from "../src/url-polyfill.ts";

describe("ComicalURL polyfill", () => {
  test("parses host/hostname/port/pathname/search from a typical bridge URL", () => {
    const u = new ComicalURL("https://atsu.moe/api/favorites?page=1");
    expect(u.protocol).toBe("https:");
    expect(u.host).toBe("atsu.moe");
    expect(u.hostname).toBe("atsu.moe");
    expect(u.port).toBe("");
    expect(u.pathname).toBe("/api/favorites");
    expect(u.search).toBe("?page=1");
    expect(u.origin).toBe("https://atsu.moe");
    expect(u.searchParams.get("page")).toBe("1");
  });

  test("keeps the port in .host but not .hostname; strips userinfo and hash", () => {
    const u = new ComicalURL("https://user:pass@example.com:8443/x#frag");
    expect(u.host).toBe("example.com:8443");
    expect(u.hostname).toBe("example.com");
    expect(u.port).toBe("8443");
    expect(u.hash).toBe("#frag");
    expect(u.pathname).toBe("/x");
  });

  test("defaults pathname to / when absent", () => {
    expect(new ComicalURL("https://atsu.moe").pathname).toBe("/");
  });

  test("throws on non-http(s) / invalid input, matching the old stub's validation", () => {
    expect(() => new ComicalURL("not a url")).toThrow(TypeError);
    expect(() => new ComicalURL("ftp://x/y")).toThrow(TypeError);
    expect(() => new ComicalURL(undefined as unknown as string)).toThrow(TypeError);
  });

  // CookieJar keys cookies on `new URL(url).host` using the *global* URL — so these swap it, to run
  // the jar under the exact on-device condition rather than Bun's native URL.
  test("the old href-only stub breaks CookieJar (reproduces the favorites-401)", () => {
    const real = globalThis.URL;
    // The stub the fix replaces: sets only .href, so .host is undefined.
    (globalThis as unknown as { URL: unknown }).URL = function URLStub(this: { href: string }, url: string) {
      this.href = url;
    };
    try {
      const jar = new CookieJar();
      jar.store("https://atsu.moe/api/auth/login", ["session=abc123; Path=/"]);
      // No host → cookie never stored → nothing to replay.
      expect(jar.header("https://atsu.moe/api/favorites")).toBeUndefined();
    } finally {
      (globalThis as unknown as { URL: unknown }).URL = real;
    }
  });

  test("the polyfill lets CookieJar store and replay a login cookie (the fix)", () => {
    const real = globalThis.URL;
    (globalThis as unknown as { URL: unknown }).URL = ComicalURL;
    try {
      const jar = new CookieJar();
      jar.store("https://atsu.moe/api/auth/login", ["session=abc123; Path=/; HttpOnly"]);
      expect(jar.header("https://atsu.moe/api/favorites?page=1")).toBe("session=abc123");
    } finally {
      (globalThis as unknown as { URL: unknown }).URL = real;
    }
  });
});
