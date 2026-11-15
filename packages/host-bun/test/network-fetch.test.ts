import { expect, test } from "bun:test";
import { createBunHost } from "../src/index.ts";

test("a host can send its bridges' requests through a fetch of its own", async () => {
  const seen: { url: string; ua: string | null }[] = [];
  const custom = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), ua: new Headers(init?.headers).get("user-agent") });
    return new Response("ok", { headers: { "set-cookie": "a=1; Path=/" } });
  }) as typeof fetch;
  const host = createBunHost({ bridgeId: "x", fetch: custom, userAgent: "UA/9" });
  const res = await host.network.request({ url: "https://s.test/p" });
  expect(seen).toEqual([{ url: "https://s.test/p", ua: "UA/9" }]);
  expect(res.body).toBe("ok");
  expect(res.setCookies).toEqual(["a=1; Path=/"]);
});
