/**
 * A host can name the platform User-Agent (`HostOptions.userAgent`): bridges get it from
 * `getDefaultUserAgent()`, and a request without a User-Agent of its own sends it.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { createHost } from "../src/host.ts";

const BRIDGE = `module.exports = { default: (host) => ({
  info: { id: "t.ua", name: "UA", version: "1.0.0", contractVersion: "2.1.0", languages: ["en"], nsfw: false, capabilities: [] },
  async getSeriesDetails(id) {
    await host.network.request({ url: "https://s.test/" + id });
    return { id, title: String(host.getDefaultUserAgent && host.getDefaultUserAgent()) };
  },
}) };`;

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

test("the platform User-Agent reaches bridges and their requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comical-ua-"));
  dirs.push(dir);
  await mkdir(join(dir, "bridges", "ua", "dist"), { recursive: true });
  await writeFile(join(dir, "bridges", "ua", "dist", "bridge.js"), BRIDGE);
  const sent: (string | null)[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(new Headers(init?.headers).get("user-agent"));
    return new Response("ok");
  }) as typeof fetch;
  const host = createHost({ dataDir: dir, bridgesDir: join(dir, "bridges"), fetch: fetchImpl, userAgent: "Mozilla/5.0 Platform/1" });
  try {
    const res = await host.fetch("/bridges/t.ua/series/1");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { title: string }).title).toBe("Mozilla/5.0 Platform/1");
    expect(sent).toEqual(["Mozilla/5.0 Platform/1"]);
  } finally {
    host.close();
  }
});
