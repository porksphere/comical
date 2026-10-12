/**
 * Guards the on-device Text{En,De}coder + atob/btoa polyfills that the Android (QuickJS) harness
 * installs. QuickJS ships none of the four, and the SDK's cursor helpers use all of them on every
 * paged read — before these existed, every bridge's getListItems threw "'TextEncoder' is not
 * defined" on Android. Checked against Bun's native implementations as the reference.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { decodeCursor, encodeCursor } from "@comical/sdk";
import { ComicalTextDecoder, ComicalTextEncoder, comicalAtob, comicalBtoa } from "../src/text-polyfill.ts";

const SAMPLES = [
  "",
  "plain ascii",
  "café — naïve",
  "日本語のタイトル",
  "emoji 😀👍🏽 and 𝒳",
  '{"page":2,"q":"ワンピース"}',
];

describe("ComicalTextEncoder / ComicalTextDecoder", () => {
  test("encode matches the native UTF-8 encoder byte-for-byte", () => {
    for (const s of SAMPLES) {
      expect(Array.from(new ComicalTextEncoder().encode(s))).toEqual(Array.from(new TextEncoder().encode(s)));
    }
  });

  test("decode round-trips what the native encoder produced", () => {
    for (const s of SAMPLES) {
      expect(new ComicalTextDecoder().decode(new TextEncoder().encode(s))).toBe(s);
    }
  });

  test("decode accepts an ArrayBuffer and a subarray view, and empty input", () => {
    const bytes = new TextEncoder().encode("xxhéllo");
    expect(new ComicalTextDecoder().decode(bytes.subarray(2))).toBe("héllo");
    expect(new ComicalTextDecoder().decode(new TextEncoder().encode("abc").buffer)).toBe("abc");
    expect(new ComicalTextDecoder().decode()).toBe("");
  });

  test("a lone surrogate encodes as U+FFFD, like the native encoder", () => {
    const s = "a\ud800b";
    expect(Array.from(new ComicalTextEncoder().encode(s))).toEqual(Array.from(new TextEncoder().encode(s)));
  });
});

describe("comicalBtoa / comicalAtob", () => {
  test("match native btoa/atob for every padding length and all byte values", () => {
    const all = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join("");
    for (const s of ["", "a", "ab", "abc", "abcd", all]) {
      expect(comicalBtoa(s)).toBe(btoa(s));
      expect(comicalAtob(btoa(s))).toBe(s);
    }
  });

  test("atob tolerates missing padding and whitespace", () => {
    expect(comicalAtob("YWI")).toBe("ab");
    expect(comicalAtob(" YW\nJj ")).toBe("abc");
  });

  test("btoa rejects non-Latin1 input; atob rejects bad characters and lengths", () => {
    expect(() => comicalBtoa("日本")).toThrow();
    expect(() => comicalAtob("ab$c")).toThrow();
    expect(() => comicalAtob("abcde")).toThrow();
  });
});

describe("SDK cursors on an engine with only the polyfills", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const native = { TextEncoder: g.TextEncoder, TextDecoder: g.TextDecoder, atob: g.atob, btoa: g.btoa };
  afterEach(() => Object.assign(g, native));

  test("encodeCursor/decodeCursor round-trip through the polyfills", () => {
    const value = { page: 3, q: "ワンピース 😀", seen: ["a", "b"] };
    const nativeCursor = encodeCursor(value);
    Object.assign(g, {
      TextEncoder: ComicalTextEncoder,
      TextDecoder: ComicalTextDecoder,
      atob: comicalAtob,
      btoa: comicalBtoa,
    });
    const cursor = encodeCursor(value);
    expect(cursor).toBe(nativeCursor);
    expect(decodeCursor<typeof value>(cursor)).toEqual(value);
  });
});
