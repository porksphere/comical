import { describe, expect, test } from "bun:test";
import type { HttpRequest, HttpResponse, NetworkCapability, SettingDescriptor } from "@comical/contract";
import {
  buildRefreshConfigs,
  parseOAuthBlob,
  RefreshableNetwork,
  resolveAccessToken,
} from "../src/net/refreshable-network.ts";

function ok(body: unknown): HttpResponse {
  return { url: "https://x", status: 200, statusText: "OK", headers: {}, body: JSON.stringify(body) };
}
function unauthorized(): HttpResponse {
  return { url: "https://x", status: 401, statusText: "Unauthorized", headers: {}, body: "" };
}

/** A fake NetworkCapability: the refresh endpoint returns `refreshResponse`; any other URL is
 *  answered by `contentResponses` in order (or a 401 once exhausted, so a retry can be observed). */
function mockInner(opts: { refreshUrl: string; refreshResponse: HttpResponse; contentResponses: HttpResponse[] }) {
  const calls: HttpRequest[] = [];
  let contentCallCount = 0;
  const inner: NetworkCapability = {
    async request(req) {
      calls.push(req);
      if (req.url === opts.refreshUrl) return opts.refreshResponse;
      const res = opts.contentResponses[contentCallCount] ?? unauthorized();
      contentCallCount++;
      return res;
    },
  };
  return { inner, calls };
}

describe("parseOAuthBlob / resolveAccessToken", () => {
  test("parses a valid blob", () => {
    expect(parseOAuthBlob(JSON.stringify({ access: "a1", refresh: "r1" }))).toEqual({ access: "a1", refresh: "r1" });
  });
  test("returns undefined for a plain (non-blob) string", () => {
    expect(parseOAuthBlob("plain-token")).toBeUndefined();
  });
  test("returns undefined for non-string values", () => {
    expect(parseOAuthBlob(42)).toBeUndefined();
    expect(parseOAuthBlob(true)).toBeUndefined();
  });
  test("resolveAccessToken unwraps a blob to its access token", () => {
    expect(resolveAccessToken(JSON.stringify({ access: "a1" }))).toBe("a1");
  });
  test("resolveAccessToken passes a plain string through unchanged", () => {
    expect(resolveAccessToken("plain-token")).toBe("plain-token");
  });
});

describe("buildRefreshConfigs", () => {
  test("builds a config for an oauth-pin descriptor with a refreshable stored blob", () => {
    const descriptors: SettingDescriptor[] = [{
      type: "oauth-pin",
      key: "token",
      label: "Account",
      authUrl: "https://x/pin",
      exchange: { url: "https://x/token", clientId: "cid", clientSecret: "csecret", redirectUri: "urn:ietf:wg:oauth:2.0:oob", refreshUrl: "https://x/refresh" },
    }];
    const stored = { token: JSON.stringify({ access: "a1", refresh: "r1" }) };
    const configs = buildRefreshConfigs(descriptors, stored, { token: "a1" });
    expect(configs).toEqual([{ key: "token", currentToken: "a1", refreshToken: "r1", refreshUrl: "https://x/refresh", clientId: "cid", clientSecret: "csecret" }]);
  });

  test("skips a descriptor with no declared refreshUrl", () => {
    const descriptors: SettingDescriptor[] = [{
      type: "oauth-pin", key: "token", label: "Account", authUrl: "https://x/pin",
      exchange: { url: "https://x/token", clientId: "cid", clientSecret: "csecret", redirectUri: "urn:ietf:wg:oauth:2.0:oob" },
    }];
    const stored = { token: JSON.stringify({ access: "a1", refresh: "r1" }) };
    expect(buildRefreshConfigs(descriptors, stored, { token: "a1" })).toEqual([]);
  });

  test("skips when the stored value has no refresh token (e.g. a plain string, not a blob)", () => {
    const descriptors: SettingDescriptor[] = [{
      type: "oauth-pin", key: "token", label: "Account", authUrl: "https://x/pin",
      exchange: { url: "https://x/token", clientId: "cid", clientSecret: "csecret", redirectUri: "urn:ietf:wg:oauth:2.0:oob", refreshUrl: "https://x/refresh" },
    }];
    expect(buildRefreshConfigs(descriptors, { token: "plain-token" }, { token: "plain-token" })).toEqual([]);
  });

  test("oauth-callback resolves clientId via clientIdKey indirection and omits clientSecret", () => {
    const descriptors: SettingDescriptor[] = [{
      type: "oauth-callback", key: "token", label: "Account", authUrlTemplate: "https://x/authorize?client_id={clientId}",
      exchange: { url: "https://x/token", clientIdKey: "clientId", refreshUrl: "https://x/refresh" },
    }];
    const stored = { token: JSON.stringify({ access: "a1", refresh: "r1" }), clientId: "public-id" };
    const settingsForTracker = { token: "a1", clientId: "public-id" };
    const configs = buildRefreshConfigs(descriptors, stored, settingsForTracker);
    expect(configs).toEqual([{ key: "token", currentToken: "a1", refreshToken: "r1", refreshUrl: "https://x/refresh", clientId: "public-id", clientSecret: "" }]);
  });

  test("non-oauth descriptors are skipped", () => {
    const descriptors: SettingDescriptor[] = [{ type: "string", key: "baseUrl", label: "URL" }];
    expect(buildRefreshConfigs(descriptors, { baseUrl: "https://x" }, {})).toEqual([]);
  });
});

