/**
 * The embedded transport's synthetic `Response` shape. `resolveAssetSource` (in the app) reads
 * `res.headers.get('Location' | 'Content-Type')` and `res.arrayBuffer()` off whatever the transport
 * returns; the original synthetic response exposed only `json`/`text`, so asset resolution crashed
 * with "Cannot read property 'get' of undefined". These tests pin the members it must expose:
 * `headers` (with a working `get`), `arrayBuffer` (real bytes, uncorrupted), plus `json`/`text`.
 *
 * `/test-sprite.svg` is used as the probe route because the router serves it *directly* in-process
 * (no external `fetch`), returns a non-JSON body, and sets a `Content-Type` — exactly the binary-ish
 * asset shape that must survive the transport.
 */
import { describe, expect, test } from "bun:test";
import { createRouter } from "@comical/host-server/router";
import { createEmbeddedTransport } from "../src/transport.ts";
import type { BridgeProvider, CreateRouter } from "../src/types.ts";

const stubProvider = {
  list: async () => [],
  get: async () => {
    throw new Error("bridge not found");
  },
  missingRequired: async () => [],
  storedSettings: async () => ({}),
  updateSettings: async () => ({}),
  invalidate: () => {},
  refresh: () => {},
} as unknown as BridgeProvider;

const makeTransport = () => createEmbeddedTransport(stubProvider, createRouter as unknown as CreateRouter);

describe("embedded transport — synthetic response shape", () => {
  test("exposes headers.get() for asset resolution", async () => {
    const res = await makeTransport()("/test-sprite.svg");
    expect(res.status).toBe(200);
    // The two headers resolveAssetSource reads. `Location` is absent here (not a redirect) but the
    // call must not throw — that undefined-safe read is the whole point of the fix.
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("Location")).toBeNull();
  });

  test("exposes arrayBuffer() with the real, uncorrupted bytes", async () => {
    const res = await makeTransport()("/test-sprite.svg");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);
    // Same body the router emitted, byte-for-byte (a `.text()` read of binary would mangle it).
    expect(new TextDecoder().decode(bytes)).toContain("<svg");
  });

  test("still serves json()/text() for the API routes", async () => {
    const res = await makeTransport()("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
