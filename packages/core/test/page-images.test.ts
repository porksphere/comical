/**
 * Page image processing in core: AES-CTR (against the NIST SP 800-38A vectors), byte transforms,
 * reading an image's size, checking a layout's bounds, the orchestration the image route runs, and
 * how the loader and image router treat `Page.process` / `images.process`.
 */
import { describe, expect, test } from "bun:test";
import { bridgeImagePath, parseBridgeImagePath } from "@comical/contract";
import type { BridgeImages, HostCapabilities, PageImageLayout } from "@comical/contract";
import { aesCtr } from "../src/aes.ts";
import {
  BridgeContractError,
  applyByteTransforms,
  checkPageImageLayout,
  imageSize,
  loadBridge,
  processPageImage,
} from "../src/index.ts";

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

describe("aesCtr", () => {
  const plain = hex(
    "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710",
  );
  const counter = hex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff");

  test.each([
    ["AES-128 (F.5.1)", "2b7e151628aed2a6abf7158809cf4f3c", "874d6191b620e3261bef6864990db6ce9806f66b7970fdff8617187bb9fffdff5ae4df3edbd5d35e5b4f09020db03eab1e031dda2fbe03d1792170a0f3009cee"],
    ["AES-192 (F.5.3)", "8e73b0f7da0e6452c810f32b809079e562f8ead2522c6b7b", "1abc932417521ca24f2b0459fe7e6e0b090339ec0aa6faefd5ccc2c6f4ce8e941e36b26bd1ebc670d1bd1d665620abf74f78a7f6d29809585a97daec58c6b050"],
    ["AES-256 (F.5.5)", "603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4", "601ec313775789a5b7a7f504bbf3d228f443e3ca4d62b59aca84e990cacaf5c52b0930daa23de94ce87017ba2d84988ddfc9c58db67aada613c2dd08457941a6"],
  ])("%s", (_, key, cipher) => {
    const data = plain.slice();
    aesCtr(data, hex(key), counter);
    expect(data).toEqual(hex(cipher));
    aesCtr(data, hex(key), counter);
    expect(data).toEqual(plain);
  });

  test("a partial last block, a range, and a carrying counter", () => {
    const data = plain.slice(0, 20);
    aesCtr(data, hex("2b7e151628aed2a6abf7158809cf4f3c"), counter, 0, 20);
    expect(data).toEqual(hex("874d6191b620e3261bef6864990db6ce9806f66b"));
    const ranged = plain.slice(0, 20);
    aesCtr(ranged, hex("2b7e151628aed2a6abf7158809cf4f3c"), counter, 4, 4);
    expect(ranged.subarray(0, 4)).toEqual(plain.subarray(0, 4));
    expect(ranged.subarray(8)).toEqual(plain.subarray(8, 20));
    // ff…ff + 1 wraps to zero rather than throwing or sticking.
    expect(() => aesCtr(new Uint8Array(48), new Uint8Array(16), new Uint8Array(16).fill(0xff))).not.toThrow();
  });

  test("rejects a bad key or counter length", () => {
    expect(() => aesCtr(new Uint8Array(16), new Uint8Array(15), new Uint8Array(16))).toThrow(RangeError);
    expect(() => aesCtr(new Uint8Array(16), new Uint8Array(16), new Uint8Array(8))).toThrow(RangeError);
  });
});

