/**
 * File-backed accounts + sessions, in one JSON file at `{dir}/accounts.json`.
 *
 * Durability mirrors `device-store.ts` (which this replaces): a single write lock serialises the
 * read-modify-write, and writes go through tmp+rename so a crash can't truncate the file. Secrets are
 * never stored in the clear — session tokens as fast SHA-256 (they're high-entropy random), passwords
 * as salted **scrypt** (slow, per the low entropy of a human password). A leaked accounts.json hands
 * out nothing usable.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { AccountInfo, AccountProvider, LoginResult, SessionInfo } from "./account-provider.ts";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
/** URL-safe random id/token — safe in a header and a filename. */
const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
/** The single shared account id, matching `isValidAccountId` (base64url is within its charset). */
const newAccount = (): string => randomBytes(16).toString("base64url");

const SCRYPT_KEYLEN = 32;
/** scrypt with node's defaults (N=16384, r=8, p=1) — a sound password KDF, built in, no dep. */
const hashPassword = (password: string, salt: string): string => scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
function passwordMatches(password: string, salt: string, expectedHex: string): boolean {
  const actual = scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(expectedHex, "hex");
  // Constant-time; length guard first since timingSafeEqual throws on a length mismatch.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Usernames become nothing sensitive, but keep them tidy and log/URL-safe. */
const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const isValidUsername = (u: string): boolean => USERNAME_RE.test(u);

interface StoredAccount {
  username: string;
  salt: string;
  passwordHash: string;
  createdAt: number;
}
interface StoredSession {
  id: string;
  username: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt?: number;
}
interface AccountFile {
  /** Stable public identity of this server. */
  serverId: string;
  /** The one shared sync account every session authenticates to (single-library model). */
  account: string;
  accounts: StoredAccount[];
  sessions: StoredSession[];
}

export class FileAccountStore implements AccountProvider {
  private readonly file: string;
  private cache?: AccountFile;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {
    this.file = join(dir, "accounts.json");
  }

  private async load(): Promise<AccountFile> {
    if (this.cache) return this.cache;
    let data: AccountFile;
    try {
      data = JSON.parse(await readFile(this.file, "utf8")) as AccountFile;
      if (!data.serverId) {
        data.serverId = newAccount();
        await this.flush(data);
      }
    } catch {
      // First run: mint identity + the single shared account and PERSIST immediately, so serverId is
      // stable across a restart even before the first account/login (read paths don't flush).
      data = { serverId: newAccount(), account: newAccount(), accounts: [], sessions: [] };
      await this.flush(data);
    }
    this.cache = data;
    return data;
  }

  async serverId(): Promise<string> {
    return (await this.load()).serverId;
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => {});
    return next;
  }

  private async flush(data: AccountFile): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await mkdir(this.dir, { recursive: true });
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, this.file);
  }

  async login(username: string, password: string, deviceName = "device"): Promise<LoginResult | null> {
    return this.withLock(async () => {
      const data = await this.load();
      const acct = data.accounts.find((a) => a.username === username);
      // Unknown user and wrong password fail identically (and both still run scrypt via
      // passwordMatches when the account exists) — don't leak which.
      if (!acct || !passwordMatches(password, acct.salt, acct.passwordHash)) return null;

      const token = randomToken();
      const session: StoredSession = {
        id: randomToken(8),
        username,
        name: deviceName.slice(0, 64),
        tokenHash: sha256(token),
        createdAt: Date.now(),
      };
      data.sessions.push(session);
      await this.flush(data);
      return { token, account: data.account, serverId: data.serverId, sessionId: session.id };
    });
  }

  async verify(token: string): Promise<string | null> {
    const data = await this.load();
    const hash = sha256(token);
    const session = data.sessions.find((s) => s.tokenHash === hash);
    if (!session) return null;
    // Best-effort lastSeenAt; never let a bookkeeping write fail an authenticated request.
    void this.withLock(async () => {
      session.lastSeenAt = Date.now();
      await this.flush(data);
    }).catch(() => {});
    return data.account;
  }

  async list(): Promise<AccountInfo[]> {
    const data = await this.load();
    return data.accounts.map((a) => ({
      username: a.username,
      createdAt: a.createdAt,
      sessions: data.sessions
        .filter((s) => s.username === a.username)
        .map((s): SessionInfo => ({
          id: s.id,
          username: s.username,
          name: s.name,
          createdAt: s.createdAt,
          ...(s.lastSeenAt !== undefined ? { lastSeenAt: s.lastSeenAt } : {}),
        })),
    }));
  }

  async hasAccounts(): Promise<boolean> {
    return (await this.load()).accounts.length > 0;
  }

  async createAccount(username: string, password: string): Promise<boolean> {
    if (!isValidUsername(username) || password.length === 0) return false;
    return this.withLock(async () => {
      const data = await this.load();
      if (data.accounts.some((a) => a.username === username)) return false;
      const salt = randomBytes(16).toString("hex");
      data.accounts.push({ username, salt, passwordHash: hashPassword(password, salt), createdAt: Date.now() });
      await this.flush(data);
      return true;
    });
  }

  async setPassword(username: string, password: string): Promise<boolean> {
    if (password.length === 0) return false;
    return this.withLock(async () => {
      const data = await this.load();
      const acct = data.accounts.find((a) => a.username === username);
      if (!acct) return false;
      acct.salt = randomBytes(16).toString("hex");
      acct.passwordHash = hashPassword(password, acct.salt);
      // A password reset logs the account out everywhere — the safe default for a compromised secret.
      data.sessions = data.sessions.filter((s) => s.username !== username);
      await this.flush(data);
      return true;
    });
  }

  async deleteAccount(username: string): Promise<boolean> {
    return this.withLock(async () => {
      const data = await this.load();
      const before = data.accounts.length;
      data.accounts = data.accounts.filter((a) => a.username !== username);
      if (data.accounts.length === before) return false;
      data.sessions = data.sessions.filter((s) => s.username !== username);
      await this.flush(data);
      return true;
    });
  }

  async revokeSession(id: string): Promise<boolean> {
    return this.withLock(async () => {
      const data = await this.load();
      const before = data.sessions.length;
      data.sessions = data.sessions.filter((s) => s.id !== id);
      if (data.sessions.length === before) return false;
      await this.flush(data);
      return true;
    });
  }

  async revokeSelf(token: string): Promise<boolean> {
    const hash = sha256(token);
    return this.withLock(async () => {
      const data = await this.load();
      const before = data.sessions.length;
      data.sessions = data.sessions.filter((s) => s.tokenHash !== hash);
      if (data.sessions.length === before) return false;
      await this.flush(data);
      return true;
    });
  }
}
