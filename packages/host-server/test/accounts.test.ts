/**
 * Username/password accounts + per-device session tokens over real HTTP. The properties that matter:
 *   - login trades a valid username+password for a session token (wrong password fails, and repeated
 *     failures are rate-limited to a 429);
 *   - a session token authenticates the WHOLE gated API — /bridges, /library, AND /sync — but never
 *     the admin surface (/accounts, /sessions), which is the master token's alone;
 *   - a session, whatever username it belongs to, reaches the ONE shared account (single-library
 *     model), ignoring any X-Comical-Account header;
 *   - revoke (admin) and self-logout (DELETE /sync/self) both kill a token;
 *   - account CRUD (create/list/reset/delete) is master-token only;
 *   - with no account store, /login and the admin routes do not exist.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SyncRecord } from "@comical/sync";
import { Library } from "@comical/library";
import { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";
import { FileLibraryStore } from "../src/library-store.ts";
import { FileSyncStore } from "../src/sync-store.ts";
import { FileAccountStore } from "../src/account-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-accounts");
const TOKEN = "master-token";

let baseUrl: string;
let stop: () => void;
let accounts: FileAccountStore;

const admin = { Authorization: `Bearer ${TOKEN}` };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

/** Create an account through the admin route (idempotent-ish: 201 new, 409 exists — both fine here). */
async function makeAccount(username: string, password: string): Promise<void> {
  await post("/accounts", { username, password }, admin);
}

/** Log in and return the minted session token + shared account id. */
async function login(username: string, password: string, name = "phone"): Promise<{ token: string; account: string; serverId: string; sessionId: string }> {
  return (await (await post("/login", { username, password, name })).json()) as {
    token: string;
    account: string;
    serverId: string;
    sessionId: string;
  };
}

beforeAll(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  const manager = new BridgeManager({ bridgesDir: BRIDGES_DIR, dataDir: DATA_DIR, settings: new SettingsStore(DATA_DIR) });
  const library = new Library(new FileLibraryStore(join(DATA_DIR, "library")));
  const sync = new FileSyncStore(join(DATA_DIR, "sync"));
  accounts = new FileAccountStore(join(DATA_DIR, "accounts"));
  const srv = Bun.serve({ port: 0, fetch: createRouter(manager, { sync, accounts, library, token: TOKEN }).fetch });
  baseUrl = `http://localhost:${srv.port}`;
  stop = () => srv.stop(true);

  await makeAccount("alice", "correct horse");
  await makeAccount("bob", "battery staple");
});

