/**
 * `createHost()` — the socket-free assembly `createServer()` wraps. Drives the router in-process
 * through the `fetch(path, init)` seam (what Electron's main process and the tests use), with no
 * `Bun.serve` involved, and checks the optional modules mount only when asked for.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createHost, type ComicalHost } from "../src/host.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");

const open: Array<{ host: ComicalHost; dir: string }> = [];

async function host(opts: Partial<Parameters<typeof createHost>[0]> = {}): Promise<ComicalHost> {
  const dir = await mkdtemp(join(tmpdir(), "comical-host-"));
  const h = createHost({ dataDir: dir, bridgesDir: BRIDGES_DIR, ...opts });
  open.push({ host: h, dir });
  return h;
}

afterEach(async () => {
  for (const { host: h, dir } of open.splice(0)) {
    h.close();
    await rm(dir, { recursive: true, force: true });
  }
});

describe("createHost", () => {
  test("serves the router in-process with no listener", async () => {
    const h = await host();
    const res = await h.fetch("/health");
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);

    const bridges = await h.fetch("/bridges").then((r) => r.json()) as Array<{ info: { id: string } }>;
    expect(bridges.some((b) => b.info.id === "example")).toBe(true);
  });

  test("the optional modules stay unmounted unless enabled", async () => {
    const h = await host();
    expect((await h.fetch("/library/collected")).status).toBe(404);
    expect((await h.fetch("/downloads")).status).toBe(404);
    // Trackers are always mounted (registry-installed trackers need no local dir).
    expect((await h.fetch("/trackers")).status).toBe(200);
  });

  test("library and downloads mount when enabled, under dataDir", async () => {
    const h = await host({ library: true, downloads: true });
    expect((await h.fetch("/library/collected")).status).toBe(200);
    expect((await h.fetch("/downloads")).status).toBe(200);
  });

  test("a token gates the API, an origin narrows CORS", async () => {
    const h = await host({ token: "secret", origin: "http://app.local" });
    expect((await h.fetch("/bridges")).status).toBe(401);
    // Hono's cors middleware only answers with the allow-origin header to a request that carries one.
    const ok = await h.fetch("/bridges", { headers: { authorization: "Bearer secret", origin: "http://app.local" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://app.local");
  });

  test("close() is idempotent and leaves the router usable", async () => {
    const h = await host({ library: true, sync: true, downloads: true });
    h.close();
    h.close();
    expect((await h.fetch("/health")).status).toBe(200);
  });
});
