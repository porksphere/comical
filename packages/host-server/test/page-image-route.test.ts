/**
 * `GET /bridges/:id/image` for a page marked `Page.process`: the route fetches the image, applies
 * the bridge's byte transforms, measures it, asks for its layout, and serves the decoded bytes with
 * the layout in `PAGE_LAYOUT_HEADER` — never a redirect, since the bytes must pass through.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bridgeImagePath,
  decodePageLayout,
  PAGE_LAYOUT_HEADER,
  type BridgeImages,
  type PageByteTransform,
  type PageImageDecodeRequest,
  type PageImageLayout,
  type PageImageLayoutRequest,
} from "@comical/contract";
import type { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";

/** The first bytes of a 40 × 20 PNG — enough for its size to be read. */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  0, 0, 0, 40, 0, 0, 0, 20, 8, 6, 0, 0, 0, 0, 0, 0, 0,
]);
const KEY = 0x5a;
const ENCRYPTED = PNG.map((b) => b ^ KEY);

const SWAP: PageImageLayout = {
  width: 40,
  height: 20,
  ops: [
    { op: "copy", src: { x: 20, y: 0, w: 20, h: 20 }, dst: { x: 0, y: 0, w: 20, h: 20 } },
    { op: "copy", src: { x: 0, y: 0, w: 20, h: 20 }, dst: { x: 20, y: 0, w: 20, h: 20 } },
  ],
};

let cdn: ReturnType<typeof Bun.serve>;
let origin: string;

beforeAll(() => {
  cdn = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/plain.png") return new Response(PNG, { headers: { "Content-Type": "image/png" } });
      if (path === "/enc.bin") {
        return new Response(ENCRYPTED, { headers: { "Content-Type": "application/octet-stream", "X-Key": "Wg==" } });
      }
      return new Response("gone", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${cdn.port}`;
});
afterAll(() => cdn.stop(true));

interface MockBridge {
  decodePageImage?: (req: PageImageDecodeRequest) => Promise<PageByteTransform[] | null>;
  layoutPageImage?: (req: PageImageLayoutRequest) => Promise<PageImageLayout | null>;
}

function serve(images: BridgeImages, bridge: MockBridge) {
  const calls: { method: string; req: unknown }[] = [];
  const spy: MockBridge = {};
  if (bridge.decodePageImage) spy.decodePageImage = (req) => (calls.push({ method: "decode", req }), bridge.decodePageImage!(req));
  if (bridge.layoutPageImage) spy.layoutPageImage = (req) => (calls.push({ method: "layout", req }), bridge.layoutPageImage!(req));
  const mgr = {
    list: async () => [
      {
        info: { id: "img", name: "Img", version: "1.0.0", contractVersion: "2.1.0", languages: ["en"], nsfw: false, capabilities: [], images },
        settings: [], configured: true, missingRequired: [], source: "registry" as const,
      },
    ],
    get: async () => spy,
    missingRequired: async () => [],
    storedSettings: async () => ({}),
  } as unknown as BridgeManager;
  const srv = Bun.serve({ port: 0, fetch: createRouter(mgr).fetch });
  return {
    get: (url: string, context?: Record<string, string>) =>
      fetch(`http://localhost:${srv.port}${bridgeImagePath("img", url, context ? { context } : undefined)}`, { redirect: "manual" }),
    calls,
    stop: () => srv.stop(true),
  };
}

const XOR_FROM_HEADER: MockBridge["decodePageImage"] = async (req) =>
  req.headers["x-key"] ? [{ kind: "xor", key: req.headers["x-key"] }] : null;

describe("processed page images", () => {
  test("decodes, measures, lays out, and serves the bytes with the layout", async () => {
    const s = serve(
      { hosts: ["127.0.0.1"], process: { bytes: true, layout: true } },
      { decodePageImage: XOR_FROM_HEADER, layoutPageImage: async () => SWAP },
    );
    try {
      const res = await s.get(`${origin}/enc.bin`, { chapter: "7" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
      expect(decodePageLayout(res.headers.get(PAGE_LAYOUT_HEADER))).toEqual(SWAP);
      expect(s.calls.map((c) => c.method)).toEqual(["decode", "layout"]);
      // The bridge sees the response's headers (lowercased), its context, and the decoded size.
      expect(s.calls[1]!.req).toMatchObject({ url: `${origin}/enc.bin`, width: 40, height: 20, context: { chapter: "7" }, headers: { "x-key": "Wg==" } });
    } finally {
      s.stop();
    }
  });

  test("a page laid out as is gets no layout header", async () => {
    const s = serve({ hosts: ["127.0.0.1"], process: { layout: true } }, { layoutPageImage: async () => null });
    try {
      const res = await s.get(`${origin}/plain.png`, {});
      expect(res.status).toBe(200);
      expect(res.headers.get(PAGE_LAYOUT_HEADER)).toBeNull();
    } finally {
      s.stop();
    }
  });

  test("only declared steps run", async () => {
    const s = serve(
      { hosts: ["127.0.0.1"], process: { layout: true } },
      { decodePageImage: async () => [{ kind: "xor", key: "AQ==" }], layoutPageImage: async () => null },
    );
    try {
      const res = await s.get(`${origin}/plain.png`, {});
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
      expect(s.calls.map((c) => c.method)).toEqual(["layout"]);
    } finally {
      s.stop();
    }
  });

  test("a layout reaching outside the image is refused, not served", async () => {
    const s = serve(
      { hosts: ["127.0.0.1"], process: { layout: true } },
      { layoutPageImage: async () => ({ ...SWAP, ops: [{ op: "copy", src: { x: 30, y: 0, w: 20, h: 20 }, dst: { x: 0, y: 0, w: 20, h: 20 } }] }) },
    );
    try {
      const res = await s.get(`${origin}/plain.png`, {});
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.headers.get(PAGE_LAYOUT_HEADER)).toBeNull();
    } finally {
      s.stop();
    }
  });

  test("an image whose size can't be read can't be laid out", async () => {
    const s = serve({ hosts: ["127.0.0.1"], process: { layout: true } }, { layoutPageImage: async () => SWAP });
    try {
      expect((await s.get(`${origin}/enc.bin`, {})).status).toBeGreaterThanOrEqual(500);
      expect(s.calls).toEqual([]);
    } finally {
      s.stop();
    }
  });

  test("an upstream failure passes through without asking the bridge", async () => {
    const s = serve({ hosts: ["127.0.0.1"], process: { layout: true } }, { layoutPageImage: async () => SWAP });
    try {
      expect((await s.get(`${origin}/missing.png`, {})).status).toBe(404);
      expect(s.calls).toEqual([]);
    } finally {
      s.stop();
    }
  });

  test("without the process mark, or from a bridge that declares no processing, it is an ordinary image", async () => {
    const declared = serve({ hosts: ["127.0.0.1"], process: { layout: true } }, { layoutPageImage: async () => SWAP });
    const undeclared = serve({ hosts: ["127.0.0.1"] }, { layoutPageImage: async () => SWAP });
    try {
      expect((await declared.get(`${origin}/plain.png`)).status).toBe(302);
      expect((await undeclared.get(`${origin}/plain.png`, {})).status).toBe(302);
      expect([...declared.calls, ...undeclared.calls]).toEqual([]);
    } finally {
      declared.stop();
      undeclared.stop();
    }
  });
});