describe("applyByteTransforms", () => {
  test("xor repeats its key over the range, leaving the rest", () => {
    const out = applyByteTransforms(Uint8Array.from([1, 2, 3, 4, 5, 6]), [{ kind: "xor", key: b64(Uint8Array.from([0xff, 0x0f])), offset: 1, length: 4 }]);
    expect([...out]).toEqual([1, 2 ^ 0xff, 3 ^ 0x0f, 4 ^ 0xff, 5 ^ 0x0f, 6]);
  });

  test("transforms run in order, on a copy", () => {
    const input = Uint8Array.from([10, 20, 30]);
    const key = b64(Uint8Array.from([7]));
    const out = applyByteTransforms(input, [{ kind: "xor", key }, { kind: "xor", key }]);
    expect([...out]).toEqual([10, 20, 30]);
    expect([...input]).toEqual([10, 20, 30]);
  });

  test("aes-ctr decrypts what it encrypts", () => {
    const key = b64(hex("2b7e151628aed2a6abf7158809cf4f3c"));
    const counter = b64(hex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff"));
    const plain = Uint8Array.from({ length: 100 }, (_, i) => i);
    const cipher = applyByteTransforms(plain, [{ kind: "aes-ctr", key, counter }]);
    expect(applyByteTransforms(cipher, [{ kind: "aes-ctr", key, counter }])).toEqual(plain);
  });

  test("a range past the end is clipped; a bad aes key is the bridge's error", () => {
    expect([...applyByteTransforms(Uint8Array.from([1, 2]), [{ kind: "xor", key: "AQ==", offset: 5 }])]).toEqual([1, 2]);
    expect(() => applyByteTransforms(new Uint8Array(4), [{ kind: "aes-ctr", key: "AAAA", counter: b64(new Uint8Array(16)) }])).toThrow(BridgeContractError);
  });
});

describe("imageSize", () => {
  const box = (type: string, body: number[]) => {
    const size = 8 + body.length;
    return [size >>> 24, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...[...type].map((c) => c.charCodeAt(0)), ...body];
  };
  const u32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

  test("png, gif, jpeg, webp", () => {
    expect(imageSize(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, ...u32(1200), ...u32(1800), 0, 0, 0, 0]))).toEqual({ width: 1200, height: 1800, format: "png" });
    expect(imageSize(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x2c, 0x01, 0x90, 0x01, ...new Array(20).fill(0)]))).toEqual({ width: 300, height: 400, format: "gif" });
    // SOI, an APP0 segment to skip, then SOF0 with height 1500, width 1000.
    const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x05, 0xdc, 0x03, 0xe8, 3, 0, 0, 0, 0, 0, 0, 0];
    expect(imageSize(Uint8Array.from(jpeg))).toEqual({ width: 1000, height: 1500, format: "jpeg" });
    const vp8x = [...[..."RIFF"].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...[..."WEBPVP8X"].map((c) => c.charCodeAt(0)), 10, 0, 0, 0, 0, 0, 0, 0, 0xff, 0x07, 0, 0x7f, 0x0c, 0];
    expect(imageSize(Uint8Array.from(vp8x))).toEqual({ width: 2048, height: 3200, format: "webp" });
  });

  test("avif reads ispe inside meta/iprp/ipco", () => {
    const ispe = box("ispe", [0, 0, 0, 0, ...u32(800), ...u32(12000)]);
    const meta = box("meta", [0, 0, 0, 0, ...box("hdlr", [0, 0, 0, 0, 0, 0, 0, 0]), ...box("iprp", box("ipco", ispe))]);
    const avif = [...box("ftyp", [..."avif"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0])), ...meta];
    expect(imageSize(Uint8Array.from(avif))).toEqual({ width: 800, height: 12000, format: "avif" });
  });

  test("not an image, or too short to say", () => {
    expect(imageSize(new TextEncoder().encode("<!DOCTYPE html><html>hello there friend</html>"))).toBeUndefined();
    expect(imageSize(Uint8Array.from([0x89, 0x50]))).toBeUndefined();
  });
});

describe("checkPageImageLayout", () => {
  const op = (src: number[], dst: number[]) => ({
    op: "copy" as const,
    src: { x: src[0]!, y: src[1]!, w: src[2]!, h: src[3]! },
    dst: { x: dst[0]!, y: dst[1]!, w: dst[2]!, h: dst[3]! },
  });
  test("inside both images passes; touching the edge is inside", () => {
    expect(() => checkPageImageLayout({ width: 10, height: 10, ops: [op([5, 5, 5, 5], [0, 0, 10, 10])] }, 10, 10)).not.toThrow();
  });
  test("reading or drawing outside throws", () => {
    expect(() => checkPageImageLayout({ width: 10, height: 10, ops: [op([6, 0, 5, 5], [0, 0, 5, 5])] }, 10, 10)).toThrow(BridgeContractError);
    expect(() => checkPageImageLayout({ width: 10, height: 10, ops: [op([0, 0, 5, 5], [0, 6, 5, 5])] }, 10, 10)).toThrow(BridgeContractError);
  });
});

