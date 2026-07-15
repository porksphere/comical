/**
 * `comical accounts …` and `comical sessions …` — manage username/password accounts and their
 * per-device session tokens against a RUNNING host-server.
 *
 * These are HTTP calls to the master-token-guarded admin routes, not direct store access, on purpose:
 * the running server holds accounts.json in memory, so a second process writing the file would be
 * invisible to it (and could be lost under its next write). Everything here goes through the same
 * `/accounts` + `/sessions` endpoints the browser admin console uses.
 */
interface AdminOptions {
  /** Admin endpoint the CLI calls (default http://localhost:<port>). */
  server?: string;
  port?: number;
  token?: string;
}

const bearer = (token?: string) => (token ? { Authorization: `Bearer ${token}` } : {});

async function api(base: string, path: string, init: RequestInit, token?: string): Promise<Response> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...bearer(token), ...(init.headers ?? {}) },
  });
  if (res.status === 401) throw new Error("unauthorized — pass the server's --token (or set COMICAL_TOKEN)");
  if (res.status === 404) throw new Error("not found — is this server running with COMICAL_SYNC=1?");
  return res;
}

interface SessionRow {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt?: number;
}
interface AccountRow {
  username: string;
  createdAt: number;
  sessions: SessionRow[];
}

async function fetchAccounts(base: string, token?: string): Promise<AccountRow[]> {
  return (await (await api(base, "/accounts", { method: "GET" }, token)).json()) as AccountRow[];
}

export async function accountsCommand(sub: string | undefined, positionals: string[], opts: AdminOptions): Promise<number> {
  const port = opts.port ?? 3100;
  const token = opts.token ?? process.env.COMICAL_TOKEN;
  const base = (opts.server ?? `http://localhost:${port}`).replace(/\/$/, "");

  if (sub === "add") {
    const username = positionals[0];
    const password = positionals[1];
    if (!username || !password) {
      console.error("usage: comical accounts add <username> <password> [--server URL] [--token SECRET]");
      return 1;
    }
    const res = await api(base, "/accounts", { method: "POST", body: JSON.stringify({ username, password }) }, token);
    if (res.status === 409) {
      console.error(`account "${username}" already exists`);
      return 1;
    }
    if (res.status === 400) {
      console.error("invalid username or password (usernames: letters, digits, . _ - ; 1–64 chars)");
      return 1;
    }
    console.log(`created account ${username}`);
    return 0;
  }

  if (sub === "list") {
    const accounts = await fetchAccounts(base, token);
    if (accounts.length === 0) {
      console.log("No accounts. Run `comical accounts add <username> <password>`.");
      return 0;
    }
    for (const a of accounts) {
      const count = a.sessions.length;
      console.log(`${a.username.padEnd(20)}  ${count} session${count === 1 ? "" : "s"}  created ${new Date(a.createdAt).toLocaleString()}`);
    }
    return 0;
  }

  if (sub === "passwd") {
    const username = positionals[0];
    const password = positionals[1];
    if (!username || !password) {
      console.error("usage: comical accounts passwd <username> <new-password> [--server URL] [--token SECRET]");
      return 1;
    }
    const res = await api(base, `/accounts/${encodeURIComponent(username)}/password`, { method: "PUT", body: JSON.stringify({ password }) }, token);
    if (res.status === 404) {
      console.error(`no account "${username}"`);
      return 1;
    }
    console.log(`password updated for ${username} — all its sessions were logged out`);
    return 0;
  }

  if (sub === "rm") {
    const username = positionals[0];
    if (!username) {
      console.error("usage: comical accounts rm <username> [--server URL] [--token SECRET]");
      return 1;
    }
    const res = await api(base, `/accounts/${encodeURIComponent(username)}`, { method: "DELETE" }, token);
    if (res.status === 404) {
      console.error(`no account "${username}"`);
      return 1;
    }
    console.log(`deleted account ${username}`);
    return 0;
  }

  console.error("usage: comical accounts <add|list|passwd|rm>");
  return 1;
}

export async function sessionsCommand(sub: string | undefined, positionals: string[], opts: AdminOptions): Promise<number> {
  const port = opts.port ?? 3100;
  const token = opts.token ?? process.env.COMICAL_TOKEN;
  const base = (opts.server ?? `http://localhost:${port}`).replace(/\/$/, "");

  if (sub === "list") {
    const accounts = await fetchAccounts(base, token);
    const rows = accounts.flatMap((a) => a.sessions.map((s) => ({ username: a.username, ...s })));
    if (rows.length === 0) {
      console.log("No active sessions. A session is created when someone logs in from the app or web.");
      return 0;
    }
    for (const s of rows) {
      const seen = s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : "never";
      console.log(`${s.id}  ${s.username.padEnd(16)}  ${s.name.padEnd(20)}  last seen ${seen}`);
    }
    return 0;
  }

  if (sub === "revoke") {
    const id = positionals[0];
    if (!id) {
      console.error("usage: comical sessions revoke <id>   (see `comical sessions list`)");
      return 1;
    }
    const res = await api(base, `/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }, token);
    if (res.status === 404) {
      console.error(`no session with id ${id}`);
      return 1;
    }
    console.log(`revoked session ${id}`);
    return 0;
  }

  console.error("usage: comical sessions <list|revoke>");
  return 1;
}