describe("RefreshableNetwork", () => {
  test("passes through a non-401 response unchanged, with no refresh attempted", async () => {
    const { inner, calls } = mockInner({ refreshUrl: "https://x/refresh", refreshResponse: ok({}), contentResponses: [ok({ hello: "world" })] });
    const net = new RefreshableNetwork(inner, async () => {});
    net.configure([{ key: "token", currentToken: "a1", refreshToken: "r1", refreshUrl: "https://x/refresh", clientId: "cid", clientSecret: "" }]);
    const res = await net.request({ url: "https://x/content", headers: { Authorization: "Bearer a1" } });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1); // no refresh call made
  });

  test("on 401 with a matching bearer token: refreshes, persists via onRefreshed, and retries with the new token", async () => {
    const { inner, calls } = mockInner({
      refreshUrl: "https://x/refresh",
      refreshResponse: ok({ access_token: "a2", refresh_token: "r2", expires_in: 3600 }),
      contentResponses: [unauthorized(), ok({ hello: "world" })],
    });
    const persisted: { key: string; blob: unknown }[] = [];
    const net = new RefreshableNetwork(inner, async (key, blob) => { persisted.push({ key, blob }); });
    net.configure([{ key: "token", currentToken: "a1", refreshToken: "r1", refreshUrl: "https://x/refresh", clientId: "cid", clientSecret: "secret" }]);

    const res = await net.request({ url: "https://x/content", headers: { Authorization: "Bearer a1" } });

    expect(res.status).toBe(200);
    // 1) the original (401) request, 2) the refresh call, 3) the retried request with the new token
    expect(calls).toHaveLength(3);
    expect(calls[2]?.headers?.["Authorization"]).toBe("Bearer a2");
    expect(persisted).toEqual([{ key: "token", blob: { access: "a2", refresh: "r2", expiresAt: expect.any(Number) } }]);
  });

  test("on 401 with no matching configured token, returns the original 401 with no refresh attempt", async () => {
    const { inner, calls } = mockInner({ refreshUrl: "https://x/refresh", refreshResponse: ok({}), contentResponses: [unauthorized()] });
    const net = new RefreshableNetwork(inner, async () => {});
    net.configure([{ key: "token", currentToken: "different-token", refreshToken: "r1", refreshUrl: "https://x/refresh", clientId: "cid", clientSecret: "" }]);
    const res = await net.request({ url: "https://x/content", headers: { Authorization: "Bearer a1" } });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  test("returns the original 401 when the refresh call itself fails", async () => {
    const { inner } = mockInner({ refreshUrl: "https://x/refresh", refreshResponse: unauthorized(), contentResponses: [unauthorized()] });
    const net = new RefreshableNetwork(inner, async () => {});
    net.configure([{ key: "token", currentToken: "a1", refreshToken: "r1", refreshUrl: "https://x/refresh", clientId: "cid", clientSecret: "" }]);
    const res = await net.request({ url: "https://x/content", headers: { Authorization: "Bearer a1" } });
    expect(res.status).toBe(401);
  });

  test("concurrent 401s for the same token share a single in-flight refresh", async () => {
    let refreshCalls = 0;
    const inner: NetworkCapability = {
      async request(req) {
        if (req.url === "https://x/refresh") {
          refreshCalls++;
          return ok({ access_token: "a2" });
        }
        return unauthorized();
      },
    };
    const net = new RefreshableNetwork(inner, async () => {});
    net.configure([{ key: "token", currentToken: "a1", refreshToken: "r1", refreshUrl: "https://x/refresh", clientId: "cid", clientSecret: "" }]);
    await Promise.all([
      net.request({ url: "https://x/content1", headers: { Authorization: "Bearer a1" } }),
      net.request({ url: "https://x/content2", headers: { Authorization: "Bearer a1" } }),
    ]);
    expect(refreshCalls).toBe(1);
  });
});