describe("processPageImage", () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 40, 0, 0, 0, 20, 8, 6, 0, 0, 0]);
  const LAYOUT: PageImageLayout = { width: 40, height: 20, ops: [] };

  test("decodes, then measures the decoded bytes, then lays out", async () => {
    const seen: unknown[] = [];
    const out = await processPageImage({
      info: { id: "b", images: { hosts: ["x"], process: { bytes: true, layout: true } } },
      bridge: {
        decodePageImage: async (req) => (seen.push(req), [{ kind: "xor", key: "Wg==" }]),
        layoutPageImage: async (req) => (seen.push(req), LAYOUT),
      },
      url: "https://x/1",
      bytes: PNG.map((b) => b ^ 0x5a),
      headers: { "X-Seed": "9" },
      context: { k: "v" },
    });
    expect(out).toEqual({ bytes: PNG, layout: LAYOUT, format: "png" });
    expect(seen).toEqual([
      { url: "https://x/1", headers: { "x-seed": "9" }, context: { k: "v" } },
      { url: "https://x/1", headers: { "x-seed": "9" }, context: { k: "v" }, width: 40, height: 20 },
    ]);
  });

  test("runs only what is declared", async () => {
    const out = await processPageImage({
      info: { id: "b", images: { hosts: ["x"] } },
      bridge: { decodePageImage: async () => [{ kind: "xor", key: "AQ==" }], layoutPageImage: async () => LAYOUT },
      url: "https://x/1",
      bytes: PNG,
      headers: {},
      context: {},
    });
    expect(out).toEqual({ bytes: PNG, format: "png" });
  });
});

const IMAGES: BridgeImages = { hosts: ["cdn.example.test"], process: { layout: true } };
const host = (): HostCapabilities => ({
  network: { request: async () => ({ url: "", status: 200, statusText: "OK", headers: {}, body: "" }) },
  storage: {
    get: async () => undefined,
    set: async () => {},
    delete: async () => {},
    keys: async () => [],
    secure: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
  },
  log: { debug() {}, info() {}, warn() {}, error() {} },
  settings: {},
});
const bundle = (images: BridgeImages | undefined, methods: string) => `module.exports = { default: () => ({
  info: ${JSON.stringify({ id: "proc", name: "Proc", version: "0.0.0", contractVersion: "2.1.0", languages: ["en"], nsfw: false, capabilities: [], ...(images ? { images } : {}) })},
  getSeriesDetails: async (id) => ({ id, title: id }),
  getChapters: async () => [],
  getChapterPages: async () => [
    { index: 0, imageUrl: "https://cdn.example.test/0.webp", process: { context: { n: "0" } } },
    { index: 1, imageUrl: "https://cdn.example.test/1.webp" },
  ],
  ${methods}
}) };`;
const LAYOUT_METHOD = `layoutPageImage: async (req) => ({ width: req.width, height: req.height, ops: [] }),`;

describe("loader and image router", () => {
  test("a declared step without its method is refused at load", async () => {
    await expect(loadBridge({ code: bundle(IMAGES, ""), capabilities: host() })).rejects.toThrow(/images.process.layout but no layoutPageImage/);
    await expect(
      loadBridge({ code: bundle({ hosts: ["cdn.example.test"], process: { bytes: true } }, LAYOUT_METHOD), capabilities: host() }),
    ).rejects.toThrow(/images.process.bytes but no decodePageImage/);
  });

  test("marked pages always take the image route, with their context; others stay direct", async () => {
    const b = await loadBridge({ code: bundle(IMAGES, LAYOUT_METHOD), capabilities: host() });
    const pages = await b.getChapterPages!("s", "c");
    expect(pages[0]!.imageUrl).toBe(bridgeImagePath("proc", "https://cdn.example.test/0.webp", { context: { n: "0" } }));
    expect(parseBridgeImagePath(pages[0]!.imageUrl)?.process).toEqual({ context: { n: "0" } });
    expect(pages[0]!.process).toEqual({ context: { n: "0" } });
    expect(pages[1]!.imageUrl).toBe("https://cdn.example.test/1.webp");
  });

  test("the hook is wrapped: its request and its answer are validated", async () => {
    const b = await loadBridge({
      code: bundle(IMAGES, `layoutPageImage: async () => ({ width: 10, height: 10, ops: [{ op: "spin" }] }),`),
      capabilities: host(),
    });
    await expect(b.layoutPageImage!({ url: "u", headers: {}, context: {}, width: 10, height: 10 })).rejects.toThrow();
    await expect(b.layoutPageImage!({ url: "u", headers: {}, context: {}, width: 0, height: 10 } as never)).rejects.toThrow();
  });

  test("an undeclared hook is never exposed, and an undeclared mark is dropped", async () => {
    const b = await loadBridge({ code: bundle({ hosts: ["cdn.example.test"] }, LAYOUT_METHOD), capabilities: host() });
    expect(b.layoutPageImage).toBeUndefined();
    const pages = await b.getChapterPages!("s", "c");
    expect(pages[0]!.process).toBeUndefined();
    expect(pages[0]!.imageUrl).toBe("https://cdn.example.test/0.webp");
    const bare = await loadBridge({ code: bundle(undefined, ""), capabilities: host() });
    expect((await bare.getChapterPages!("s", "c"))[0]!.process).toBeUndefined();
  });
});
