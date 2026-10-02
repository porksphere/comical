import { describe, expect, test } from "bun:test";
import { sealedChannel } from "../src/seal.ts";

const SECRET = "abcdefghjkmn";

describe("sealedChannel", () => {
  test("a request opens on the hub and its reply opens on the device", () => {
    const device = sealedChannel(SECRET);
    const hub = sealedChannel(SECRET);
    const { nonce, envelope } = device.sealRequest("/sync/pull", '{"have":{}}');

    const request = hub.openRequest("/sync/pull", envelope);
    expect(request).toEqual({ nonce, body: '{"have":{}}' });

    const reply = hub.sealResponse(request!.nonce, 200, '{"segments":[],"more":false}');
    expect(device.openResponse(nonce, reply)).toEqual({ status: 200, body: '{"segments":[],"more":false}' });
  });

  test("nothing readable leaves the device", () => {
    const { envelope } = sealedChannel(SECRET).sealRequest("/sync/push", '{"device":"phone","seq":1,"records":[]}');
    expect(envelope).not.toContain("phone");
    expect(envelope).not.toContain(SECRET);
    expect(JSON.parse(envelope)).toEqual({ v: 1, n: expect.any(String), c: expect.any(String) });
  });

  test("a different secret opens nothing, either way", () => {
    const device = sealedChannel(SECRET);
    const stranger = sealedChannel("zzzzzzzzzzzz");
    const { nonce, envelope } = device.sealRequest("/sync/pull", "{}");
    expect(stranger.openRequest("/sync/pull", envelope)).toBeNull();
    expect(device.openResponse(nonce, stranger.sealResponse(nonce, 200, "{}"))).toBeNull();
  });

  test("a request is bound to its route and a reply to its request", () => {
    const device = sealedChannel(SECRET);
    const hub = sealedChannel(SECRET);
    const first = device.sealRequest("/sync/pull", "{}");
    expect(hub.openRequest("/sync/push", first.envelope)).toBeNull();

    const reply = hub.sealResponse(first.nonce, 200, "old");
    const second = device.sealRequest("/sync/pull", "{}");
    expect(device.openResponse(second.nonce, reply)).toBeNull();
    expect(device.openResponse(first.nonce, reply)).toEqual({ status: 200, body: "old" });
  });

  test("a message can't be reflected back as the other side's", () => {
    const device = sealedChannel(SECRET);
    const { nonce, envelope } = device.sealRequest("/sync/pull", "{}");
    expect(device.openResponse(nonce, envelope)).toBeNull();
  });

  test("a changed byte is refused", () => {
    const device = sealedChannel(SECRET);
    const hub = sealedChannel(SECRET);
    const { nonce } = device.sealRequest("/sync/pull", "{}");
    const reply = JSON.parse(hub.sealResponse(nonce, 200, "{}")) as { c: string };
    const flipped = reply.c[0] === "A" ? "B" : "A";
    const tampered = JSON.stringify({ ...reply, c: flipped + reply.c.slice(1) });
    expect(device.openResponse(nonce, tampered)).toBeNull();
  });

  test("whatever else a host answers is null, never a throw", () => {
    const device = sealedChannel(SECRET);
    const { nonce } = device.sealRequest("/sync/pull", "{}");
    for (const text of ["", "not found", "<html></html>", "{}", '{"v":2,"n":"","c":""}', '{"v":1,"n":"!!","c":"!!"}', "null"]) {
      expect(device.openResponse(nonce, text)).toBeNull();
      expect(sealedChannel(SECRET).openRequest("/sync/pull", text)).toBeNull();
    }
  });

  test("every nonce is fresh", () => {
    const device = sealedChannel(SECRET);
    const nonces = new Set(Array.from({ length: 50 }, () => device.sealRequest("/sync/pull", "{}").nonce));
    expect(nonces.size).toBe(50);
  });

  test("bodies of every length round-trip through base64", () => {
    const device = sealedChannel(SECRET);
    const hub = sealedChannel(SECRET);
    for (let n = 0; n < 12; n++) {
      const body = "é".repeat(n);
      const { envelope } = device.sealRequest("/p", body);
      expect(hub.openRequest("/p", envelope)?.body).toBe(body);
    }
  });
});
