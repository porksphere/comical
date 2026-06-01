import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createProxyApp } from "../src/app.ts";

let baseUrl: string;
let stop: () => void;

// A tiny echo backend so we can verify the proxy forwards correctly.
let echoUrl: string;
let echoStop: () => void;

beforeAll(() => {
  const echo = Bun.serve({
    port: 0,
    fetch(req) {
      return new Response(JSON.stringify({ echoed: new URL(req.url).pathname }), {
        headers: { "content-type": "application/json", "x-echo": "yes" },
      });
    },
  });
  echoUrl = `http://localhost:${echo.port}`;
  echoStop = () => echo.stop(true);

  const app = createProxyApp({ env: { COMICAL_PROXY_ORIGIN: "*" }, allowedHosts: new Set(["localhost"]) });
  const srv = Bun.serve({ port: 0, fetch: app.fetch });
  baseUrl = `http://localhost:${srv.port}`;
  stop = () => srv.stop(true);
});

afterAll(() => {
  stop();
  echoStop();
});

describe("proxy", () => {
  test("GET /health returns ok", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.ok).toBe(true);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
  });

  test("forwards a request to the echo backend and returns its response", async () => {
    const res = await fetch(`${baseUrl}/proxy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${echoUrl}/test-path` }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { status: number; body: string; headers: Record<string, string> };
    expect(data.status).toBe(200);
    expect(data.headers["x-echo"]).toBe("yes");
    const body = JSON.parse(data.body) as { echoed: string };
    expect(body.echoed).toBe("/test-path");
  });

  test("returns CORS headers", async () => {
    const res = await fetch(`${baseUrl}/proxy`, {
      method: "POST",
      headers: { "content-type": "application/json", "origin": "https://app.example" },
      body: JSON.stringify({ url: `${echoUrl}/` }),
    });
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });

  test("blocks requests to private/loopback addresses (SSRF guard)", async () => {
    // Use a strict app with no allowedHosts exemptions.
    const strictApp = createProxyApp({ env: { COMICAL_PROXY_ORIGIN: "*" } });
    const strictSrv = Bun.serve({ port: 0, fetch: strictApp.fetch });
    const strictUrl = `http://localhost:${strictSrv.port}`;
    try {
      for (const blocked of ["http://127.0.0.1/secret", "http://localhost/", "http://10.0.0.1/", "http://192.168.1.1/"]) {
        const res = await fetch(`${strictUrl}/proxy`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: blocked }),
        });
        expect(res.status).toBe(403);
      }
    } finally {
      strictSrv.stop(true);
    }
  });

  test("returns 401 when token is required but missing", async () => {
    const app = createProxyApp({ env: { COMICAL_PROXY_TOKEN: "secret123" }, allowedHosts: new Set(["localhost"]) });
    const srv = Bun.serve({ port: 0, fetch: app.fetch });
    const url = `http://localhost:${srv.port}`;
    try {
      const res = await fetch(`${url}/proxy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `${echoUrl}/` }),
      });
      expect(res.status).toBe(401);

      // With correct token it should go through.
      const authRes = await fetch(`${url}/proxy`, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer secret123" },
        body: JSON.stringify({ url: `${echoUrl}/` }),
      });
      expect(authRes.status).toBe(200);
    } finally {
      srv.stop(true);
    }
  });
});