afterAll(() => {
  stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("login", () => {
  test("valid credentials mint a token + account + serverId + sessionId", async () => {
    const { token, account, serverId, sessionId } = await login("alice", "correct horse");
    expect(token.length).toBeGreaterThan(20);
    expect(account.length).toBeGreaterThan(0);
    expect(serverId.length).toBeGreaterThan(0);
    expect(sessionId.length).toBeGreaterThan(0);
  });

  test("every account on this server logs into the SAME shared account (single-library model)", async () => {
    const a = await login("alice", "correct horse");
    const b = await login("bob", "battery staple");
    expect(a.account).toBe(b.account);
    expect(a.token).not.toBe(b.token); // but distinct session tokens
  });

  test("a wrong password is refused (401), and reveals nothing about which field was wrong", async () => {
    expect((await post("/login", { username: "alice", password: "nope" })).status).toBe(401);
    // Unknown user fails identically to a wrong password.
    expect((await post("/login", { username: "ghost", password: "whatever" })).status).toBe(401);
  });

  test("missing username or password is a 400 (not a 401)", async () => {
    expect((await post("/login", { username: "alice" })).status).toBe(400);
    expect((await post("/login", { password: "x" })).status).toBe(400);
    expect((await post("/login", {})).status).toBe(400);
  });

  test("repeated failures for one user are rate-limited to a 429", async () => {
    const u = "throttled";
    await makeAccount(u, "the-real-password");
    // 8 failures are allowed (each a 401); the 9th within the window is a 429.
    for (let i = 0; i < 8; i++) {
      expect((await post("/login", { username: u, password: "wrong" })).status).toBe(401);
    }
    expect((await post("/login", { username: u, password: "wrong" })).status).toBe(429);
    // Even the RIGHT password is refused while cooling down — the throttle is on the key, not the guess.
    expect((await post("/login", { username: u, password: "the-real-password" })).status).toBe(429);
  });
});

describe("a session token authenticates the whole gated API", () => {
  const entry = (id: string, node = "device-a"): SyncRecord => ({
    table: "entries",
    id,
    env: { kind: "register", hlc: `${"1".padStart(15, "0")}:${"0".repeat(6)}:${node}`, value: { title: id }, deleted: false },
  });

  test("the token reaches /bridges, /library, AND /sync", async () => {
    const { token } = await login("alice", "correct horse");
    const h = { Authorization: `Bearer ${token}` };
    expect((await fetch(`${baseUrl}/bridges`, { headers: h })).status).toBe(200);
    expect((await fetch(`${baseUrl}/library`, { headers: h })).status).toBe(200);
    expect((await post("/sync/push", [entry("bridge:s1")], h)).status).toBe(200);
    const pulled = (await (await fetch(`${baseUrl}/sync/pull`, { headers: h })).json()) as { records: SyncRecord[] };
    expect(pulled.records.map((r) => r.id)).toContain("bridge:s1");
  });

  test("two sessions (even different usernames) see each other's data — one shared account", async () => {
    const a = await login("alice", "correct horse");
    const b = await login("bob", "battery staple");
    await post("/sync/push", [entry("bridge:shared")], { Authorization: `Bearer ${a.token}` });
    const seen = (await (await fetch(`${baseUrl}/sync/pull`, { headers: { Authorization: `Bearer ${b.token}` } })).json()) as { records: SyncRecord[] };
    expect(seen.records.map((r) => r.id)).toContain("bridge:shared");
  });

  test("the account is bound to the token — a forged X-Comical-Account header is IGNORED", async () => {
    const { token } = await login("alice", "correct horse");
    await post("/sync/push", [entry("bridge:mine")], { Authorization: `Bearer ${token}` });
    const res = (await (await fetch(`${baseUrl}/sync/pull`, {
      headers: { Authorization: `Bearer ${token}`, "X-Comical-Account": "someone-elses-account" },
    })).json()) as { records: SyncRecord[] };
    expect(res.records.map((r) => r.id)).toContain("bridge:mine");
  });

  test("a session token does NOT open the admin surface", async () => {
    const { token } = await login("alice", "correct horse");
    const h = { Authorization: `Bearer ${token}` };
    expect((await fetch(`${baseUrl}/accounts`, { headers: h })).status).toBe(401);
    expect((await fetch(`${baseUrl}/sessions/anything`, { method: "DELETE", headers: h })).status).toBe(401);
  });

  test("a made-up token is refused everywhere gated", async () => {
    const h = { Authorization: "Bearer not-a-real-token" };
    expect((await fetch(`${baseUrl}/bridges`, { headers: h })).status).toBe(401);
    expect((await fetch(`${baseUrl}/library`, { headers: h })).status).toBe(401);
    expect((await fetch(`${baseUrl}/sync/pull`, { headers: h })).status).toBe(401);
  });
});

describe("revocation", () => {
  test("admin can list sessions and revoke one — the token dies", async () => {
    const { token, sessionId } = await login("alice", "correct horse", "to-be-revoked");

    const list = (await (await fetch(`${baseUrl}/accounts`, { headers: admin })).json()) as {
      username: string;
      sessions: { id: string; name: string }[];
    }[];
    const alice = list.find((a) => a.username === "alice")!;
    expect(alice.sessions.some((s) => s.id === sessionId && s.name === "to-be-revoked")).toBe(true);
    expect(JSON.stringify(list)).not.toContain(token); // no token/hash leaked

    expect((await fetch(`${baseUrl}/sync/pull`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/sessions/${sessionId}`, { method: "DELETE", headers: admin })).status).toBe(200);
    expect((await fetch(`${baseUrl}/sync/pull`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  test("revoking an unknown session id is a 404", async () => {
    expect((await fetch(`${baseUrl}/sessions/nope`, { method: "DELETE", headers: admin })).status).toBe(404);
  });

  test("DELETE /sync/self revokes only the caller's own session", async () => {
    const a = await login("alice", "correct horse", "self-A");
    const b = await login("alice", "correct horse", "self-B");
    expect((await fetch(`${baseUrl}/sync/self`, { method: "DELETE", headers: { Authorization: `Bearer ${a.token}` } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/sync/pull`, { headers: { Authorization: `Bearer ${a.token}` } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/sync/pull`, { headers: { Authorization: `Bearer ${b.token}` } })).status).toBe(200);
  });

  test("self-disconnect needs a valid token", async () => {
    expect((await fetch(`${baseUrl}/sync/self`, { method: "DELETE" })).status).toBe(401);
    expect((await fetch(`${baseUrl}/sync/self`, { method: "DELETE", headers: { Authorization: "Bearer nope" } })).status).toBe(401);
  });
});

describe("account admin is master-token only", () => {
  test("creating, resetting, and deleting accounts requires the master token", async () => {
    // No token / wrong token → 401.
    expect((await post("/accounts", { username: "x", password: "y" })).status).toBe(401);
    expect((await post("/accounts", { username: "x", password: "y" }, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await fetch(`${baseUrl}/accounts`)).status).toBe(401);

    // With the master token: create (201), duplicate (409), reset password (200), delete (200).
    expect((await post("/accounts", { username: "carol", password: "p1" }, admin)).status).toBe(201);
    expect((await post("/accounts", { username: "carol", password: "p2" }, admin)).status).toBe(409);
    expect((await fetch(`${baseUrl}/accounts/carol/password`, { method: "PUT", headers: { ...admin, "Content-Type": "application/json" }, body: JSON.stringify({ password: "p3" }) })).status).toBe(200);
    expect((await fetch(`${baseUrl}/accounts/carol`, { method: "DELETE", headers: admin })).status).toBe(200);
    // Reset/delete of an unknown account → 404.
    expect((await fetch(`${baseUrl}/accounts/ghost`, { method: "DELETE", headers: admin })).status).toBe(404);
  });

  test("a password reset logs that account out everywhere", async () => {
    await makeAccount("dave", "old-pass");
    const { token } = await login("dave", "old-pass", "dave-device");
    expect((await fetch(`${baseUrl}/bridges`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    // Reset kills existing sessions; the old token no longer authenticates.
    expect((await fetch(`${baseUrl}/accounts/dave/password`, { method: "PUT", headers: { ...admin, "Content-Type": "application/json" }, body: JSON.stringify({ password: "new-pass" }) })).status).toBe(200);
    expect((await fetch(`${baseUrl}/bridges`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    // The new password works for a fresh login.
    expect((await post("/login", { username: "dave", password: "new-pass" })).status).toBe(200);
  });
});

describe("server identity (/health)", () => {
  test("/health advertises the serverId when accounts are on, matching what login returned", async () => {
    const health = (await (await fetch(`${baseUrl}/health`)).json()) as { ok: boolean; sync?: boolean; serverId?: string };
    expect(health.ok).toBe(true);
    expect(health.sync).toBe(true);
    expect(health.serverId).toBeTruthy();
    const { serverId } = await login("alice", "correct horse");
    expect(serverId).toBe(health.serverId!);
  });

  test("/health needs no credential (checkable on a foreign network)", async () => {
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });
});

describe("absence", () => {
  test("without an account store, /login and /accounts do not exist", async () => {
    const manager = new BridgeManager({ bridgesDir: BRIDGES_DIR, dataDir: DATA_DIR, settings: new SettingsStore(DATA_DIR) });
    const sync = new FileSyncStore(join(DATA_DIR, "sync-only"));
    const noAcct = Bun.serve({ port: 0, fetch: createRouter(manager, { sync, token: TOKEN }).fetch });
    try {
      const url = `http://localhost:${noAcct.port}`;
      expect((await fetch(`${url}/login`, { method: "POST", body: "{}" })).status).toBe(404);
      expect((await fetch(`${url}/accounts`, { headers: admin })).status).toBe(404);
      // …but the master-token /sync path still works without an account store.
      expect((await fetch(`${url}/sync/pull`, { headers: { Authorization: `Bearer ${TOKEN}`, "X-Comical-Account": "acct" } })).status).toBe(200);
    } finally {
      noAcct.stop(true);
    }
  });
});

describe("FileAccountStore directly", () => {
  test("a created account verifies with the right password, not the wrong one", async () => {
    const store = new FileAccountStore(join(DATA_DIR, "direct-verify"));
    expect(await store.createAccount("eve", "s3cret")).toBe(true);
    const ok = await store.login("eve", "s3cret");
    expect(ok).not.toBeNull();
    expect(await store.verify(ok!.token)).toBe(ok!.account);
    expect(await store.login("eve", "wrong")).toBeNull();
  });

  test("a duplicate username is rejected, an invalid one too", async () => {
    const store = new FileAccountStore(join(DATA_DIR, "direct-dup"));
    expect(await store.createAccount("frank", "p")).toBe(true);
    expect(await store.createAccount("frank", "p")).toBe(false);
    expect(await store.createAccount("has space", "p")).toBe(false);
    expect(await store.createAccount("ok", "")).toBe(false); // empty password
  });

  test("state survives a reopen — a token verifies against a fresh store instance", async () => {
    const dir = join(DATA_DIR, "direct-persist");
    const store = new FileAccountStore(dir);
    await store.createAccount("grace", "pw");
    const session = await store.login("grace", "pw", "phone");
    expect(session).not.toBeNull();
    const reopened = new FileAccountStore(dir);
    expect(await reopened.verify(session!.token)).toBe(session!.account);
  });

  test("serverId is stable across a reopen even with no accounts (read paths persist it)", async () => {
    const dir = join(DATA_DIR, "direct-serverid");
    const first = await new FileAccountStore(dir).serverId();
    expect(await new FileAccountStore(dir).serverId()).toBe(first);
  });

  test("setPassword revokes existing sessions and changes the accepted password", async () => {
    const store = new FileAccountStore(join(DATA_DIR, "direct-setpw"));
    await store.createAccount("heidi", "old");
    const session = await store.login("heidi", "old");
    expect(await store.verify(session!.token)).not.toBeNull();
    expect(await store.setPassword("heidi", "new")).toBe(true);
    expect(await store.verify(session!.token)).toBeNull(); // old session gone
    expect(await store.login("heidi", "old")).toBeNull(); // old password gone
    expect(await store.login("heidi", "new")).not.toBeNull();
  });
});
