/**
 * Android / QuickJS build entrypoint. Bundled to host-android/.../assets/comical_harness.js and
 * evaluated once in the app's QuickJS context, where Kotlin has injected the async _native_*
 * functions and __comical_native_eval.
 */
import { makeAsyncHost } from "./adapter-async.ts";
import { installComicalHarness } from "./runtime.ts";

// QuickJS lacks several Web APIs that bridge code and Zod rely on. Install minimal polyfills.

// URL — Zod's z.string().url() calls `new URL(str)` to validate.
if (typeof URL === "undefined") {
  (globalThis as unknown as Record<string, unknown>).URL = function URL(
    this: { href: string },
    url: string,
  ) {
    if (typeof url !== "string" || !/^https?:\/\/./.test(url)) {
      throw new TypeError("Invalid URL: " + url);
    }
    this.href = url;
  };
}

// URLSearchParams — used by bridges to build query strings.
if (typeof URLSearchParams === "undefined") {
  (globalThis as unknown as Record<string, unknown>).URLSearchParams = class URLSearchParams {
    private _p: Array<[string, string]> = [];

    constructor(init?: string | Record<string, string> | Array<[string, string]>) {
      if (typeof init === "string") {
        const s = init.startsWith("?") ? init.slice(1) : init;
        for (const part of s ? s.split("&") : []) {
          const eq = part.indexOf("=");
          const k = decodeURIComponent((eq >= 0 ? part.slice(0, eq) : part).replace(/\+/g, " "));
          const v = decodeURIComponent((eq >= 0 ? part.slice(eq + 1) : "").replace(/\+/g, " "));
          this._p.push([k, v]);
        }
      } else if (Array.isArray(init)) {
        for (const [k, v] of init) this._p.push([String(k), String(v)]);
      } else if (init && typeof init === "object") {
        for (const [k, v] of Object.entries(init)) this._p.push([k, String(v)]);
      }
    }

    append(k: string, v: string) { this._p.push([k, v]); }
    delete(k: string) { this._p = this._p.filter(([n]) => n !== k); }
    get(k: string) { return this._p.find(([n]) => n === k)?.[1] ?? null; }
    getAll(k: string) { return this._p.filter(([n]) => n === k).map(([, v]) => v); }
    has(k: string) { return this._p.some(([n]) => n === k); }
    set(k: string, v: string) {
      const i = this._p.findIndex(([n]) => n === k);
      if (i < 0) { this._p.push([k, v]); return; }
      this._p[i] = [k, v];
      this._p = this._p.filter(([n], j) => n !== k || j === i);
    }
    toString() {
      return this._p.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
    }
    forEach(cb: (v: string, k: string) => void) { this._p.forEach(([k, v]) => cb(v, k)); }
    entries() { return this._p[Symbol.iterator](); }
    keys() { return this._p.map(([k]) => k)[Symbol.iterator](); }
    values() { return this._p.map(([, v]) => v)[Symbol.iterator](); }
    [Symbol.iterator]() { return this._p[Symbol.iterator](); }
    get size() { return this._p.length; }
  };
}

installComicalHarness(makeAsyncHost);
